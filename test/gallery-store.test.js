import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../src/project-store.js'
import { createDirectorRpc } from '../src/rpc.js'

test('gallery RPC includes saved and unsaved workflows, cached drafts and old results without configuration or canvas mutations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vd-gallery-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024)
  await store.init()
  let first = await store.createProject({ name: 'First', sessionId: 'first-session' })
  const second = await store.createProject({ name: 'Second', sessionId: 'second-session', unsaved: true })
  const asset = await store.putAsset({ projectId: first.id, kind: 'image', name: 'result.png', mimeType: 'image/png', dataBase64: Buffer.from('fixture').toString('base64') })
  first = await store.saveProject(first.id, { ...first, settings: { secret: 'private-settings' }, graph: {
    ...first.graph, nodes: [{ id: 'image', position: { x: 5, y: 10 }, data: { kind: 'load-image', title: 'Reference', asset, workflow: { apiKey: 'private-workflow' } } }],
  }, jobs: [{ id: 'old-job', nodeId: 'deleted-node', operation: 'image-generation', createdAt: first.createdAt, result: { kind: 'assets', assets: [asset] }, request: { secret: 'private-request' } }] }, first.revision)
  await store.cacheDraft(second.id, { name: 'Second unsaved', settings: second.settings, graph: {
    ...second.graph, nodes: [{ id: 'text', data: { kind: 'load-text', title: 'Notes', text: 'Unsaved contents' } }],
  } })
  const before = await store.getProject(first.id)
  const rpc = createDirectorRpc({ store, providers: {}, jobs: {}, workflows: {} })
  const result = await rpc('gallery/list', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.projects.length, 2)
  const saved = result.value.projects.find(p => p.id === first.id)
  const draft = result.value.projects.find(p => p.id === second.id)
  assert.equal(saved.graph.nodes[0].data.asset.id, asset.id)
  assert.equal(saved.jobs[0].result.assets[0].id, asset.id)
  assert.equal(draft.name, 'Second unsaved')
  assert.equal(draft.graph.nodes[0].data.text, 'Unsaved contents')
  assert.doesNotMatch(JSON.stringify(result), /private-settings|private-workflow|private-request|position|sessionId/)
  assert.deepEqual(await store.getProject(first.id), before)
  const reopened = new ProjectStore(root, 1024)
  await reopened.init()
  assert.deepEqual(await reopened.galleryProjects(), result.value.projects)
  await store.deleteProject(first.id)
  assert.deepEqual((await store.galleryProjects()).map(p => p.id), [second.id])
})

test('gallery listing respects request cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vd-gallery-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024)
  await store.init()
  await store.createProject({ name: 'Abort', sessionId: 'session' })
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(store.galleryProjects(abort.signal), { name: 'AbortError' })
})
