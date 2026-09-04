import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProjectStore } from '../src/project-store.js'

async function createStore(t, maxAssetBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-director-store-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new ProjectStore(root, maxAssetBytes)
  await store.init()
  return { root, store }
}

test('ProjectStore keeps project identity and rejects stale revisions', async (t) => {
  const { store } = await createStore(t)
  const created = await store.createProject({ name: 'First cut', sessionId: 'session-original' })

  const saved = await store.saveProject(created.id, {
    ...created,
    name: 'Second cut',
    sessionId: 'session-tampered',
    createdAt: '2000-01-01T00:00:00.000Z',
  }, created.revision)

  assert.equal(saved.revision, 2)
  assert.equal(saved.name, 'Second cut')
  assert.equal(saved.sessionId, created.sessionId)
  assert.equal(saved.createdAt, created.createdAt)

  await assert.rejects(
    store.saveProject(created.id, { ...saved, name: 'Stale edit' }, created.revision),
    (error) => {
      assert.equal(error.code, 'video-director/revision-conflict')
      assert.deepEqual(error.details, { expectedRevision: 1, currentRevision: 2 })
      return true
    },
  )

  assert.equal((await store.getProject(created.id)).name, 'Second cut')
})

test('ProjectStore force-saves local editable state while preserving current runtime state', async (t) => {
  const { store } = await createStore(t)
  const created = await store.createProject({ name: 'Original cut', sessionId: 'session-original' })
  const remoteJob = { id: 'remote-job', status: 'running' }
  const remote = await store.updateProject(created.id, {
    name: 'Remote cut',
    status: 'running',
    jobs: [remoteJob],
    settings: { owner: 'remote' },
  })
  const localGraph = {
    nodes: [{ id: 'local-node' }],
    edges: [],
    viewport: { x: 80, y: -20, zoom: 1.2 },
  }

  const forced = await store.forceSaveProject(created.id, {
    ...created,
    name: 'Local cut',
    graph: localGraph,
    settings: { owner: 'local' },
    status: 'error',
    jobs: [{ id: 'stale-job', status: 'failed' }],
  })

  assert.equal(forced.revision, remote.revision + 1)
  assert.equal(forced.name, 'Local cut')
  assert.deepEqual(forced.graph, localGraph)
  assert.deepEqual(forced.settings, { owner: 'local' })
  assert.equal(forced.status, 'running')
  assert.deepEqual(forced.jobs, [remoteJob])
  assert.equal(forced.sessionId, created.sessionId)
})

test('ProjectStore replaces a project Session without changing its canvas', async (t) => {
  const { store } = await createStore(t)
  const created = await store.createProject({ name: 'Session cut', sessionId: 'session-original' })
  const saved = await store.saveProject(created.id, {
    ...created,
    graph: { ...created.graph, viewport: { x: 120, y: -40, zoom: 1.25 } },
    settings: { ...created.settings, custom: true },
  }, created.revision)

  const rebound = await store.replaceProjectSession(created.id, 'session-new')

  assert.equal(rebound.sessionId, 'session-new')
  assert.equal(rebound.revision, saved.revision + 1)
  assert.deepEqual(rebound.graph, saved.graph)
  assert.deepEqual(rebound.settings, saved.settings)
})

test('ProjectStore serializes compare-and-swap writes for one project', async (t) => {
  const { store } = await createStore(t)
  const created = await store.createProject({ name: 'Concurrent cut', sessionId: 'session-concurrent' })

  const results = await Promise.allSettled([
    store.saveProject(created.id, { ...created, name: 'Window A' }, created.revision),
    store.saveProject(created.id, { ...created, name: 'Window B' }, created.revision),
  ])

  const fulfilled = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'video-director/revision-conflict')
  const current = await store.getProject(created.id)
  assert.equal(current.revision, 2)
  assert.equal(current.name, fulfilled[0].value.name)
})

test('ProjectStore writes immutable, content-hashed copies without overwriting earlier assets', async (t) => {
  const { root, store } = await createStore(t)
  const project = await store.createProject({ name: 'Assets', sessionId: 'session-assets' })
  const bytes = Buffer.from('immutable-video-director-asset')
  const input = {
    projectId: project.id,
    kind: 'image',
    name: 'reference.png',
    mimeType: 'image/png',
    dataBase64: bytes.toString('base64'),
  }

  const [first, second] = await Promise.all([store.putAsset(input), store.putAsset(input)])

  assert.notEqual(first.id, second.id)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual((await store.assetBytes(first.id)).data, bytes)
  assert.deepEqual((await store.assetBytes(second.id)).data, bytes)
  assert.deepEqual(await readFile(join(root, 'assets', first.filename)), bytes)
  assert.deepEqual(await readFile(join(root, 'assets', second.filename)), bytes)

  const reloaded = new ProjectStore(root, 1024 * 1024)
  await reloaded.init()
  assert.deepEqual(reloaded.listAssets().map(asset => asset.id).sort(), [first.id, second.id].sort())
})

test('ProjectStore deletes only one project and its independently owned assets', async (t) => {
  const { root, store } = await createStore(t)
  const doomed = await store.createProject({ name: 'Delete me', sessionId: 'session-delete' })
  const survivor = await store.createProject({ name: 'Keep me', sessionId: 'session-keep' })
  const bytes = Buffer.from('identical-content-does-not-mean-shared-storage')
  const assetInput = {
    kind: 'image',
    name: 'same.png',
    mimeType: 'image/png',
    dataBase64: bytes.toString('base64'),
  }
  const doomedAsset = await store.putAsset({ ...assetInput, projectId: doomed.id })
  const survivorAsset = await store.putAsset({ ...assetInput, projectId: survivor.id })

  assert.notEqual(doomedAsset.filename, survivorAsset.filename)
  assert.equal(doomedAsset.sha256, survivorAsset.sha256)
  assert.deepEqual(await store.deleteProject(doomed.id), {
    projectId: doomed.id,
    deletedAssetCount: 1,
  })

  await assert.rejects(store.getProject(doomed.id), { code: 'video-director/project-not-found' })
  await assert.rejects(Promise.resolve().then(() => store.asset(doomedAsset.id)), {
    code: 'video-director/asset-not-found',
  })
  await assert.rejects(readFile(join(root, 'assets', doomedAsset.filename)), { code: 'ENOENT' })
  assert.equal((await store.getProject(survivor.id)).name, 'Keep me')
  assert.deepEqual((await store.assetBytes(survivorAsset.id)).data, bytes)

  const reloaded = new ProjectStore(root, 1024 * 1024)
  await reloaded.init()
  assert.deepEqual(reloaded.listAssets().map(asset => asset.id), [survivorAsset.id])
  assert.deepEqual((await reloaded.listProjects()).map(project => project.id), [survivor.id])
})

test('ProjectStore serializes asset creation with deletion and rejects active-job deletion', async (t) => {
  const { store } = await createStore(t)
  const project = await store.createProject({ name: 'Serialized delete', sessionId: 'session-serialized-delete' })
  const put = store.putAsset({
    projectId: project.id,
    kind: 'audio',
    name: 'queued.wav',
    mimeType: 'audio/wav',
    dataBase64: Buffer.from('queued-asset').toString('base64'),
  })
  const deletion = store.deleteProject(project.id)
  const [asset, deleted] = await Promise.all([put, deletion])

  assert.equal(deleted.deletedAssetCount, 1)
  assert.equal(asset.projectId, project.id)
  assert.deepEqual(store.listAssets(), [])
  await assert.rejects(store.getProject(project.id), { code: 'video-director/project-not-found' })

  const busy = await store.createProject({ name: 'Busy', sessionId: 'session-busy' })
  await store.updateProject(busy.id, {
    status: 'running',
    jobs: [{ id: 'active-job', status: 'running' }],
  })
  await assert.rejects(store.deleteProject(busy.id), (error) => {
    assert.equal(error.code, 'video-director/project-busy')
    assert.deepEqual(error.details, { projectId: busy.id, activeJobIds: ['active-job'] })
    return true
  })
  assert.equal((await store.getProject(busy.id)).name, 'Busy')

  await assert.rejects(store.deleteProject('../project.json'), {
    code: 'video-director/invalid-input',
  })
  assert.equal((await store.getProject(busy.id)).name, 'Busy')
})

test('ProjectStore serves full, partial, HEAD, and invalid asset ranges', async (t) => {
  const { store } = await createStore(t)
  const project = await store.createProject({ name: 'Ranges', sessionId: 'session-ranges' })
  const bytes = Buffer.from('0123456789')
  const asset = await store.putAsset({
    projectId: project.id,
    kind: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    dataBase64: bytes.toString('base64'),
  })

  const full = await store.assetResponse(asset.id, new Request('http://local.test/asset'))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(full.headers.get('content-length'), '10')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes)

  const partial = await store.assetResponse(asset.id, new Request('http://local.test/asset', {
    headers: { Range: 'bytes=2-5' },
  }))
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(partial.headers.get('content-length'), '4')
  assert.equal(await partial.text(), '2345')

  const head = await store.assetResponse(asset.id, new Request('http://local.test/asset', {
    method: 'HEAD',
    headers: { Range: 'bytes=0-0' },
  }))
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-range'), 'bytes 0-0/10')
  assert.equal(await head.text(), '')

  const invalid = await store.assetResponse(asset.id, new Request('http://local.test/asset', {
    headers: { Range: 'bytes=9-2' },
  }))
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), 'bytes */10')
})
