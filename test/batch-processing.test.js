import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { build } from 'esbuild'
import { RunQueue } from '../src/run-queue.js'
import { ProjectStore } from '../src/project-store.js'
import { ComfyWorkflowStore } from '../src/workflow-store.js'
import { VdNodeRegistry } from '../src/node-registry.js'
import { createDirectorRpc } from '../src/rpc.js'

const bundle = await build({ stdin: { contents: "export * from './controller'; export * from './batch'; export * from './batch-export'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const node = (id, kind, data = {}) => ({ id, type: 'director', position: { x: 0, y: 0 }, data: { kind, title: id, ...data } })
const edge = (source, target, targetHandle = 'in') => ({ id: `${source}-${target}`, source, target, sourceHandle: 'out', targetHandle })
const input = config => node('batch', 'batch-input', { nodeType: 'core.batch-input', batch: { source: 'text', text: 'alpha\nbeta\ngamma', ...config } })
const output = () => node('output', 'batch-output', { nodeType: 'core.batch-output' })
const generate = policy => node('generate', 'image-generation', { providerId: 'test', prompt: 'fallback', seed: 10, seedControlAfterGenerate: policy, fieldInputModes: { prompt: { mode: 'input' } } })

async function fixture(t, nodes, edges, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vd-batch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024); await store.init()
  const workflows = new ComfyWorkflowStore(root); await workflows.init()
  const registry = new VdNodeRegistry(workflows)
  let project = await store.createProject({ name: 'Batch fixture', sessionId: 'session' })
  project = await store.saveProject(project.id, { ...project, graph: { ...project.graph, nodes, edges } }, project.revision)
  const starts = []; const jobs = new Map(); let controller
  const manager = {
    runQueue: new RunQueue(), jobs,
    async start(request) {
      const job = { id: randomUUID(), projectId: project.id, nodeId: request.nodeId, clientRunId: request.clientRunId,
        workflowRunId: request.workflowRunId, batchRunId: request.batchRunId, caseId: request.caseId, caseIndex: request.caseIndex,
        seed: request.seed, runSequence: starts.length + 1, operation: request.operation, providerId: 'test', status: 'queued', phase: 'queued', progress: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      starts.push(structuredClone(request)); jobs.set(job.id, job)
      await options.onStart?.(request, controller)
      return structuredClone(job)
    },
    async get(_projectId, jobId) {
      const job = jobs.get(jobId)
      await options.onGet?.(job)
      if (job.status === 'cancelled') return structuredClone(job)
      if (options.failIndices?.has(job.caseIndex)) return { ...job, status: 'failed', phase: 'failed', error: 'deliberate failure' }
      if (!job.result) {
        const assets = await Promise.all([0, 1].map(i => store.putAsset({ projectId: project.id, kind: 'image', name: `result-${job.caseIndex}-${i}.png`, mimeType: 'image/png', dataBase64: Buffer.from(`image ${job.caseIndex} ${i}`).toString('base64') })))
        Object.assign(job, { status: 'completed', phase: 'completed', completedAt: new Date().toISOString(), result: { kind: 'assets', assets, seed: job.seed, providerId: 'test' } })
      }
      return structuredClone(job)
    },
    async cancel(_projectId, jobId) {
      const job = jobs.get(jobId)
      await options.onCancel?.(job)
      Object.assign(job, { status: 'cancelled', phase: 'cancelled' })
      return structuredClone(job)
    },
  }
  const rpc = createDirectorRpc({ store, workflows, nodes: registry, jobs: manager, registerAsset: async () => {}, providers: { publicCatalog: () => [] } })
  const context = { sessions: { list: { getSnapshot: () => ({ current: 'session', byId: { session: {} } }), subscribe: () => () => {} }, binding: () => ({ session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) } }), open() {} }, connection: { rpc: { call: (_channel, endpoint, payload) => rpc(endpoint, payload) } } }
  controller = new api.DirectorController(context); await controller.start()
  t.after(() => controller.dispose())
  return { controller, store, project, starts, jobs, root, rpc, context }
}

test('batch manifest filters paths, sorts naturally, and selects an inclusive one-based range', async () => {
  const items = ['f10.png', 'nested/f1.png', 'f2.png', 'notes.txt'].map(name => ({ id: name, name, relativePath: name, text: name }))
  const config = { source: 'files', pattern: '\\.png$', recursive: false, sort: 'name', startIndex: 2, endIndex: 2 }
  const matched = await api.matchBatchItems(items, config)
  assert.deepEqual(matched.map(item => item.name), ['f2.png', 'f10.png'])
  assert.deepEqual(api.batchRange(config, matched.length), { start: 2, end: 2 })
  for (const range of [{ startIndex: 0 }, { startIndex: 2, endIndex: 1 }, { endIndex: 3 }, { endIndex: 1.5 }]) assert.throws(() => api.batchRange(range, 2), /inclusive range/)
  await assert.rejects(api.matchBatchItems(items, { pattern: '[' }), /regular expression/i)
  assert.deepEqual(api.batchSourceItems({ source: 'text', text: ' first \n\nsecond\r\n' }).map(item => item.text), [' first ', 'second'])
})

for (const [policy, expected, next] of [['fixed', [10, 10], 10], ['increment', [10, 11], 12], ['decrement', [10, 9], 8]]) {
  test(`batch ${policy} seeds, per-case runs and multiple outputs stay aligned`, async t => {
    const { controller, starts, store, project } = await fixture(t, [input({ startIndex: 2, endIndex: 3 }), generate(policy), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')])
    const id = await controller.runBatch('batch')
    assert.deepEqual(starts.map(request => request.prompt), ['beta', 'gamma'])
    assert.deepEqual(starts.map(request => request.seed), expected)
    assert.deepEqual(starts.map(request => request.caseIndex), [2, 3])
    assert.equal(new Set(starts.map(request => request.workflowRunId)).size, 2)
    assert.ok(starts.every(request => request.batchRunId === id && request.batchIndex === undefined))
    const rows = await store.listBatchCases(project.id, id)
    assert.deepEqual(rows.map(row => [row.caseIndex, row.status, row.artifacts.length]), [[2, 'completed', 2], [3, 'completed', 2]])
    assert.deepEqual(rows.map(row => row.artifacts[0].seed), expected)
    assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.seed, next)
    assert.equal(controller.getSnapshot().project.graph.nodes.filter(node => node.data.kind === 'preview').length, 0)
    assert.equal((await store.getVdRun(project.id, id)).completedCases, 2)
  })
}

test('a batch snapshot ignores mid-run input edits and never overwrites a newer editable seed', async t => {
  const { controller, starts } = await fixture(t, [input({ endIndex: 2 }), generate('increment'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], {
    onStart(request, controller) {
      if (request.caseIndex !== 1) return
      controller.updateNode('batch', { batch: { source: 'text', text: 'edited' } })
      controller.updateNode('generate', { seed: 99, prompt: 'edited prompt' })
    },
  })
  await controller.runBatch('batch')
  assert.deepEqual(starts.map(request => [request.prompt, request.seed]), [['alpha', 10], ['beta', 11]])
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.seed, 99)
})

test('FROZEN results are reused across indices without jobs or seed changes; empty frozen nodes fail preflight', async t => {
  const cached = node('cached', 'prompt-enhancer', { frozen: true, seed: 10, seedControlAfterGenerate: 'increment', text: 'cached result', result: { kind: 'text', text: 'cached result', providerId: 'test' } })
  const { controller, starts, store, project } = await fixture(t, [input({}), cached, output()], [edge('batch', 'cached'), edge('cached', 'output')])
  const id = await controller.runBatch('batch')
  assert.equal(starts.length, 0)
  assert.deepEqual((await store.listBatchCases(project.id, id)).map(row => [row.caseIndex, row.artifacts[0].text, row.artifacts[0].reused]), [[1, 'cached result', true], [2, 'cached result', true], [3, 'cached result', true]])
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'cached').data.seed, 10)
  controller.updateNode('cached', { text: undefined, result: undefined })
  await assert.rejects(controller.runBatch('batch'), /Frozen node has no reusable result/)
  controller.setNodeFrozen('batch', true)
  await assert.rejects(controller.runBatch('batch'), /unfrozen Batch Input/)
})

test('failed-case retry keeps random seeds and inputs and skips completed cases', async t => {
  const failIndices = new Set([2])
  const { controller, starts, store, project } = await fixture(t, [input({}), generate('randomize'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], { failIndices })
  await assert.rejects(controller.runBatch('batch'), /deliberate failure/)
  const run = controller.getSnapshot().workflowRuns.find(run => run.kind === 'batch')
  const failed = await store.listBatchCases(project.id, run.id)
  assert.deepEqual(failed.map(row => row.status), ['completed', 'failed', 'pending'])
  assert.ok(starts.every(request => Number.isSafeInteger(request.seed)))
  failIndices.clear()
  controller.updateNode('batch', { batch: { source: 'text', text: 'different inputs' } })
  await controller.runBatch('batch', run.id)
  assert.deepEqual(starts.map(request => request.caseIndex), [1, 2, 2, 3])
  assert.equal(starts[1].seed, starts[2].seed)
  assert.equal(starts[1].caseId, starts[2].caseId)
  assert.notEqual(starts[1].workflowRunId, starts[2].workflowRunId)
  assert.deepEqual(starts.map(request => request.prompt), ['alpha', 'beta', 'beta', 'gamma'])
  assert.deepEqual((await store.listBatchCases(project.id, run.id)).map(row => row.status), ['completed', 'completed', 'completed'])
})

test('Continue preserves a failed output row and cannot leak previous case artifacts', async t => {
  const { controller, store, project } = await fixture(t, [input({ errorPolicy: 'continue' }), generate('increment'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], { failIndices: new Set([2]) })
  const id = await controller.runBatch('batch')
  const rows = await store.listBatchCases(project.id, id)
  assert.deepEqual(rows.map(row => [row.caseIndex, row.status, row.artifacts.length]), [[1, 'completed', 2], [2, 'failed', 0], [3, 'completed', 2]])
  assert.equal((await store.getVdRun(project.id, id)).status, 'failed')
  assert.equal((await store.getVdRun(project.id, id)).failedCases, 1)
})

test('batch input → output supports more than 100 persisted cases and survives history pruning', async t => {
  const { controller, store, project } = await fixture(t, [input({ text: Array.from({ length: 105 }, () => 'same text').join('\n') }), output()], [edge('batch', 'output')])
  const id = await controller.runVdWorkflow({ mode: 'all' })
  const rows = await store.listBatchCases(project.id, id)
  assert.equal(rows.length, 105)
  assert.equal(new Set(rows.map(row => row.caseId)).size, 105)
  assert.ok(rows.every(row => row.status === 'completed' && row.artifacts[0].text === 'same text'))
  await store.updateProject(project.id, { jobs: [] })
  assert.equal((await store.listBatchCases(project.id, id)).length, 105)
  const reopened = new ProjectStore(store.root, 1024 * 1024); await reopened.init()
  assert.equal((await reopened.listBatchCases(project.id, id))[104].artifacts[0].text, 'same text')
  await assert.rejects(store.saveBatchCase(project.id, id, { ...rows[0], seeds: { forged: 2 } }), /immutable/)
  await assert.rejects(store.saveBatchCase(project.id, id, { ...rows[0], artifacts: [] }), /immutable/)
})

test('export archive preserves case paths and a manifest even when a case has no outputs', async t => {
  const { controller, store, project, root } = await fixture(t, [input({ text: '../same\n../same' }), output()], [edge('batch', 'output')])
  const id = await controller.runBatch('batch')
  const rows = await store.listBatchCases(project.id, id)
  rows[1].artifacts = []; rows[1].status = 'failed'; rows[1].error = 'failed case'
  const archive = await api.batchArchive(rows, 'output')
  const path = join(root, 'outputs.tar'); await writeFile(path, Buffer.from(await archive.arrayBuffer()))
  const names = execFileSync('tar', ['-tf', path], { encoding: 'utf8' }).trim().split('\n')
  assert.equal(names.length, 2)
  assert.match(names[0], /\/0001_Text_1\/batch_media_1.txt$/)
  assert.ok(names.every(name => !name.split('/').includes('..')))
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, `${id}/manifest.json`], { encoding: 'utf8' }))
  assert.equal(manifest.cases[1].caseIndex, 2)
  assert.equal(manifest.cases[1].error, 'failed case')
})

async function until(check, timeout = 3000) {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for batch state'); await new Promise(resolve => setTimeout(resolve, 2)) }
}

test('cancelling a batch waits for its child remote cleanup and never starts the next case', async t => {
  let confirmCleanup; let finishPoll; let cancelRequested = false
  const cleanup = new Promise(resolve => { confirmCleanup = resolve })
  const poll = new Promise(resolve => { finishPoll = resolve })
  const { controller, starts, store, project } = await fixture(t, [input({}), generate('increment'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], {
    onGet: () => poll,
    onCancel: async () => { cancelRequested = true; await cleanup; finishPoll() },
  })
  const running = controller.runBatch('batch')
  const outcome = running.then(() => 'completed', () => 'cancelled')
  await until(() => starts.length === 1)
  const parent = controller.getSnapshot().workflowRuns.find(run => run.kind === 'batch')
  const cancelling = controller.cancelVdRun(parent.id)
  await until(() => cancelRequested)
  assert.equal(starts.length, 1)
  assert.equal(controller.getSnapshot().workflowRuns.find(run => run.id === parent.id).status, 'running')
  confirmCleanup(); await cancelling
  assert.equal(await outcome, 'cancelled')
  assert.equal(starts.length, 1)
  const rows = await store.listBatchCases(project.id, parent.id)
  assert.deepEqual(rows.map(row => row.status), ['cancelled', 'pending', 'pending'])
})

test('freezing Batch Output captures its displayed case while later results remain in history', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve })
  const { controller, starts, store, project } = await fixture(t, [input({ endIndex: 2 }), generate('fixed'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], {
    onGet: job => job.caseIndex === 2 ? blocked : undefined,
  })
  const running = controller.runBatch('batch')
  await until(() => starts.length === 2)
  // Select the completed first case, then freeze exactly that view.
  controller.updateNode('output', { batchFollow: false, batchCaseIndex: 1 })
  controller.setNodeFrozen('output', true)
  const held = structuredClone(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'output').data.batchFrozenCase)
  assert.equal(held.caseIndex, 1)
  release()
  const id = await running
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'output').data.batchFrozenCase, held)
  assert.equal((await store.listBatchCases(project.id, id))[1].artifacts.length, 2)
})

test('directory regex excludes files before upload, preserves relative paths and rejects an incompatible range before jobs', async t => {
  const { controller, starts } = await fixture(t, [input({ source: 'files', pattern: '\\.txt$', recursive: false }), output()], [edge('batch', 'output')])
  const file = (name, content, path) => Object.assign(new File([content], name, { type: 'text/plain' }), { webkitRelativePath: path })
  await controller.importBatchFiles('batch', [file('2.txt', 'two', 'root/2.txt'), file('10.txt', 'ten', 'root/10.txt'), file('1.txt', 'nested', 'root/sub/1.txt'), file('notes.md', 'excluded', 'root/notes.md')], true)
  const config = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'batch').data.batch
  assert.deepEqual(config.items.map(item => item.relativePath), ['2.txt', '10.txt'])
  const id = await controller.runBatch('batch')
  assert.deepEqual(controller.getSnapshot().batchCases[id].map(row => row.artifacts[0].text), ['two', 'ten'])
  assert.equal(starts.length, 0)
})

test('seed boundaries fail preflight and concurrent clicks do not enqueue duplicate batches', async t => {
  const { controller, starts } = await fixture(t, [input({}), { ...generate('decrement'), data: { ...generate('decrement').data, seed: 0 } }, output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')])
  await assert.rejects(controller.runBatch('batch'), /seed is outside/)
  assert.equal(starts.length, 0)
  controller.updateNode('generate', { seed: 10 })
  const results = await Promise.allSettled([controller.runBatch('batch'), controller.runBatch('batch')])
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(starts.length, 3)
})

test('increment retry advances the editor only after the retried case succeeds', async t => {
  const failIndices = new Set([2])
  const { controller } = await fixture(t, [input({}), generate('increment'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], { failIndices })
  await assert.rejects(controller.runBatch('batch'), /deliberate/)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.seed, 11)
  const id = controller.getSnapshot().workflowRuns.find(run => run.kind === 'batch').id
  failIndices.clear()
  await controller.runBatch('batch', id)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.seed, 13)
})

test('Host jobs persist case metadata and reject mismatched child-run identities', async t => {
  const { JobManager } = await import('../src/jobs.js')
  const { controller, store, project } = await fixture(t, [input({ text: 'one' }), output()], [edge('batch', 'output')])
  const id = await controller.runBatch('batch')
  const [row] = await store.listBatchCases(project.id, id)
  const manager = new JobManager(store, { run: async () => ({ kind: 'text', text: 'done', providerId: 'test' }) })
  const request = { projectId: project.id, nodeId: 'transient', providerId: 'test', operation: 'prompt-enhancer', prompt: 'test',
    workflowRunId: row.workflowRunId, batchRunId: id, caseId: row.caseId, caseIndex: row.caseIndex }
  await assert.rejects(manager.start({ ...request, caseIndex: 2 }, { allowTransientNode: true }), /does not match/)
  const job = await manager.start(request, { allowTransientNode: true })
  await until(() => manager.running === 0)
  const saved = await manager.get(project.id, job.id)
  assert.equal(saved.batchRunId, id)
  assert.equal(saved.caseId, row.caseId)
  assert.equal(saved.caseIndex, 1)
})

test('an uncertain job submission stops even Continue batches and cannot be retried automatically', async t => {
  const { controller, store, project, starts } = await fixture(t, [input({ errorPolicy: 'continue' }), generate('randomize'), output()], [edge('batch', 'generate', 'in:field:prompt'), edge('generate', 'output')], {
    onStart() { throw new Error('The connection disappeared after acceptance') },
  })
  await assert.rejects(controller.runBatch('batch'), /Submission receipt is uncertain/)
  const run = controller.getSnapshot().workflowRuns.find(run => run.kind === 'batch')
  const rows = await store.listBatchCases(project.id, run.id)
  assert.equal(rows[0].uncertain, true)
  assert.equal(rows[1].status, 'pending')
  assert.equal(starts.length, 1)
  await assert.rejects(controller.runBatch('batch', run.id), /uncertain submission/)
  await assert.rejects(store.saveBatchCase(project.id, run.id, { ...rows[0], attempt: 2, status: 'running', workflowRunId: randomUUID(), uncertain: false }), /cannot be retried/)
})

test('local Preview chains resolve the current case even without executable stages', async t => {
  const { controller, store, project } = await fixture(t, [input({ text: 'first\nsecond' }), node('preview', 'preview', { nodeType: 'core.preview', text: 'stale' }), output()], [edge('batch', 'preview'), edge('preview', 'output')])
  const id = await controller.runBatch('batch')
  assert.deepEqual((await store.listBatchCases(project.id, id)).map(row => row.artifacts[0].text), ['first', 'second'])
})

test('empty frozen Preview dependencies fail before any case is submitted', async t => {
  const { controller, starts } = await fixture(t, [input({}), node('preview', 'preview', { nodeType: 'core.preview', frozen: true }), generate('fixed'), output()], [edge('batch', 'preview'), edge('preview', 'generate', 'in:field:prompt'), edge('generate', 'output')])
  await assert.rejects(controller.runBatch('batch'), /Frozen node has no reusable result: preview/)
  assert.equal(starts.length, 0)
})

test('cancelling a restored batch closes its active child summaries', async t => {
  const { controller, store, project, context } = await fixture(t, [input({ text: 'one' }), output()], [edge('batch', 'output')])
  const id = await controller.runBatch('batch')
  const runs = await store.listVdRuns(project.id)
  for (const run of runs) await store.saveVdRun(project.id, { ...run, status: 'running', completedAt: undefined })
  controller.dispose()
  const reopened = new api.DirectorController(context)
  t.after(() => reopened.dispose())
  await reopened.start()
  await reopened.cancelVdRun(id)
  assert.ok((await store.listVdRuns(project.id)).every(run => run.status === 'cancelled'))
})
