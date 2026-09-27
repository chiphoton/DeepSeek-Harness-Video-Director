import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../src/project-store.js'
import { hashAssetFile, migrateAssetLayout } from '../src/asset-layout.js'
import { createDirectorRpc } from '../src/rpc.js'

const extensions = new Map([['image/png', 'png'], ['audio/flac', 'flac'], ['video/mp4', 'mp4']])
const digest = data => createHash('sha256').update(data).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-asset-layout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  const first = await store.createProject({ name: 'One', sessionId: 'one' })
  const second = await store.createProject({ name: 'Two', sessionId: 'two' })
  const put = (name, data, extra = {}) => store.putAsset({ projectId: first.id, kind: 'image', mimeType: 'image/png', name, dataBase64: Buffer.from(data).toString('base64'), ...extra })
  return { root, store, first, second, put }
}

test('concurrent uploads share an original name by hash and walk numbered collisions across workflows', async t => {
  const { root, store, first, second, put } = await fixture(t)
  const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => put('example.png', `bytes-${i % 3}`, { projectId: i % 2 ? first.id : second.id })))
  // Different project locks can reach the shared asset writer in either order.
  assert.deepEqual(new Set(rows.map(row => row.filename)), new Set(['inputs/example.png', 'inputs/example-0001.png', 'inputs/example-0002.png']))
  for (const row of rows) assert.equal((await hashAssetFile(join(root, 'assets', row.filename))).sha256, row.sha256)
  const repeated = await put('example.png', 'bytes-2')
  assert.equal(repeated.filename, rows.find(row => row.sha256 === repeated.sha256).filename)
  assert.equal((await readdir(join(root, 'assets', 'inputs'))).filter(name => name.endsWith('.png')).length, 3)
  assert.equal(new Set(store.listAssets().map(row => row.id)).size, 11)
})

test('filename identity preserves Unicode and extensions, and never trusts path separators or symbolic links', async t => {
  const { root, put } = await fixture(t)
  const unicode = await put('海边 photo.PNG', 'a')
  assert.equal(unicode.filename, 'inputs/海边 photo.PNG')
  assert.equal((await put('海边 photo.png', 'b')).filename, 'inputs/海边 photo-0001.png')
  assert.equal((await put('../../outside.png', 'a')).filename, 'inputs/outside.png')
  assert.equal((await put('C:\\folder\\inside.png', 'b')).filename, 'inputs/inside.png')
  const outside = join(root, 'do-not-touch.png')
  await writeFile(outside, 'secret fixture')
  await symlink(outside, join(root, 'assets', 'inputs', 'linked.png'))
  await assert.rejects(put('linked.png', 'new'), /non-file or symbolic link/)
  assert.equal(await readFile(outside, 'utf8'), 'secret fixture')
})

test('outputs retain provider download names; masks and sketches get dated names in their own folders', async t => {
  const { root, store, put } = await fixture(t)
  const output = await put('ComfyUI_00042_.png', 'rendered', { origin: 'output' })
  assert.match(output.filename, /^outputs\/\d{8}-[a-f0-9-]{36}\.png$/)
  const response = await store.assetResponse(output.id, new Request('http://local/asset', { method: 'HEAD' }))
  assert.match(response.headers.get('Content-Disposition'), /ComfyUI_00042_\.png/)
  for (const kind of ['mask', 'sketch']) {
    const asset = await put('untitled.png', kind, { kind })
    assert.match(asset.filename, new RegExp(`^inputs/${kind}/${kind}-\\d{8}-[a-f0-9]{8}\\.png$`))
    assert.equal(asset.origin, 'input')
  }
  const reloaded = new ProjectStore(root, 1024 * 1024); await reloaded.init()
  assert.equal(reloaded.asset(output.id).name, 'ComfyUI_00042_.png')
  assert.equal(reloaded.asset(output.id).origin, 'output')
})

test('asset list filters by node type, includes outputs, collapses aliases and prefers the requesting owner', async t => {
  const { store, first, second, put } = await fixture(t)
  const image = await put('source.png', 'image')
  const alias = await store.linkAsset(second.id, image.id)
  const output = await put('render.png', 'render', { origin: 'output' })
  await put('sketch.png', 'sketch', { kind: 'sketch' })
  const rpc = createDirectorRpc({ store, registerAsset: async () => {} })
  const result = await rpc('assets/list', { kind: 'image', projectId: second.id })
  assert.equal(result.ok, true)
  assert.deepEqual(new Set(result.value.assets.map(row => row.id)), new Set([alias.id, output.id]))
  assert.deepEqual(store.availableAssets('image', first.id).find(row => row.sha256 === image.sha256), image)
  assert.equal(store.availableAssets('sketch').length, 1)
  assert.equal((await rpc('assets/list', { kind: '../../' })).ok, false)
})

test('deleting an owner concurrently with another upload cannot remove newly shared bytes', async t => {
  const { store, first, second, put } = await fixture(t)
  await put('shared.png', 'same')
  const [, survivor] = await Promise.all([store.deleteProject(first.id), put('shared.png', 'same', { projectId: second.id })])
  assert.equal((await store.assetBytes(survivor.id)).data.toString(), 'same')
})

test('a failed index commit removes newly written bytes but never removes already shared bytes', async t => {
  const { root, store, put } = await fixture(t)
  const original = await put('shared.png', 'same')
  store.assetsIndexPath = join(root, 'missing', 'index.json')
  await assert.rejects(put('new.png', 'new'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(root, 'assets', 'inputs', 'new.png')), { code: 'ENOENT' })
  await assert.rejects(put('shared.png', 'same'), { code: 'ENOENT' })
  assert.equal((await store.assetBytes(original.id)).data.toString(), 'same')
})

async function legacyFixture(t) {
  const { root, store, first, second } = await fixture(t)
  const make = async (name, data, kind = 'image', owner = first.id) => {
    const id = randomUUID()
    const row = { id, projectId: owner, kind, name, mimeType: 'image/png', filename: `${id}.png`, size: Buffer.byteLength(data), sha256: digest(data), createdAt: '2026-09-20T23:59:00.000Z', url: `/api/video-director/assets/${id}` }
    await writeFile(join(root, 'assets', row.filename), data)
    return row
  }
  const image = await make('example.png', 'image')
  const same = await make('example.png', 'image', 'image', second.id)
  const collision = await make('example.png', 'other')
  const generated = await make('ComfyUI.png', 'output')
  const sketch = await make('old-sketch.png', 'drawing', 'sketch')
  const mask = await make('old-mask.png', 'mask', 'mask')
  const aliasId = randomUUID()
  const alias = { ...generated, id: aliasId, blobId: generated.id, projectId: second.id, url: `/api/video-director/assets/${aliasId}` }
  const rows = [image, same, collision, generated, sketch, mask, alias]
  await writeFile(join(root, 'assets', 'index.json'), JSON.stringify(rows))
  // PREVIEW and INPUT references alone must not classify media as generated.
  const project = { ...first, jobs: [{ id: randomUUID(), nodeId: 'generator', providerId: 'comfy', result: { kind: 'assets', assets: [generated] } }], graph: { ...first.graph, nodes: [
    { id: 'input', data: { kind: 'load-image', asset: image } },
    { id: 'preview', data: { kind: 'preview', result: { kind: 'assets', assets: [image] } } },
  ] } }
  await writeFile(join(root, 'projects', first.id, 'project.json'), JSON.stringify(project))
  return { root, store, first, rows, image, same, generated, sketch, mask }
}

test('legacy migration uses only metadata and hashes, preserves IDs and links, and deduplicates inputs', async t => {
  const { root, rows, first, image, same, generated } = await legacyFixture(t)
  const before = await readFile(join(root, 'assets', 'index.json'), 'utf8')
  const preview = await migrateAssetLayout(root, rows, extensions, { dryRun: true })
  assert.equal(await readFile(join(root, 'assets', 'index.json'), 'utf8'), before)
  assert.equal(preview.report.sharedFilesRemoved, 1)
  const store = new ProjectStore(root, 1024 * 1024); await store.init()
  assert.equal(store.asset(image.id).filename, 'inputs/example.png')
  assert.equal(store.asset(same.id).filename, 'inputs/example.png')
  assert.equal(store.asset(generated.id).filename, `outputs/20260920-${generated.id}.png`)
  const hydrated = await store.getProject(first.id)
  assert.equal(hydrated.graph.nodes[0].data.asset.origin, 'input')
  assert.equal(hydrated.jobs[0].result.assets[0].origin, 'output')
  for (const row of rows) {
    assert.equal(store.asset(row.id).url, row.url)
    assert.equal((await hashAssetFile(join(root, 'assets', store.asset(row.id).filename))).sha256, row.sha256)
    await assert.rejects(readFile(join(root, 'assets', row.filename)), { code: 'ENOENT' })
  }
  const journal = JSON.parse(await readFile(join(root, 'migrations', 'asset-layout-v2.json')))
  assert.ok(journal.completedAt)
  assert.deepEqual(journal.originalIndex, rows)
  const again = new ProjectStore(root, 1024 * 1024); await again.init()
  assert.deepEqual(again.listAssets(), store.listAssets())
})

for (const committed of [false, true]) test(`migration resumes after interruption ${committed ? 'after' : 'before'} index commit`, async t => {
  const { root, rows } = await legacyFixture(t)
  await assert.rejects(migrateAssetLayout(root, rows, extensions, { commitIndex: async assets => {
    if (committed) await writeFile(join(root, 'assets', 'index.json'), JSON.stringify(assets))
    throw new Error('simulated interruption')
  } }), /simulated interruption/)
  for (const row of rows) assert.equal((await hashAssetFile(join(root, 'assets', row.filename))).sha256, row.sha256)
  const store = new ProjectStore(root, 1024 * 1024); await store.init()
  assert.equal(store.listAssets().length, rows.length)
  for (const row of rows) {
    assert.equal((await hashAssetFile(join(root, 'assets', store.asset(row.id).filename))).sha256, row.sha256)
    await assert.rejects(readFile(join(root, 'assets', row.filename)), { code: 'ENOENT' })
  }
})

test('hash mismatch aborts migration without changing any source or index', async t => {
  const { root, rows } = await legacyFixture(t)
  const index = await readFile(join(root, 'assets', 'index.json'), 'utf8')
  await writeFile(join(root, 'assets', rows.at(-1).filename), 'changed outside app')
  const store = new ProjectStore(root, 1024 * 1024)
  await assert.rejects(store.init(), /failed hash verification/)
  assert.equal(await readFile(join(root, 'assets', 'index.json'), 'utf8'), index)
  for (const row of rows) await readFile(join(root, 'assets', row.filename))
  await assert.rejects(readFile(join(root, 'migrations', 'asset-layout-v2.json')), { code: 'ENOENT' })
})
