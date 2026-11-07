import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { testHost } from './fixtures/director-host.js'

const runFile = promisify(execFile)
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(command => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0)

test('canvas media samples one scoped clip into a chronological contact sheet', { skip: !hasFfmpeg }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'vd-tile-test-'))
  const host = await testHost(join(root, 'data'))
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  const clip = join(root, 'swatches.mp4')
  await runFile('ffmpeg', ['-v', 'error', '-y', ...['red', 'lime', 'blue'].flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=6:d=1`]),
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'mpeg4', '-threads', '1', clip])
  const p = await host.store.createProject({ name: 'Synthetic tile test', sessionId: 'tile' })
  const q = await host.store.createProject({ name: 'Other synthetic workflow', sessionId: 'other' })
  const video = await host.store.putAsset({ projectId: p.id, name: 'swatches.mp4', kind: 'video', mimeType: 'video/mp4', dataBase64: (await readFile(clip)).toString('base64') })
  const args = { assetId: video.id, operation: 'video-contact-sheet', options: { frameCount: 3, columns: 3 } }
  const canvas = (project, params = {}, protocol) => host.rpc('canvas/command', { projectId: project.id, sessionId: project.sessionId, protocol, command: 'media', args: { ...args, ...params } })
  assert.equal((await canvas(p, {}, 'vd/1')).error.code, 'video-director/content-not-shared')
  assert.equal((await canvas(q)).ok, false)
  assert.equal((await canvas(p, { options: { frameCount: 10 } })).ok, false)
  const result = await canvas(p)
  assert.ok(result.ok, result.error?.message)
  const { asset, times, rows, columns } = result.value
  assert.deepEqual({ times, rows, columns }, { times: [.5, 1.5, 2.5], rows: 1, columns: 3 })
  assert.equal(asset.kind, 'image')
  assert.equal(asset.origin, 'output')
  assert.equal(asset.projectId, p.id)
  const reserve = project => host.rpc('chat/references', { projectId: project.id, sessionId: project.sessionId,
    action: 'reserve', id: randomUUID(), kind: 'image', name: asset.name, assetId: asset.id })
  assert.equal((await reserve(q)).ok, false)
  const linked = await reserve(p)
  assert.ok(linked.ok, linked.error?.message)
  assert.equal(linked.value.entry.ready, true)
  assert.equal(linked.value.entry.files[0].assetId, asset.id)
  assert.equal(host.store.listAssets().length, 2, 'chat references the existing sheet without a new asset upload')
  const png = join(host.store.assetsDir, host.store.asset(asset.id).filename)
  for (const [index, channel] of [0, 1, 2].entries()) {
    const { stdout } = await runFile('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${200 + index * 392}:120`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })
    assert.ok(stdout[channel] > 200 && [...stdout].every((value, j) => j === channel || value < 30), `tile ${index + 1} must match its source interval`)
  }
})
