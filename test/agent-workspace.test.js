import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { testHost } from './fixtures/director-host.js'
import { libraryTool } from '../src/library-agent.js'
import { canvasTool } from '../src/canvas-agent.js'
import { ResultViews } from '../src/bounded-results.js'
import { workspaceTool } from '../src/workspace-agent.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-workspace-synthetic-'))
  const host = await testHost(root)
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  const project = await host.store.createProject({ name: 'Synthetic skills studio', sessionId: 'synthetic-chat' })
  const call = async (surface, command, args = {}, sessionId = project.sessionId) => {
    const result = await host.rpc(`${surface}/command`, { projectId: project.id, sessionId, command, args })
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
    return result.value
  }
  return { root, host, project, call }
}
const skill = { name: 'synthetic-storyboard', description: 'Build a synthetic storyboard.', content: 'Query only relevant nodes. Add a text input and preview. Inspect and undo when requested.', resources: { 'references/example.txt': 'Synthetic example only.' } }

test('milestone: create/save/load pinned skills, query/edit/inspect/undo, survive restart', async t => {
  const { root, host, project, call } = await fixture(t)
  const first = await call('library', 'create', skill)
  await call('library', 'bind', { id: first.id, revision: 1 })
  const second = await call('library', 'save', { ...skill, id: first.id, expectedRevision: 1, content: 'New synthetic instructions.' })
  assert.equal(second.revision, 2)
  const loaded = await libraryTool(host).execute({ projectId: project.id, command: 'load', args: { id: first.id } }, { agent: { session: { id: project.sessionId } } })
  assert.equal(loaded.revision, 1); assert.equal(loaded.content, skill.content)
  assert.equal((await call('library', 'resource', { id: first.id, revision: 1, path: 'references/example.txt' })).text, 'Synthetic example only.')
  assert.match(await readFile(join(root, 'library', 'skills', first.id, 'versions', '1', 'SKILL.md'), 'utf8'), /name: synthetic-storyboard/)
  const key = randomUUID()
  const args = { expectedDraftRevision: 0, idempotencyKey: key, edits: [
    { op: 'add', id: 'input', kind: 'load-text', data: { text: 'Synthetic text.' } },
    { op: 'add', id: 'preview', type: 'core.preview' },
    { op: 'connect', source: 'input', target: 'preview' },
  ] }
  const edited = await call('canvas', 'edit', args)
  assert.equal((await call('canvas', 'nodes')).items.length, 2)
  assert.equal((await call('canvas', 'inspect', { operationId: key })).changes.added.length, 2)
  assert.equal((await call('canvas', 'edit', args)).replayed, true)
  await assert.rejects(call('canvas', 'edit', { ...args, edits: [{ op: 'rename', name: 'Other' }] }), /different edits/)
  const undone = await call('canvas', 'undo', { operationId: key, expectedDraftRevision: edited.draftRevision })
  assert.equal((await call('canvas', 'summary')).nodeCount, 0)
  assert.equal(undone.operation.undoOf, key)
  const orphanId = randomUUID()
  const published = JSON.parse(await readFile(join(root, 'projects', project.id, 'operations', `${key}.json`), 'utf8'))
  await writeFile(join(root, 'projects', project.id, 'operations', `${orphanId}.json`), JSON.stringify({ ...published, id: orphanId }))
  const restarted = await testHost(root)
  try {
    const history = await restarted.store.operationHistory(project.id)
    assert.equal(history.items.length, 2)
    assert.equal(await restarted.store.findOperation(await restarted.store.getProject(project.id), orphanId), undefined)
    const active = await restarted.rpc('library/command', { projectId: project.id, sessionId: project.sessionId, command: 'active' })
    assert.equal(active.value.items[0].revision, 1)
  } finally { await restarted.close() }
})

test('skills enforce ownership, version conflicts, bounded instructions and safe resource paths', async t => {
  const { host, project, call } = await fixture(t)
  const first = await call('library', 'create', skill)
  await assert.rejects(call('library', 'save', { ...skill, id: first.id, expectedRevision: 0 }), /changed/)
  await assert.rejects(call('library', 'get', { id: first.id }, 'other-chat'), /owning chat/)
  const other = await host.store.createProject({ name: 'Other synthetic project, same cwd', sessionId: 'other-chat' })
  const otherGet = await host.rpc('library/command', { projectId: other.id, sessionId: other.sessionId, command: 'get', args: { id: first.id } })
  assert.equal(otherGet.ok, false)
  await assert.rejects(call('library', 'create', { ...skill, content: '大'.repeat(6000) }), /12 KiB/)
  await assert.rejects(call('library', 'create', { ...skill, resources: { 'references/../../outside': 'bad' } }), /relative files/)
  await assert.rejects(call('library', 'load', { id: first.id, revision: 1 }), /Select this skill/)
  await call('library', 'bind', { id: first.id, revision: 1 })
  await host.store.replaceProjectSession(project.id, 'fresh-session')
  assert.equal((await call('library', 'active', {}, 'fresh-session')).items.length, 0)
})

test('browser changes share durable receipts and stale undo preserves newer edits', async t => {
  const { host, project, call } = await fixture(t)
  const first = await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'input', kind: 'load-text' }] })
  const current = await host.store.getProject(project.id)
  await host.store.cacheDraft(project.id, { ...current.draft, name: 'Human changed this' }, 1)
  const records = await call('canvas', 'history')
  assert.equal(records.items[0].kind, 'browser')
  await assert.rejects(call('canvas', 'undo', { operationId: first.operation.id, expectedDraftRevision: 2 }), /Later edits/)
  assert.equal((await call('canvas', 'summary')).name, 'Human changed this')
  await call('canvas', 'undo', { operationId: records.items[0].id, expectedDraftRevision: 2 })
  await call('canvas', 'undo', { operationId: first.operation.id, expectedDraftRevision: 3 })
  assert.equal((await call('canvas', 'summary')).nodeCount, 0)
})

test('bounded protocol projects neighborhoods, pages large canvases, rejects stale cursors and gates content', async t => {
  const { host, project, call } = await fixture(t)
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [
    { op: 'add', id: 'source', kind: 'load-text', data: { text: 'Synthetic large text '.repeat(1500) } },
    { op: 'add', id: 'preview', type: 'core.preview' }, { op: 'connect', source: 'source', target: 'preview' },
  ] })
  const tool = canvasTool(host)
  const execute = (command, args = {}) => tool.execute({ projectId: project.id, command, args }, { agent: { session: { id: project.sessionId } } })
  assert.equal((await execute('query', { selector: { ids: ['preview'], direction: 'upstream', hops: 1 } })).items.length, 2)
  assert.equal(Object.hasOwn((await execute('edges')).items[0], 'data'), false)
  await assert.rejects(execute('edges', { includeData: true }), /sharing is disabled/)
  host.providers.providers.get('openai').baseUrl = 'https://synthetic-user:synthetic-password@synthetic.invalid/?key=synthetic'
  assert.equal(Object.hasOwn((await execute('providers')).providers[0], 'baseUrl'), false)
  await assert.rejects(execute('query', { fields: ['text'] }), /sharing is disabled/)
  await host.rpc('workspace/access', { projectId: project.id, allowContent: true })
  const projected = await execute('query', { fields: ['id', 'text'], maxBytes: 1024 })
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 1024)
  assert.equal(projected.items.kind, 'vd-result-reference')
  const detail = await execute('read-result', { ...projected.items, maxBytes: 1024 })
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 1024)
  const page = await execute('query', { limit: 1 })
  assert.ok(page.nextCursor)
  assert.equal((await execute('query', { limit: 1, cursor: page.nextCursor })).items[0].id, 'preview')
  await call('canvas', 'edit', { expectedDraftRevision: 1, edits: [{ op: 'rename', name: 'Changed synthetic revision' }] })
  await assert.rejects(execute('query', { limit: 1, cursor: page.nextCursor }), /revision changed/)
  await assert.rejects(execute('read-result', projected.items), /canvas changed/)
})

test('result projections are bounded for Unicode and recover exact text without exposing another chat', () => {
  const views = new ResultViews()
  const scope = { projectId: 'p', sessionId: 's', draftRevision: 1, allowContent: true, sensitive: true }
  const value = '大😀'.repeat(9000)
  const ref = views.pack(value, scope, 1024)
  let result = '', offset = 0
  do {
    const part = views.read({ ...ref, offset, maxBytes: 1024 }, scope)
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 1024)
    result += part.text; offset = part.nextOffset
  } while (offset !== null)
  assert.equal(result, value)
  assert.throws(() => views.read(ref, { ...scope, sessionId: 'other' }), /not in this chat/)
  assert.throws(() => views.read(ref, { ...scope, allowContent: false }), /sharing is disabled/)
  const wideKeys = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}${'大'.repeat(80)}`, value]))
  const wideRef = views.pack(wideKeys, scope, 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(wideRef)) <= 1024)
  const longKey = 'a'.repeat(1900)
  const longRef = views.pack({ [longKey]: value }, scope, 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(longRef)) <= 1024)
  assert.throws(() => views.read({ ...longRef, path: `/${longKey}`, maxBytes: 1024 }, scope), /Increase maxBytes/)
})

async function inspectIteration(call, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await call('quality', 'step', { id })
    if (state.state !== 'running') return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Synthetic run did not finish')
}

test('quality loop records failed checks, revises the affected canvas, accepts evidence and retains version pins', async t => {
  const { call, host, project } = await fixture(t)
  const version = await call('library', 'create', skill)
  await call('library', 'bind', { id: version.id, revision: 1 })
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'text', kind: 'load-text', data: { text: 'First synthetic draft' } },
    { op: 'add', id: 'trigger', type: 'core.vram-trigger', data: { vramAction: 'skip', vramActionInitialized: true } },
    { op: 'connect', source: 'text', target: 'trigger', targetHandle: 'in:flow-in' }] })
  const plan = await call('quality', 'create', { brief: 'Synthetic revision check', maxIterations: 3, maxJobs: 2,
    criteria: [{ id: 'script', type: 'text-includes', nodeId: 'text', text: 'Accepted synthetic text' }] })
  await call('library', 'save', { ...skill, id: version.id, expectedRevision: 1, content: 'Future skill version.' })
  assert.equal((await inspectIteration(call, plan.id)).state, 'needs-revision')
  await call('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'text', data: { text: 'Accepted synthetic text' } }] })
  const accepted = await inspectIteration(call, plan.id)
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.reports.length, 2)
  assert.equal(accepted.best.iteration, 2); assert.equal(accepted.skills[0].revision, 1)
  const moved = await host.rpc('storage/change', { expectedDataDir: host.store.root, dataDir: join(host.store.root, '..', `vd-synthetic-move-${randomUUID()}`) })
  assert.equal(moved.ok, true)
  t.after(async () => { await rm(moved.value.dataDir, { recursive: true, force: true }) })
  const restored = await host.rpc('quality/command', { projectId: project.id, sessionId: project.sessionId, command: 'get', args: { id: plan.id } })
  assert.equal(restored.value.best.runId, accepted.best.runId)
})

test('quality checks stop for iteration caps and human edits; missing perceptual evidence cannot pass', async t => {
  const { call } = await fixture(t)
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'text', kind: 'load-text' },
    { op: 'add', id: 'trigger', type: 'core.vram-trigger', data: { vramAction: 'skip', vramActionInitialized: true } },
    { op: 'connect', source: 'text', target: 'trigger', targetHandle: 'in:flow-in' }] })
  const capped = await call('quality', 'create', { brief: 'Synthetic failure', maxIterations: 1, criteria: [{ id: 'count', type: 'node-count', min: 3 }] })
  const stopped = await inspectIteration(call, capped.id)
  assert.equal(stopped.state, 'stopped'); assert.match(stopped.reason, /Iteration budget/)
  const visual = await call('quality', 'create', { brief: 'Synthetic visual evaluation', criteria: [{ id: 'visual', type: 'perceptual', description: 'Logo is readable' }] })
  assert.equal((await inspectIteration(call, visual.id)).state, 'inspecting')
  await assert.rejects(call('quality', 'evaluate', { id: visual.id, criterionId: 'visual', verdict: 'pass', confidence: .9, reason: 'Looks fine', evidence: [] }), /requires evidence/)
  await call('canvas', 'edit', { expectedDraftRevision: 1, edits: [{ op: 'rename', name: 'Human edited' }] })
  const interrupted = await call('quality', 'step', { id: visual.id })
  assert.equal(interrupted.state, 'stopped'); assert.match(interrupted.reason, /outside this plan/)
  assert.equal((await call('canvas', 'summary')).name, 'Human edited')
})

test('workspace operations reuse scoped handlers and view receipts require a live acknowledgement', async t => {
  const { host, project, call } = await fixture(t)
  const tool = workspaceTool(host)
  const execute = (command, args) => tool.execute({ projectId: project.id, command, args }, { agent: { session: { id: project.sessionId } } })
  assert.ok((await execute('manifest', {})).operations.some(row => row.name === 'canvas.edit'))
  assert.ok((await execute('describe', { name: 'canvas.edit' })).fields.includes('expectedDraftRevision'))
  assert.deepEqual((await execute('describe', { name: 'canvas.edit' })).inputSchema.required, ['edits', 'expectedDraftRevision'])
  await assert.rejects(execute('call', { name: 'workflow.rename', input: { name: 'Synthetic', expectedDraftRevision: 0, unsupported: true } }), /Unknown input field/)
  await assert.rejects(execute('view', { action: 'frame' }), /Open this workflow/)
  await host.rpc('workspace/access', { projectId: project.id, allowContent: true })
  await execute('call', { name: 'canvas.edit', input: { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'view-node', kind: 'load-text' }] } })
  assert.equal((await call('canvas', 'summary')).nodeCount, 1)
  const viewId = randomUUID()
  const poll = payload => host.rpc('workspace/view', { projectId: project.id, sessionId: project.sessionId, viewId, ...payload })
  await poll({})
  const queued = await execute('view', { action: 'select', nodeIds: ['view-node'] })
  assert.equal(queued.status, 'queued')
  assert.equal((await poll({})).value.commands[0].id, queued.id)
  await poll({ acknowledgements: [{ id: queued.id }] })
  assert.equal((await execute('view-status', { id: queued.id })).status, 'applied')
  await poll({ close: true })
  await assert.rejects(execute('view', { action: 'inspect', nodeIds: ['view-node'] }), /Open this workflow/)
  await assert.rejects(execute('call', { name: 'providers.configure', input: { providerId: 'openai', patch: { apiKey: 'synthetic-not-a-key' } } }), /credentials/)
  await assert.rejects(execute('call', { name: 'providers.configure', input: { providerId: 'openai', patch: { baseUrl: 'https://synthetic.invalid' } } }), /destinations/)
})

test('large synthetic canvases remain bounded at 2000 nodes/5000 edges and undo stores changed rows', async t => {
  const { host, project, call, root } = await fixture(t)
  const graph = { nodes: Array.from({ length: 2000 }, (_, i) => ({ id: `node-${i}`, type: 'director', position: { x: i, y: 0 }, data: { kind: 'load-text', title: `Node ${i}`, status: 'idle', text: 'Synthetic '.repeat(100) } })),
    edges: Array.from({ length: 5000 }, (_, i) => ({ id: `edge-${i}`, source: `node-${i % 2000}`, target: `node-${(i + 1) % 2000}` })), viewport: { x: 0, y: 0, zoom: 1 } }
  await host.store.cacheDraft(project.id, { name: project.name, graph, settings: {} }, 0)
  const tool = canvasTool(host)
  const result = await tool.execute({ projectId: project.id, command: 'query', args: { limit: 50, maxBytes: 4096 } }, { agent: { session: { id: project.sessionId } } })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096)
  assert.equal(result.total, 2000)
  const edited = await call('canvas', 'edit', { expectedDraftRevision: 1, edits: [{ op: 'update', id: 'node-7', data: { title: 'Changed synthetic node' } }] })
  const journal = JSON.parse(await readFile(join(root, 'projects', project.id, 'operations', `${edited.operation.id}.json`), 'utf8'))
  assert.equal(journal.inverse.nodes.rows.length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(journal)) < 150000)
  await call('canvas', 'undo', { operationId: edited.operation.id, expectedDraftRevision: 2 })
  assert.equal((await call('canvas', 'node', { id: 'node-7' })).data.title, 'Node 7')
})

test('quality budgets reserve jobs before submission and interrupted submission is never replayed on restart', async t => {
  const { root, host, project, call } = await fixture(t)
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'text', kind: 'load-text' },
    { op: 'add', id: 'trigger', type: 'core.vram-trigger', data: { vramAction: 'skip', vramActionInitialized: true } },
    { op: 'connect', source: 'text', target: 'trigger', targetHandle: 'in:flow-in' }] })
  const plan = await call('quality', 'create', { brief: 'Synthetic budget', maxIterations: 3, maxJobs: 1, criteria: [{ id: 'count', type: 'node-count', min: 4 }] })
  await assert.rejects(call('canvas', 'run'), /active quality plan/)
  const direct = await host.rpc('jobs/start', { projectId: project.id, nodeId: 'trigger', clientRunId: 'synthetic-direct', snapshot: { version: 1, sourceRevision: 1, request: {} } })
  assert.equal(direct.error.code, 'video-director/plan-active')
  assert.equal((await inspectIteration(call, plan.id)).state, 'needs-revision')
  await call('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'text', data: { text: 'Synthetic changed input' } }] })
  const capped = await call('quality', 'step', { id: plan.id })
  assert.equal(capped.state, 'stopped'); assert.match(capped.reason, /budget exhausted before scheduling/)
  assert.equal((await host.store.listVdRuns(project.id)).length, 1)
  const pending = await call('quality', 'create', { brief: 'Synthetic interrupted submission' })
  const path = join(root, 'projects', project.id, 'quality', `${pending.id}.json`)
  const stored = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...stored, state: 'submitting', currentRunId: randomUUID(), iterations: 1, reservedJobs: 1 }))
  await host.close()
  const restored = await testHost(root)
  try {
    const result = await restored.rpc('quality/command', { projectId: project.id, sessionId: project.sessionId, command: 'get', args: { id: pending.id } })
    assert.equal(result.value.state, 'stopped'); assert.match(result.value.reason, /interrupted/)
    assert.equal((await restored.store.listVdRuns(project.id)).length, 1)
  } finally { await restored.close() }
})

test('SKILL.md import preserves frontmatter and requires a human gesture for restricted skills', async t => {
  const { host, project, call } = await fixture(t)
  const imported = await call('library', 'create', { markdown: '---\nname: synthetic-restricted\ndescription: >-\n  A folded synthetic\n  description.\ndisable-model-invocation: true\nlicense: MIT\n---\n\nSynthetic instructions only.' })
  assert.equal(imported.description, 'A folded synthetic description.')
  const tool = libraryTool(host)
  const execute = (command, args) => tool.execute({ projectId: project.id, command, args }, { agent: { session: { id: project.sessionId } } })
  await assert.rejects(execute('bind', { id: imported.id, revision: 1 }), /invocation source/)
  await call('library', 'bind', { id: imported.id, revision: 1 })
  assert.equal((await execute('load', { id: imported.id })).content, 'Synthetic instructions only.')
  assert.equal((await call('library', 'get', { id: imported.id })).frontmatter.license, 'MIT')
  await assert.rejects(call('library', 'create', { markdown: '---\nname: first\nname: second\ndescription: invalid\n---\ntext' }), /frontmatter is invalid/)
})

test('automatic skill invocation loads the built-in without selecting a project skill or pinning it', async t => {
  const { host, project, call } = await fixture(t)
  await call('library', 'create', { ...skill, name: 'canvas-builder' })
  await call('library', 'create', skill)
  const tool = libraryTool(host)
  const invoke = name => tool.execute({ projectId: project.id, command: 'invoke', args: { name } }, { agent: { session: { id: project.sessionId } } })
  const builtIn = await invoke('canvas-builder')
  assert.equal(builtIn.builtIn, true)
  assert.match(builtIn.content, /vd_canvas/)
  assert.deepEqual((await call('library', 'active')).items, [])
  await assert.rejects(invoke(skill.name), /available built-in skill/)
})

test('quality iterations reuse unaffected outputs and preserve the best result after no improvement', async t => {
  const { host, project, call } = await fixture(t)
  const submitted = []
  // Exercise persisted provider outputs without making any network requests.
  host.providers.run = async request => {
    submitted.push(request.nodeId)
    return { kind: 'text', providerId: 'openai', text: 'Synthetic provider output' }
  }
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: ['left', 'right'].flatMap(side => [
    { op: 'add', id: side, kind: 'load-text', data: { text: `Synthetic ${side}` } },
    { op: 'add', id: `${side}-run`, kind: 'prompt-enhancer', data: { providerId: 'openai', modelId: 'synthetic-model', prompt: 'Synthetic prompt' } },
    { op: 'connect', source: side, target: `${side}-run` },
  ]) })
  const plan = await call('quality', 'create', { brief: 'Synthetic affected branch', maxIterations: 3, maxJobs: 3, criteria: [{ id: 'text', type: 'text-includes', nodeId: 'left', text: 'Never present' }] })
  const first = await inspectIteration(call, plan.id)
  assert.equal(first.state, 'needs-revision')
  await call('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'left', data: { text: 'Still synthetic' } }] })
  const next = await inspectIteration(call, plan.id)
  assert.equal(next.state, 'stopped'); assert.match(next.reason, /No measured improvement/)
  assert.equal(next.best.runId, first.best.runId)
  const runs = await host.store.listVdRuns(project.id)
  assert.deepEqual(runs.map(run => run.totalJobs).sort(), [1, 2])
  assert.deepEqual(submitted.sort(), ['left-run', 'left-run', 'right-run'])
})

test('quality retains reused output provenance through three improving iterations', async t => {
  const { host, call } = await fixture(t)
  const submitted = []
  host.providers.run = async request => {
    submitted.push(request.nodeId)
    return { kind: 'text', providerId: 'openai', text: 'Synthetic output' }
  }
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: ['left', 'right'].flatMap(side => [
    { op: 'add', id: side, kind: 'load-text', data: { text: 'alpha' } },
    { op: 'add', id: `${side}-run`, kind: 'prompt-enhancer', data: { providerId: 'openai', prompt: 'Synthetic prompt' } },
    { op: 'connect', source: side, target: `${side}-run` },
  ]) })
  const plan = await call('quality', 'create', { brief: 'Three synthetic iterations', maxIterations: 3, maxJobs: 4, criteria: [
    ...['alpha', 'beta', 'gamma'].map(text => ({ id: text, type: 'text-includes', nodeId: 'left', text })),
    { id: 'outputs', type: 'artifact-count', min: 2 },
  ] })
  assert.equal((await inspectIteration(call, plan.id)).state, 'needs-revision')
  await call('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'left', data: { text: 'alpha beta' } }] })
  assert.equal((await inspectIteration(call, plan.id)).state, 'needs-revision')
  await call('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'left', data: { text: 'alpha beta gamma' } }] })
  const accepted = await inspectIteration(call, plan.id)
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.reservedJobs, 4)
  assert.deepEqual(submitted.sort(), ['left-run', 'left-run', 'left-run', 'right-run'])
  assert.equal(accepted.reports[2].reusedOutputs[0].runId, accepted.reports[0].runId)
  assert.equal((await call('canvas', 'node', { id: 'right-run' })).dataKeys.includes('frozen'), false)
})

test('quality stops on changed skill selection and expired deadlines; discard returns scoped success', async t => {
  const { host, project, call, root } = await fixture(t)
  const selected = await call('library', 'create', skill)
  await call('library', 'bind', { id: selected.id, revision: 1 })
  const plan = await call('quality', 'create', { brief: 'Synthetic pin change' })
  await call('library', 'save', { ...skill, content: 'Second synthetic version', id: selected.id, expectedRevision: 1 })
  await call('library', 'bind', { id: selected.id, revision: 2 })
  assert.match((await call('quality', 'step', { id: plan.id })).reason, /skill versions changed/)
  const timed = await call('quality', 'create', { brief: 'Synthetic deadline' })
  const path = join(root, 'projects', project.id, 'quality', `${timed.id}.json`)
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), deadline: Date.now() - 1 }))
  assert.match((await call('quality', 'step', { id: timed.id })).reason, /Time budget/)
  assert.equal((await host.store.listVdRuns(project.id)).length, 0)
  const unsaved = await host.store.createProject({ name: 'Disposable synthetic draft', sessionId: 'synthetic-discard', unsaved: true })
  const discarded = await host.rpc('workspace/command', { projectId: unsaved.id, sessionId: unsaved.sessionId, command: 'call', args: { name: 'workflow.discard', input: { expectedDraftRevision: 0 } } })
  assert.deepEqual(discarded, { ok: true, value: { discarded: true, deleted: true } })
  await assert.rejects(host.store.getProject(unsaved.id), /not found/)
})

test('quality requires sufficient output evidence and enforces deadlines without browser polling', async t => {
  const { host, project, call, root } = await fixture(t)
  host.providers.run = async () => ({ kind: 'text', providerId: 'openai', text: 'Friendly synthetic text.' })
  await call('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'run', kind: 'prompt-enhancer', data: { providerId: 'openai', prompt: 'Synthetic prompt' } }] })
  const plan = await call('quality', 'create', { brief: 'Synthetic evidence', criteria: [{ id: 'tone', type: 'perceptual', description: 'Friendly tone' }] })
  const inspected = await inspectIteration(call, plan.id)
  assert.equal(inspected.state, 'inspecting')
  const [job] = await host.store.listVdRunJobs(project.id, inspected.currentRunId)
  const verdict = { id: plan.id, criterionId: 'tone', verdict: 'pass', reason: 'The synthetic text has a friendly greeting.', evidence: [{ jobId: job.id }] }
  await assert.rejects(call('quality', 'evaluate', { ...verdict, confidence: .9, evidence: [{ jobId: randomUUID() }] }), /output job/)
  assert.equal((await call('quality', 'evaluate', { ...verdict, confidence: .4 })).state, 'inspecting')
  assert.equal((await call('quality', 'evaluate', { ...verdict, confidence: .9 })).state, 'accepted')
  let started = false
  host.providers.run = async (_request, signal) => new Promise((resolve, reject) => {
    started = true
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const timed = await call('quality', 'create', { brief: 'Synthetic running deadline' })
  const running = await call('quality', 'step', { id: timed.id })
  for (let attempt = 0; attempt < 100 && !started; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(started, true)
  const path = join(root, 'projects', project.id, 'quality', `${timed.id}.json`)
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), deadline: Date.now() - 1 }))
  let current
  for (let attempt = 0; attempt < 30; attempt++) {
    current = await call('quality', 'get', { id: timed.id })
    if (current.state === 'stopped') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(current.state, 'stopped'); assert.match(current.reason, /Time budget/)
  assert.equal((await host.store.getVdRun(project.id, running.currentRunId)).status, 'cancelled')
})
