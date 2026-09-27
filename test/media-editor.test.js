import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../src/project-store.js'
import { createDirectorRpc } from '../src/rpc.js'
import { readVideoProperties, videoPropertiesFromProbe } from '../src/video-properties.js'

const exec = promisify(execFile)

test('Media Editor renders trim and crop together, exports without importing, and preserves shared originals on save/copy', async t => {
  try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']) }
  catch (error) { if (error.code === 'ENOENT') return t.skip('FFmpeg is not installed'); throw error }
  const root = await mkdtemp(join(tmpdir(), 'vd-editor-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 20 * 1024 * 1024); await store.init()
  const project = await store.createProject({ name: 'Media Editor', sessionId: 'editor' })
  const other = await store.createProject({ name: 'Linked workflow', sessionId: 'other' })
  const file = join(root, 'source.mp4')
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', file])
  const sourceBytes = await readFile(file)
  const source = await store.putAsset({ projectId: project.id, kind: 'video', name: 'source.mp4', mimeType: 'video/mp4', dataBase64: sourceBytes.toString('base64') })
  const alias = await store.linkAsset(other.id, source.id)
  const registered = []
  const rpc = createDirectorRpc({ store, registerAsset: async asset => registered.push(asset.id) })
  const edit = { start: .5, end: 1.5, crop: { x: 16, y: 12, width: 80, height: 60 } }
  const call = (action, options = edit, asset = source, owner = project.id, signal) => rpc('media/edit', { projectId: owner, assetId: asset.id, action, edit: options }, signal)
  const exported = await call('export')
  assert.equal(exported.ok, true, JSON.stringify(exported.error))
  assert.equal(store.listAssets().length, 2)
  assert.equal(registered.length, 0)
  const exportedPath = join(root, 'export.mp4')
  await writeFile(exportedPath, Buffer.from(exported.value.dataBase64, 'base64'))
  const info = await readVideoProperties(exportedPath, 'video/mp4')
  assert.deepEqual([info.width, info.height], [80, 60])
  assert.ok(Math.abs(info.duration - 1) < .1)
  assert.ok(info.metadata.some(row => row.name.startsWith('audio') && row.name.endsWith('Codec')))
  for (const action of ['save', 'copy']) {
    const result = await call(action)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.notEqual(result.value.asset.id, source.id)
    assert.equal(result.value.asset.name, action === 'save' ? 'source.mp4' : 'source-copy.mp4')
    assert.ok(registered.includes(result.value.asset.id))
    assert.equal((await store.assetBytes(source.id)).data.equals(sourceBytes), true)
    assert.equal((await store.assetBytes(alias.id)).data.equals(sourceBytes), true)
  }
  const count = store.listAssets().length
  const frame = await call('frame', { ...edit, time: .75 })
  assert.equal(frame.ok, true, JSON.stringify(frame.error))
  assert.equal(frame.value.mimeType, 'image/png')
  assert.equal(Buffer.from(frame.value.dataBase64, 'base64').subarray(1, 4).toString(), 'PNG')
  assert.equal(store.listAssets().length, count)
  const audioPath = join(root, 'source.flac')
  await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', audioPath])
  const audio = await store.putAsset({ projectId: project.id, kind: 'audio', name: 'take.flac', mimeType: 'audio/flac', dataBase64: (await readFile(audioPath)).toString('base64') })
  const trimmed = await call('save', { start: .2, end: 1.2 }, audio)
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed.error))
  const audioInfo = await store.videoProperties(trimmed.value.asset.id)
  assert.ok(Math.abs(audioInfo.duration - 1) < .02)
  assert.equal(audioInfo.sampleRate, 32000)
  assert.equal((await call('save', edit, audio)).ok, false)
  assert.equal((await call('export', edit, source, other.id)).ok, false)
  assert.equal((await call('save', { start: 1, end: .5 })).ok, false)
  assert.equal((await call('save', { ...edit, crop: { x: 150, y: 0, width: 80, height: 60 } })).ok, false)
  assert.equal((await call('save', { ...edit, crop: { x: 0, y: 0, width: 81, height: 60 } })).ok, false)
  const cancelled = new AbortController(); cancelled.abort()
  const beforeCancel = store.listAssets().length
  assert.equal((await call('save', edit, source, project.id, cancelled.signal)).ok, false)
  assert.equal(store.listAssets().length, beforeCancel)
})

test('crop dimensions follow the displayed orientation of rotated video', () => {
  const info = videoPropertiesFromProbe({ streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: '2' } }, 'video/mp4')
  assert.deepEqual([info.width, info.height], [1080, 1920])
})
