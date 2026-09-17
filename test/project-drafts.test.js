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
      bindings.set(id, { session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) } })
      return id
    },
    binding: id => bindings.get(id),
    open: id => { sessions.current = id },
  } }
  controller = new DirectorController(context)
  await controller.start()
  t.after(async () => {
    await controller.flushDrafts()
    controller.dispose()
    await host.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root, context, calls,
    get controller() { return controller },
    get host() { return host },
    async restart() {
      await controller.flushDrafts()
      controller.dispose()
      await host.close()
      host = await testHost(root)
      controller = new DirectorController(context)
      await controller.start()
      return controller
    },
  }
}

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
  assert.deepEqual(controller.getSnapshot().project, saved)
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
