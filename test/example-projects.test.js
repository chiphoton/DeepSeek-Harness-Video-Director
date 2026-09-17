import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { ExampleProjects } from '../src/example-projects.js'
import { testHost } from './fixtures/director-host.js'
import { randomUUID } from 'node:crypto'

test('examples are discovered from the plugin folder and cannot read arbitrary files or symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-examples-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'examples')
  const catalog = new ExampleProjects(directory)
  assert.deepEqual(await catalog.list(), [])
  await mkdir(directory)
  await writeFile(join(directory, 'z.video-director.json'), '{"example":"z"}')
  await writeFile(join(directory, 'a.video-director.json'), '{"example":"a"}')
  await writeFile(join(directory, 'notes.json'), 'Not a project archive')
  await writeFile(join(root, 'outside.video-director.json'), 'outside')
  await symlink(join(root, 'outside.video-director.json'), join(directory, 'linked.video-director.json'))
  await mkdir(join(directory, 'folder.video-director.json'))
  assert.deepEqual(await catalog.list(), [
    { id: 'a.video-director.json', name: 'a' }, { id: 'z.video-director.json', name: 'z' },
  ])
  assert.equal(await catalog.read('a.video-director.json'), '{"example":"a"}')
  for (const id of ['../outside.video-director.json', 'linked.video-director.json', 'notes.json', join(root, 'outside.video-director.json')]) {
    await assert.rejects(catalog.read(id), /Example project not found/u)
  }
})

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/client/controller.ts', import.meta.url))], bundle: true, platform: 'browser', format: 'esm', write: false })
const { DirectorController } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)

test('opening an example caches current edits and creates independent unsaved copies with no generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-open-example-'))
  const app = await testHost(root)
  const calls = []
  const rpc = async (channel, endpoint, payload = {}) => {
    calls.push([channel, endpoint])
    assert.equal(channel, '/video-director')
    return app.rpc(endpoint, payload)
  }
  const sessions = { current: undefined, byId: {} }
  const bindings = new Map()
  const ctx = { connection: { rpc: { call: rpc } }, sessions: {
    list: { getSnapshot: () => sessions, subscribe: () => () => {} },
    create: async () => {
      const id = randomUUID()
      sessions.byId[id] = { id }
      bindings.set(id, { session: { getSnapshot: () => ({}), rename: async title => ({ ok: true, value: { title, seq: 1 } }) } })
      return id
    },
    binding: id => bindings.get(id),
    open: id => { sessions.current = id },
  } }
  const controller = new DirectorController(ctx)
  t.after(async () => { controller.dispose(); await app.close(); await rm(root, { recursive: true, force: true }) })
  await controller.start()
  await controller.createProject('canvas-demo')
  const originalId = controller.getSnapshot().project.id
  controller.addText('Keep these unsaved edits')
  assert.equal(controller.getSnapshot().dirty, true)
  const examplePath = new URL('../examples/canvas-demo.video-director.json', import.meta.url)
  const originalArchive = await readFile(examplePath, 'utf8')
  const archive = JSON.parse(originalArchive)
  await controller.refreshExamples()
  assert.ok(controller.getSnapshot().examples.some(example => example.id === 'canvas-demo.video-director.json'))
  const beforeOpen = calls.length
  await controller.openExample('canvas-demo.video-director.json')
  const first = controller.getSnapshot().project
  assert.equal(first.name, 'canvas-demo (2)')
  assert.notEqual(first.id, originalId)
  assert.equal((await app.store.getProject(originalId)).draft.graph.nodes[0].data.text, 'Keep these unsaved edits')
  const openingCalls = calls.slice(beforeOpen).map(([, endpoint]) => endpoint)
  assert.equal(openingCalls.includes('projects/save'), false, 'Opening an example must not commit any workflow')
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal((await app.store.getProject(first.id)).hasSavedVersion, false)
  assert.equal(first.graph.nodes.length, archive.project.graph.nodes.length)
  assert.equal(first.graph.edges.length, archive.project.graph.edges.length)
  assert.deepEqual(first.jobs, [])
  const firstSketch = first.graph.nodes.find(node => node.data.kind === 'load-sketch').data.asset
  assert.equal(firstSketch.projectId, first.id)
  assert.notEqual(firstSketch.id, archive.assets[0].sourceId)
  assert.equal((await app.store.assetBytes(firstSketch.id)).data.toString('base64'), archive.assets[0].dataBase64)
  await controller.openExample('canvas-demo.video-director.json')
  const second = controller.getSnapshot().project
  assert.equal(second.name, 'canvas-demo (3)')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.notEqual(second.graph.nodes.find(node => node.data.kind === 'load-sketch').data.asset.id, firstSketch.id)
  assert.equal(await readFile(examplePath, 'utf8'), originalArchive)
  assert.equal(calls.some(([, endpoint]) => endpoint === 'jobs/start' || endpoint === 'start'), false)
  await controller.discardChanges(first.id)
  await assert.rejects(app.store.getProject(first.id), /not found/)
  assert.throws(() => app.store.asset(firstSketch.id), /not found/)
  assert.equal(controller.getSnapshot().project.id, second.id)
  assert.equal(controller.getSnapshot().dirty, true)
  await controller.saveProject()
  controller.renameProject('Unsaved example edit')
  await controller.discardChanges()
  assert.equal(controller.getSnapshot().project.name, second.name)
  assert.equal(controller.getSnapshot().dirty, false)
  const rejected = await rpc('/video-director', 'examples/get', { id: '../provider-settings.json' })
  assert.equal(rejected.ok, false)
})
