import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'
import { ProjectStore } from '../src/project-store.js'
import { JobManager } from '../src/jobs.js'
import { createDirectorRpc } from '../src/rpc.js'

const bundle = await build({ entryPoints: ['src/client/controller.ts'], bundle: true, format: 'esm', platform: 'browser', write: false })
const { DirectorController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=global-workflow-controller.js').toString('base64')}`)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-global-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  const projects = []
  for (const name of ['A', 'B']) {
    const project = await store.createProject({ name, sessionId: name })
    projects.push(await store.updateProject(project.id, { graph: { ...project.graph,
      nodes: ['first', 'second'].map(id => ({ id, type: 'director', position: { x: 0, y: 0 },
        data: { kind: 'prompt-enhancer', title: id, prompt: `${name}-${id}`, providerId: 'test', status: 'idle' } })),
      edges: [{ id: 'dependency', source: 'first', target: 'second' }],
    } }))
  }
  const calls = []
  const providers = { publicCatalog: () => [], run: async request => {
    calls.push(`${request.projectId}:${request.nodeId}`)
    return { kind: 'text', text: 'result', providerId: 'test' }
  } }
  const jobs = new JobManager(store, providers, { concurrency: 2 })
  const rpc = createDirectorRpc({ store, jobs, providers, workflows: { list: () => [] }, registerAsset: async () => {} })
  const call = async (endpoint, input) => {
    const result = await rpc(endpoint, input)
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
    return result.value
  }
  return { store, projects, calls, providers, jobs, rpc, call }
}

async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Condition did not become true')
}

function client(t, rpc, current = 'A') {
  const controller = new DirectorController({ sessions: {
    list: { getSnapshot: () => ({ current, byId: { A: {}, B: {} }, ids: ['A', 'B'] }) },
    binding: () => ({}), open: () => {},
  }, connection: { rpc: { call: (_, endpoint, input) => rpc(endpoint, input) } } })
  t.after(() => controller.dispose())
  return controller
}

test('the Host finishes dependent workflows after all submitting browser connections disappear', async t => {
  const { projects: [a, b], providers, calls, rpc, call } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = providers.run
  providers.run = async request => { if (request.projectId === a.id && request.nodeId === 'first') await gate; return run(request) }
  let connected = true
  const transport = (...args) => {
    if (!connected) return Promise.reject(new Error('Browser tab is suspended'))
    return rpc(...args)
  }
  const tabA = client(t, transport, 'A'), tabB = client(t, transport, 'B')
  await Promise.all([tabA.start(), tabB.start()])
  void tabA.runVdWorkflow({ mode: 'all' }).catch(() => {})
  await until(async () => (await call('jobs/list', {})).jobs.length === 1)
  void tabB.runVdWorkflow({ mode: 'all' }).catch(() => {})
  await until(async () => (await call('vd-runs/list', {})).runs.length === 2)
  connected = false
  release()
  // No browser RPC can advance a stage, poll a job, or save run completion.
  await until(async () => (await call('vd-runs/list', {})).runs.every(run => run.status === 'completed'))
  assert.deepEqual(calls, [`${a.id}:first`, `${a.id}:second`, `${b.id}:first`, `${b.id}:second`])
})

test('two clients queue entire workflows globally, retaining the slot between dependency stages', async t => {
  const { projects: [a, b], calls, jobs, call, store } = await fixture(t)
  const run = project => ({ id: randomUUID(), projectId: project.id, status: 'queued', mode: 'all',
    batchSize: 1, completedJobs: 0, totalJobs: 2, nodeIds: ['first', 'second'], startedAt: new Date().toISOString() })
  const first = run(a), second = run(b)
  for (const [project, summary] of [[a, first], [b, second]]) {
    jobs.runQueue.register(await store.saveVdRun(project.id, summary, project))
  }
  const start = (project, summary, nodeId) => jobs.start({ projectId: project.id, nodeId,
    operation: 'prompt-enhancer', providerId: 'test', workflowRunId: summary.id })
  const a1 = await start(a, first, 'first')
  await until(async () => (await jobs.get(a.id, a1.id)).status === 'completed')
  const b1 = await start(b, second, 'first')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await jobs.get(b.id, b1.id)).status, 'queued', 'another browser must wait through dependency gaps')
  const a2 = await start(a, first, 'second')
  await until(async () => (await jobs.get(a.id, a2.id)).status === 'completed')
  jobs.runQueue.register(await store.saveVdRun(a.id, { ...first, status: 'completed', completedJobs: 2 }))
  await until(async () => (await jobs.get(b.id, b1.id)).status === 'completed')
  assert.deepEqual(calls, [`${a.id}:first`, `${a.id}:second`, `${b.id}:first`])
})

test('switching and renaming during a run preserves its remaining stages and isolates identical node IDs', async t => {
  const { projects: [a, b], providers, calls, rpc, call } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = providers.run
  providers.run = async request => { if (request.nodeId === 'first') await gate; return run(request) }
  const controller = new DirectorController({ sessions: {
    list: { getSnapshot: () => ({ current: 'A', byId: { A: {}, B: {} }, ids: ['A', 'B'] }) },
    binding: () => ({}), open: () => {},
  }, connection: { rpc: { call: (_, endpoint, input) => rpc(endpoint, input) } } })
  t.after(() => controller.dispose())
  await controller.start()
  const running = controller.runVdWorkflow({ mode: 'all' })
  // Attach immediately so a failed assertion cannot cause an unhandled rejection.
  running.catch(() => {})
  await until(() => controller.getSnapshot().project.jobs.length > 0)
  try {
    await controller.selectProject(b.id)
    await controller.renameProjectById(b.id, 'Renamed B')
    assert.equal(controller.getSnapshot().project.name, 'Renamed B')
  } finally { release() }
  await running
  assert.deepEqual(calls, [`${a.id}:first`, `${a.id}:second`])
  assert.equal(controller.getSnapshot().project.id, b.id)
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, undefined)
  const { jobs } = await call('jobs/list', {})
  assert.equal(jobs.length, 2)
})

test('consecutive direct jobs share concurrency without overtaking another workflow', async t => {
  const { projects: [a, b], providers, jobs } = await fixture(t)
  const pending = new Map()
  providers.run = request => new Promise(resolve => pending.set(request.prompt, () => resolve({ kind: 'text', text: request.prompt })))
  const start = (project, prompt) => jobs.start({ projectId: project.id, nodeId: 'first',
    operation: 'text-generation', providerId: 'test', prompt })
  const a1 = await start(a, 'a1'), a2 = await start(a, 'a2')
  const b1 = await start(b, 'b1'), a3 = await start(a, 'a3')
  await until(() => pending.size === 2)
  // Both jobs share the available slots; asynchronous persistence may finish in either order.
  assert.deepEqual(new Set(pending.keys()), new Set(['a1', 'a2']))
  pending.get('a2')()
  await until(async () => (await jobs.get(a.id, a2.id)).status === 'completed')
  assert.equal((await jobs.get(b.id, b1.id)).status, 'queued')
  pending.get('a1')()
  await until(() => pending.has('b1'))
  assert.equal((await jobs.get(a.id, a3.id)).status, 'queued')
  pending.get('b1')()
  await until(() => pending.has('a3'))
  pending.get('a3')()
  await until(async () => (await jobs.get(a.id, a3.id)).status === 'completed')
  assert.equal((await jobs.get(a.id, a1.id)).status, 'completed')
})

test('cross-client cancellation retains the global slot until provider cleanup finishes', async t => {
  const { projects: [a, b], jobs, providers, call, store } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  providers.run = async request => { if (request.projectId === a.id) await gate; return { kind: 'text', text: 'done' } }
  const summary = project => ({ id: randomUUID(), projectId: project.id, status: 'queued', mode: 'all',
    batchSize: 1, completedJobs: 0, totalJobs: 1, nodeIds: ['first'], startedAt: new Date().toISOString() })
  const first = summary(a), second = summary(b)
  const start = (project, run) => jobs.start({ projectId: project.id, nodeId: 'first',
    workflowRunId: run.id, operation: 'text-generation', providerId: 'test' })
  for (const [project, run] of [[a, first], [b, second]]) jobs.runQueue.register(await store.saveVdRun(project.id, run, project))
  const a1 = await start(a, first), b1 = await start(b, second)
  try {
    await call('vd-runs/cancel', { projectId: a.id, runId: first.id })
    assert.equal((await call('vd-runs/turn', { projectId: b.id, runId: second.id })).granted, false)
    assert.equal((await jobs.get(b.id, b1.id)).status, 'queued')
  } finally { release() }
  await until(async () => (await jobs.get(a.id, a1.id)).status === 'cancelled')
  await until(async () => (await jobs.get(b.id, b1.id)).status === 'completed')
  assert.equal((await call('vd-runs/get', { projectId: a.id, runId: first.id })).run.status, 'cancelled')
  assert.equal((await call('jobs/list', { projectId: b.id })).jobs.length, 1)
})

test('two browser controllers run dependent stages in global submission order', async t => {
  const { projects: [a, b], rpc, providers, calls, call } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = providers.run
  providers.run = async request => { if (request.projectId === a.id) await gate; return run(request) }
  const tabA = client(t, rpc, 'A'), tabB = client(t, rpc, 'B')
  await Promise.all([tabA.start(), tabB.start()])
  const first = tabA.runVdWorkflow({ mode: 'all' })
  first.catch(() => {})
  await until(async () => (await call('jobs/list', {})).jobs.length === 1)
  const second = tabB.runVdWorkflow({ mode: 'all' })
  second.catch(() => {})
  try {
    await until(async () => (await call('vd-runs/list', {})).runs.length === 2)
    await tabB.refreshVdRuns()
    assert.equal(tabB.getSnapshot().workflowRuns.length, 2)
    assert.equal(tabB.getSnapshot().jobs[0].projectId, a.id)
    assert.equal((await call('jobs/list', { projectId: b.id })).jobs.length, 0)
  } finally { release() }
  await Promise.all([first, second])
  assert.deepEqual(calls, [`${a.id}:first`, `${a.id}:second`, `${b.id}:first`, `${b.id}:second`])
})

test('a pending direct submission reaches the Host before later workflow reservations', async t => {
  const { rpc, calls, projects: [a, b] } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let pending = true
  const controller = client(t, async (endpoint, input) => {
    if (endpoint === 'jobs/start' && pending) { pending = false; await gate }
    return rpc(endpoint, input)
  })
  await controller.start()
  const direct = controller.runNode('first')
  const first = controller.runVdWorkflow({ mode: 'all' })
  first.catch(() => {})
  try { await controller.selectProject(b.id) } finally { release() }
  const second = controller.runVdWorkflow({ mode: 'all' })
  await Promise.all([direct, first, second])
  assert.deepEqual(calls, [`${a.id}:first`, `${a.id}:first`, `${a.id}:second`, `${b.id}:first`, `${b.id}:second`])
})

test('Run N is N durable independent runs, idempotent on retry, and survives client disposal', async t => {
  const { projects: [a], call, jobs, store, providers, calls, rpc } = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const execute = providers.run
  const seeds = []
  providers.run = async request => { seeds.push(request.seed); await gate; return execute(request) }
  const clientA = client(t, rpc)
  await clientA.start()
  clientA.updateNode('first', { seed: 100, seedControlAfterGenerate: 'fixed' })
  const observing = clientA.runVdWorkflow({ mode: 'all', batchSize: 3 })
  observing.catch(() => {})
  await until(async () => (await call('vd-runs/list', {})).runs.length === 3)
  const queued = (await call('vd-runs/list', {})).runs
  assert.ok(queued.every(run => run.batchSize === 1 && run.totalJobs === 2 && run.scheduler === 'host'))
  assert.equal(new Set(queued.map(run => run.id)).size, 3)
  for (const run of queued) assert.equal((await store.getVdRun(a.id, run.id)).snapshot.graph.nodes[0].data.seed, 100)
  clientA.dispose()
  release()
  await until(async () => (await call('vd-runs/list', {})).runs.every(run => run.status === 'completed'))
  assert.equal(calls.length, 6)
  assert.deepEqual(seeds.filter(seed => seed !== undefined), [100, 101, 102])
  const recorded = (await call('jobs/list', {})).jobs
  assert.equal(new Set(recorded.map(job => job.workflowRunId)).size, 3)
  assert.ok(recorded.every(job => job.batchIndex === undefined && job.batchSize === undefined))
  assert.equal(jobs.queue.length, 0)

  const payload = { projectId: a.id, snapshot: a, runIds: [randomUUID(), randomUUID()], options: { mode: 'all', batchSize: 2 } }
  const first = await call('vd-runs/submit', payload), retry = await call('vd-runs/submit', payload)
  assert.deepEqual(first.runs.map(run => run.id), retry.runs.map(run => run.id))
  await until(async () => (await call('vd-runs/list', {})).runs.every(run => run.status === 'completed'))
  assert.equal(calls.length, 10)
  await assert.rejects(call('vd-runs/submit', { ...payload, snapshot: { ...a, name: 'different' } }), /different submission/)
})

test('a Host restart resumes queued snapshots in order and marks uncertain active work failed', async t => {
  const { projects: [a, b], call, jobs, store, providers, calls } = await fixture(t)
  const blocker = { id: randomUUID(), projectId: a.id, mode: 'all', batchSize: 1,
    nodeIds: ['first', 'second'], completedJobs: 0, totalJobs: 2, status: 'running', startedAt: new Date().toISOString(), scheduler: 'host' }
  await store.saveVdRun(a.id, blocker, a)
  jobs.runQueue.register(blocker)
  const { runs } = await call('vd-runs/submit', { projectId: b.id, snapshot: b,
    runIds: [randomUUID(), randomUUID()], options: { mode: 'all', batchSize: 2 } })
  await jobs.workflowScheduler.close()
  assert.equal(calls.length, 0)
  const recoveredJobs = new JobManager(store, providers, { concurrency: 2 })
  await recoveredJobs.recover()
  createDirectorRpc({ store, jobs: recoveredJobs, providers, workflows: { list: () => [] }, registerAsset: async () => {} })
  t.after(() => recoveredJobs.workflowScheduler.close())
  await recoveredJobs.workflowScheduler.recover()
  await until(async () => (await store.listVdRuns(b.id)).every(run => run.status === 'completed'))
  assert.equal((await store.getVdRun(a.id, blocker.id)).status, 'failed')
  assert.deepEqual(calls, [`${b.id}:first`, `${b.id}:second`, `${b.id}:first`, `${b.id}:second`])
  const project = await store.getProject(b.id)
  assert.deepEqual([...new Set(project.jobs.map(job => job.workflowRunId))], runs.map(run => run.id))
})

test('failed workflows release the queue; deleting terminal history retains snapshots and artifacts', async t => {
  const { projects: [a, b], call, providers, store, calls } = await fixture(t)
  const execute = providers.run
  providers.run = async request => { if (request.projectId === a.id) throw new Error('Provider unavailable'); return execute(request) }
  const submit = project => call('vd-runs/submit', { projectId: project.id, snapshot: project, runIds: [randomUUID()], options: { mode: 'all' } })
  const { runs: [first] } = await submit(a), { runs: [second] } = await submit(b)
  await assert.rejects(call('vd-runs/delete', { projectId: b.id, runId: second.id }), /Cancel this run/)
  await until(async () => (await store.getVdRun(b.id, second.id)).status === 'completed')
  assert.equal((await store.getVdRun(a.id, first.id)).status, 'failed')
  const prior = await store.getVdRun(b.id, second.id)
  const history = (await store.getProject(b.id)).jobs
  await call('vd-runs/delete', { projectId: b.id, runId: second.id })
  const after = await store.getVdRun(b.id, second.id)
  assert.equal(after.hidden, true)
  assert.deepEqual(after.snapshot, prior.snapshot)
  assert.deepEqual((await store.getProject(b.id)).jobs, history)
  assert.equal(calls.length, 2)
  // Pruning the rolling project history must not break later artifact downloads.
  await store.updateProject(b.id, { jobs: [] })
  const retained = (await call('vd-runs/jobs', { projectId: b.id, runId: second.id })).jobs
  assert.equal(retained.length, 2)
  assert.ok(retained.every(job => job.result.text === 'result'))
  assert.equal(after.artifactCount, 2)
  assert.equal(after.previewResult.kind, 'text')
})
