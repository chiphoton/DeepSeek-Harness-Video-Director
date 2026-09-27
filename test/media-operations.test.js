import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../src/project-store.js'
import { JobManager } from '../src/jobs.js'
import { ProviderRuntime } from '../src/providers.js'
import { ComfyWorkflowStore } from '../src/workflow-store.js'
import { VdNodeRegistry } from '../src/node-registry.js'
import { createDirectorRpc } from '../src/rpc.js'
import { audioPropertiesFromProbe, readVideoProperties } from '../src/video-properties.js'

const exec = promisify(execFile)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 20 * 1024 * 1024); await store.init()
  const project = await store.createProject({ name: 'Video tools', sessionId: 'test' })
  return { root, store, project }
}

test('duplicate asset aliases share one file, survive reload and deletion in either order', async t => {
  const { store, root, project } = await fixture(t)
  const copy = await store.createProject({ name: 'Copy', sessionId: 'copy' })
  const third = await store.createProject({ name: 'Third', sessionId: 'third' })
  const asset = await store.putAsset({ projectId: project.id, kind: 'image', name: 'source.png', mimeType: 'image/png', dataBase64: Buffer.from('immutable').toString('base64') })
  const alias = await store.linkAsset(copy.id, asset.id)
  const nested = await store.linkAsset(third.id, alias.id)
  assert.notEqual(alias.id, asset.id)
  assert.equal(alias.filename, asset.filename)
  assert.equal((await readdir(join(store.assetsDir, 'inputs'))).filter(name => name.endsWith('.png')).length, 1)
  const reopened = new ProjectStore(root, store.maxAssetBytes); await reopened.init()
  await reopened.deleteProject(copy.id)
  await reopened.deleteProject(project.id)
  assert.equal((await reopened.assetBytes(nested.id)).data.toString(), 'immutable')
  await reopened.deleteProject(third.id)
  assert.deepEqual(await readdir(join(store.assetsDir, 'inputs')), ['mask', 'sketch'])
  assert.deepEqual(await readdir(join(store.assetsDir, 'outputs')), [])
})

test('audio metadata includes duration, codec, sample rate, channels and embedded tags without host paths', () => {
  const properties = audioPropertiesFromProbe({ format: { filename: '/private/file.wav', duration: '2.5', format_name: 'wav', tags: { title: 'Voice take' } },
    streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, bit_rate: '1536000' }] }, 'audio/wav')
  assert.equal(properties.duration, 2.5)
  assert.equal(properties.sampleRate, 48000)
  assert.equal(properties.channels, 2)
  assert.equal(properties.codec, 'pcm_s16le')
  assert.ok(properties.metadata.some(row => row.value === 'Voice take'))
  assert.ok(!JSON.stringify(properties).includes('/private'))
})

test('FFmpeg nodes execute through RPC and the job queue, retaining audio and producing reusable assets', async t => {
  try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']) }
  catch (error) { if (error.code === 'ENOENT') return t.skip('FFmpeg is not installed'); throw error }
  const { root, store, project } = await fixture(t)
  const clip = join(root, 'source.mp4')
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', clip])
  const source = await store.putAsset({ projectId: project.id, kind: 'video', name: 'source.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(clip)).toString('base64') })
  const workflows = new ComfyWorkflowStore(root); await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const providers = new ProviderRuntime({ store, providers: [], registerAsset: async () => {} })
  const jobs = new JobManager(store, providers)
  const rpc = createDirectorRpc({ store, workflows, nodes, jobs, providers, registerAsset: async () => {} })
  const run = async (operation, mediaOptions) => {
    const definition = nodes.get(`core.${operation}`, '1.0.0')
    const result = await rpc('jobs/start', { projectId: project.id, nodeId: 'transient', clientRunId: crypto.randomUUID(), snapshot: {
      version: 1, sourceRevision: 1, nodeType: definition.type, nodeVersion: definition.version, nodeDigest: definition.digest,
      request: { operation, providerId: 'ffmpeg', mediaOptions, mediaInputs: [{ targetPortId: 'video', assetId: source.id }] },
    } })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    for (let i = 0; i < 1000; i++) {
      const job = await jobs.get(project.id, result.value.job.id)
      if (!['queued', 'running'].includes(job.status)) return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('FFmpeg job did not finish')
  }
  const trim = await run('video-trim', { start: .5, end: 1.5 })
  assert.equal(trim.status, 'completed', trim.error)
  const trimmed = await store.videoProperties(trim.result.assets[0].id)
  assert.ok(Math.abs(trimmed.duration - 1) < .1)
  assert.ok(trimmed.metadata.some(row => row.name.includes('audio') && row.name.endsWith('Codec')))
  const crop = await run('video-crop', { x: 16, y: 12, width: 80, height: 60 })
  assert.equal(crop.status, 'completed', crop.error)
  const cropped = await store.videoProperties(crop.result.assets[0].id)
  assert.deepEqual([cropped.width, cropped.height], [80, 60])
  const frame = await run('video-extract-frame', { time: .75 })
  assert.equal(frame.status, 'completed', frame.error)
  assert.equal(frame.result.assets[0].kind, 'image')
  assert.equal((await store.assetBytes(frame.result.assets[0].id)).data.subarray(1, 4).toString(), 'PNG')
  const invalid = await run('video-crop', { x: 100, width: 80, height: 60 })
  assert.equal(invalid.status, 'failed')
  assert.match(invalid.error, /bounds/)
  const audio = join(root, 'sample.wav')
  await exec('ffmpeg', ['-v', 'error', '-i', clip, '-vn', '-metadata', 'title=Audio metadata fixture', audio])
  const metadata = await readVideoProperties(audio, 'audio/wav')
  assert.equal(metadata.sampleRate, 48000)
  assert.ok(metadata.metadata.some(row => row.value === 'Audio metadata fixture'))
})
