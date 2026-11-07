import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { testHost } from './fixtures/director-host.js'
import { ProjectStore } from '../src/project-store.js'
import { sessionContext } from './fixtures/client-sessions.js'

const bundle = await build({ stdin: {
  resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
  contents: "export {DirectorController} from './controller'; export {ProjectDraftCache} from './project-drafts'", loader: 'ts',
}, bundle: true, format: 'esm', platform: 'browser', write: false })
const { DirectorController, ProjectDraftCache } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'director-drafts-'))
  let host = await testHost(root)
  let controller
  const calls = []
  const sessions = { current: undefined, byId: {} }
  const bindings = new Map()
  const context = { connection: { rpc: { call: async (_channel, endpoint, payload) => {
    calls.push(endpoint)
    return host.rpc(endpoint, payload)
  } } }, sessions: {
    list: { getSnapshot: () => sessions, subscribe: () => () => {} },
    create: async (options = {}) => {
      const id = options.sessionId ?? randomUUID()
      sessions.byId[id] = { id }
      bindings.set(id, { session: { getSnapshot: () => ({}), rename: async title => {
        sessions.byId[id].title = title
        return { ok: true, value: { title } }
      } } })
      return id
    },
    binding: id => bindings.get(id),
    open: id => { sessions.current = id },
  } }
  controller = new DirectorController(sessionContext(context))
  await controller.start()
  t.after(async () => {
    await controller.flushDrafts()
    controller.dispose()
    await host.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root, context, calls, sessions,
    get controller() { return controller },
    get host() { return host },
    async restart() {
      await controller.flushDrafts()
      controller.dispose()
      await host.close()
      host = await testHost(root)
      controller = new DirectorController(sessionContext(context))
      await controller.start()
      return controller
    },
  }
}

test('open canvas polling and restart preserve quality inputs while retaining synthetic outputs in history', async t => {
  const app = await fixture(t)
  await app.controller.createProject('Synthetic quality canvas')
  app.host.providers.run = async () => ({ kind: 'text', providerId: 'openai', text: 'Synthetic output only' })
  await app.controller.workspace('canvas', 'edit', { expectedDraftRevision: 0, edits: [
    { op: 'add', id: 'text', kind: 'load-text', data: { text: 'Initial synthetic input' } },
    { op: 'add', id: 'run', kind: 'prompt-enhancer', data: { providerId: 'openai', prompt: 'Synthetic prompt' } },
    { op: 'connect', source: 'text', target: 'run' },
  ] })
  const plan = await app.controller.workspace('quality', 'create', { brief: 'Synthetic controller iteration', criteria: [{ id: 'text', type: 'text-includes', nodeId: 'text', text: 'Accepted' }] })
  const first = await app.controller.workspace('quality', 'step', { id: plan.id, waitMs: 3000 })
  assert.equal(first.state, 'needs-revision')
  await app.controller.refreshVdRuns()
  await app.controller.flushDrafts()
  const projectId = app.controller.getSnapshot().project.id
  assert.equal((await app.host.store.getProject(projectId)).draftRevision, plan.draftRevision)
  assert.equal(app.controller.getSnapshot().project.graph.nodes.length, 2)
  assert.equal(app.controller.getSnapshot().jobs[0].qualityPlanId, plan.id)
  assert.equal(app.controller.getSnapshot().jobs[0].result.text, 'Synthetic output only')
  await app.controller.workspace('quality', 'revise', { id: plan.id, edits: [{ op: 'update', id: 'text', data: { text: 'Accepted synthetic input' } }] })
  const accepted = await app.controller.workspace('quality', 'step', { id: plan.id, waitMs: 3000 })
  assert.equal(accepted.state, 'accepted')
  await app.controller.refreshVdRuns(); await app.controller.flushDrafts()
  await app.restart()
  await app.controller.flushDrafts()
  assert.equal((await app.host.store.getProject(projectId)).draftRevision, accepted.draftRevision)
  const graph = app.controller.getSnapshot().project.graph
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes.find(node => node.id === 'run').data.result, undefined)
})

test('renaming the active workflow updates its linked session title', async t => {
  const app = await fixture(t)
  await app.controller.createProject('Original workflow')
  const { id, sessionId } = app.controller.getSnapshot().project
  await app.controller.renameProjectById(id, 'Renamed workflow')
  await app.controller.flushDrafts()
  assert.equal(app.sessions.byId[sessionId].title, 'Renamed workflow')
})

test('renaming a background workflow updates only its linked session', async t => {
  const app = await fixture(t)
  await app.controller.createProject('Background workflow')
  const { id, sessionId } = app.controller.getSnapshot().project
  await app.controller.createProject('Active workflow')
  const activeSessionId = app.controller.getSnapshot().project.sessionId
  await app.controller.renameProjectById(id, 'Renamed background')
  assert.equal(app.sessions.byId[sessionId].title, 'Renamed background')
  assert.equal(app.sessions.byId[activeSessionId].title, 'Active workflow')
  assert.equal(app.sessions.current, activeSessionId)
})

test('undo, redo, Save and background Discard keep the linked title consistent', async t => {
  const app = await fixture(t)
  const c = app.controller
  await c.createProject('Saved name')
  await c.saveProject()
  const { id, sessionId } = c.getSnapshot().project
  await c.renameProjectById(id, 'Draft name')
  c.undo()
  await c.flushDrafts()
  assert.equal(app.sessions.byId[sessionId].title, 'Saved name')
  c.redo()
  await c.flushDrafts()
  assert.equal(app.sessions.byId[sessionId].title, 'Draft name')
  await c.createProject('Other workflow')
  await c.discardChanges(id)
  assert.equal(app.sessions.byId[sessionId].title, 'Saved name')
  await c.selectProject(id)
  c.renameProject('Saved immediately')
  await c.saveProject()
  assert.equal(app.sessions.byId[sessionId].title, 'Saved immediately')
  await c.renameProjectById(id, 'Discard current')
  await c.discardChanges()
  assert.equal(app.sessions.byId[sessionId].title, 'Saved immediately')
})

test('startup repairs old titles from effective draft names without opening their sessions', async t => {
  const app = await fixture(t)
  await app.controller.createProject('Saved title')
  const { id, sessionId } = app.controller.getSnapshot().project
  await app.controller.renameProjectById(id, 'Recovered draft title')
  await app.controller.createProject('Current workflow')
  const currentSession = app.sessions.current
  app.sessions.byId[sessionId].title = 'Stale title'
  const before = app.calls.length
  await app.restart()
  assert.equal(app.sessions.byId[sessionId].title, 'Recovered draft title')
  assert.equal(app.sessions.current, currentSession)
  assert.equal(app.calls.slice(before).filter(call => call === 'projects/get').length, 1,
    'repair uses project summaries, without loading background workflows')
})

test('a delayed rename cannot overwrite a newer workflow name', async t => {
  const app = await fixture(t)
  const c = app.controller
  await c.createProject('Original')
  const { id, sessionId } = c.getSnapshot().project
  const binding = app.context.sessions.binding(sessionId).session
  const rename = binding.rename
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  binding.rename = async title => {
    if (title === 'First') { entered(); await gate }
    return rename(title)
  }
  const first = c.renameProjectById(id, 'First')
  await started
  const second = c.renameProjectById(id, 'Second')
  release()
  await Promise.all([first, second])
  assert.equal(app.sessions.byId[sessionId].title, 'Second')
  assert.equal((await app.host.store.getProject(id)).draft.name, 'Second')
})

test('rename failure preserves the durable draft and can be retried without a draft conflict', async t => {
  const app = await fixture(t)
  const c = app.controller
  await c.createProject('Original')
  const { id, sessionId } = c.getSnapshot().project
  const binding = app.context.sessions.binding(sessionId).session
  const rename = binding.rename
  binding.rename = async () => { throw new Error('Synthetic rename outage') }
  await c.renameProjectById(id, 'Keep this name')
  assert.equal((await app.host.store.getProject(id)).draft.name, 'Keep this name')
  assert.match(c.getSnapshot().error, /linked session could not be renamed/)
  assert.equal(c.getSnapshot().conflict, false)
  const writes = app.calls.filter(call => call === 'projects/draft').length
  binding.rename = rename
  await c.renameProjectById(id, 'Keep this name')
  assert.equal(app.sessions.byId[sessionId].title, 'Keep this name')
  assert.equal(app.calls.filter(call => call === 'projects/draft').length, writes)
  assert.equal(c.getSnapshot().conflict, false)
  assert.equal(c.getSnapshot().error, null)
})

test('missing linked sessions are not recreated during title repair', async t => {
  const app = await fixture(t)
  await app.controller.createProject('Missing history')
  const { sessionId } = app.controller.getSnapshot().project
  delete app.sessions.byId[sessionId]
  await app.restart()
  assert.equal(app.sessions.byId[sessionId], undefined)
  assert.equal(Object.keys(app.sessions.byId).length, 0)
  assert.match(app.controller.getSnapshot().error, /session is unavailable/)
})

test('drafts preserve multiple workflows, names and canvas positions through switching and Host restart', async t => {
  const app = await fixture(t)
  let controller = app.controller
  await controller.createProject('Saved workflow')
  const a = controller.getSnapshot().project.id
  controller.addText('Saved text')
  const textId = controller.getSnapshot().project.graph.nodes[0].id
  await controller.saveProject()
  controller.renameProject('Draft title')
  controller.updateNode(textId, { text: 'Unsaved Unicode 草稿' })
  controller.updateViewport({ x: 125, y: -52, zoom: .8 })
  const draftA = JSON.parse(JSON.stringify(controller.getSnapshot().project.graph))
  await controller.createProject('Never saved')
  const b = controller.getSnapshot().project.id
  controller.addText('Second draft')
  await controller.selectProject(a)
  assert.deepEqual(controller.getSnapshot().project.graph, draftA)
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().projects.filter(row => row.unsaved).length, 2)
  assert.equal((await app.host.store.getProject(a)).name, 'Saved workflow')
  assert.equal((await app.host.store.getProject(a)).graph.nodes[0].data.text, 'Saved text')
  assert.equal(app.calls.filter(endpoint => endpoint === 'projects/save').length, 1)

  await controller.renameProjectById(b, 'Background draft')
  assert.equal(controller.getSnapshot().project.id, a, 'row actions do not switch the canvas')
  await controller.reorderProjects([a, b])
  controller = await app.restart()
  assert.deepEqual(controller.getSnapshot().projects.map(row => row.id), [a, b])
  assert.equal(controller.getSnapshot().project.name, 'Draft title')
  assert.deepEqual(controller.getSnapshot().project.graph, draftA)
  await controller.selectProject(b)
  assert.equal(controller.getSnapshot().project.name, 'Background draft')
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, 'Second draft')
  await controller.discardChanges(a)
  assert.equal(controller.getSnapshot().project.id, b)
  await controller.selectProject(a)
  assert.equal(controller.getSnapshot().project.name, 'Saved workflow')
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, 'Saved text')
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().canUndo, false)
  await controller.discardChanges(b)
  assert.deepEqual(controller.getSnapshot().projects.map(row => row.id), [a])
  assert.equal(controller.getSnapshot().projects.filter(row => row.unsaved).length, 0)
  await assert.rejects(app.host.store.getProject(b), /not found/)
})

test('Discard restores the latest explicit Save, preserves records, and clears undo and redo', async t => {
  const app = await fixture(t)
  const controller = app.controller
  await controller.createProject('Workflow')
  controller.addText('First save')
  const id = controller.getSnapshot().project.graph.nodes[0].id
  await controller.saveProject()
  controller.updateNode(id, { text: 'Second save' })
  await controller.saveProject()
  const saved = structuredClone(controller.getSnapshot().project)
  controller.updateNode(id, { text: 'Discard me' })
  controller.renameProject('Temporary name')
  await controller.discardChanges()
  assert.ok(controller.getSnapshot().project.draftRevision > saved.draftRevision)
  // Discard preserves the durable history pointer, even when the browser's
  // earlier saved view predates the last coalesced draft receipt.
  const { operationHead: _head, ...discardedState } = controller.getSnapshot().project
  const { operationHead: _savedHead, ...savedState } = saved
  assert.deepEqual({ ...discardedState, draftRevision: saved.draftRevision }, savedState)
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().canUndo, false)
  assert.equal(controller.getSnapshot().canRedo, false)
  assert.equal(controller.getSnapshot().canvasResetVersion, 1)
})

test('edits during the first Save remain unsaved and recover separately from the committed version', async t => {
  const app = await fixture(t)
  const controller = app.controller
  await controller.createProject('New draft')
  controller.addText('Save this')
  const id = controller.getSnapshot().project.graph.nodes[0].id
  const projectId = controller.getSnapshot().project.id
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const call = app.context.connection.rpc.call
  app.context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'projects/save') { started(); await gate }
    return call(channel, endpoint, payload)
  }
  const saving = controller.saveProject()
  await entered
  controller.updateNode(id, { text: 'Keep editing during Save' })
  release()
  await saving
  await controller.flushDrafts()
  const stored = await app.host.store.getProject(projectId)
  assert.equal(stored.hasSavedVersion, undefined)
  assert.equal(stored.graph.nodes[0].data.text, 'Save this')
  assert.equal(stored.draft.graph.nodes[0].data.text, 'Keep editing during Save')
  assert.equal(controller.getSnapshot().dirty, true)
  const restored = await app.restart()
  assert.equal(restored.getSnapshot().project.graph.nodes[0].data.text, 'Keep editing during Save')
  await restored.discardChanges()
  assert.equal(restored.getSnapshot().project.graph.nodes[0].data.text, 'Save this')
})

test('job persistence cannot clear a draft or promote a never-saved workflow', async t => {
  const root = await mkdtemp(join(tmpdir(), 'director-job-draft-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024)
  await store.init()
  const initial = await store.createProject({ name: 'Unsaved', sessionId: randomUUID(), unsaved: true })
  const draft = { name: 'Edited', graph: initial.graph, settings: { value: 2 } }
  await store.cacheDraft(initial.id, draft)
  const running = await store.saveProject(initial.id, { ...initial, jobs: [{ id: randomUUID(), status: 'running' }], status: 'running' }, initial.revision)
  assert.deepEqual(running.draft, draft)
  assert.equal(running.hasSavedVersion, false)
  await assert.rejects(store.discardDraft(initial.id), /finish|cancel/)
  await store.updateProject(initial.id, { jobs: [], status: 'ready' })
  const current = await store.getProject(initial.id)
  await store.saveProject(initial.id, { ...current, ...draft }, current.revision, { commit: true })
  const saved = await store.getProject(initial.id)
  assert.equal(saved.draft, undefined)
  assert.equal(saved.hasSavedVersion, undefined)
  assert.equal(saved.name, 'Edited')
})

test('pending browser recovery survives a failed cache write and a new cache instance', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage })
  const draft = { name: 'Offline draft', graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, settings: {} }
  const offline = new ProjectDraftCache(async () => { throw new Error('Host stopped') }, () => {})
  offline.stage('project-id', draft)
  await assert.rejects(offline.flush(), /Host stopped/)
  offline.dispose()
  const writes = []
  const restored = new ProjectDraftCache(async (id, value) => { writes.push([id, value]) }, () => {})
  assert.deepEqual(restored.recover('project-id'), { draft })
  await restored.flush()
  assert.deepEqual(writes, [['project-id', draft]])
  assert.equal(values.size, 0)
  restored.dispose()
})

test('a delayed cache acknowledgement does not lose a newer draft', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const writes = []
  const cache = new ProjectDraftCache(async (_id, draft) => { writes.push(draft); if (writes.length === 1) await gate }, () => {})
  const first = { name: 'First', graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, settings: {} }
  cache.stage('id', first)
  const writing = cache.flush('id')
  cache.stage('id', { ...first, name: 'Latest' })
  release()
  await writing
  assert.deepEqual(writes.map(draft => draft.name), ['First', 'Latest'])
  cache.dispose()
})

test('compact chat context excludes scripts; Host edits refresh and stale local drafts remain protected', async t => {
  const app = await fixture(t)
  const controller = app.controller
  await controller.createProject('Agent editing')
  controller.addText('Private synthetic script '.repeat(10000))
  await controller.prepareChatContext()
  const project = controller.getSnapshot().project
  const context = JSON.parse(controller.currentContext())
  assert.equal(context.canvas.nodeCount, 1)
  assert.equal(context.canvas.nodes, undefined)
  assert.ok(controller.currentContext().length < 1000)
  const call = async (name, revision) => {
    const result = await app.host.rpc('canvas/command', { projectId: project.id, sessionId: project.sessionId, command: 'edit', args: { expectedDraftRevision: revision, edits: [{ op: 'rename', name }] } })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value.draftRevision
  }
  const revision = await call('Agent draft', context.project.draftRevision)
  await controller.refreshCanvasFromHost()
  assert.equal(controller.getSnapshot().project.name, 'Agent draft')
  controller.renameProject('Human draft')
  await call('Newer agent draft', revision)
  await controller.refreshCanvasFromHost()
  assert.equal(controller.getSnapshot().conflict, true)
  assert.equal(controller.getSnapshot().project.name, 'Human draft')
  await assert.rejects(controller.prepareChatContext(), /changed/)
  assert.equal((await app.host.store.getProject(project.id)).draft.name, 'Newer agent draft')
  await controller.useHostCanvas()
  assert.equal(controller.getSnapshot().conflict, false)
  assert.equal(controller.getSnapshot().project.name, 'Newer agent draft')
})
