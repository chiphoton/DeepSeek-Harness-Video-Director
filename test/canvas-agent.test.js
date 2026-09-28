import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { testHost } from './fixtures/director-host.js'
import { canvasTool } from '../src/canvas-agent.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-chat-test-'))
  const host = await testHost(root)
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  const project = await host.store.createProject({ name: 'Synthetic chat canvas', sessionId: 'test-chat' })
  const rpc = async (endpoint, payload) => {
    const result = await host.rpc(endpoint, payload)
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
    return result.value
  }
  const command = (command, args = {}) => rpc('canvas/command', { projectId: project.id, sessionId: project.sessionId, command, args })
  const reference = args => rpc('chat/references', { projectId: project.id, sessionId: project.sessionId, ...args })
  return { root, host, project, rpc, command, reference }
}

test('Host canvas queries are scoped, paged and compact; edits are transactional and compare draft revisions', async t => {
  const { host, project, command, rpc } = await fixture(t)
  const initial = await command('summary')
  assert.equal(initial.draftRevision, 0)
  assert.ok((await command('help')).commands.edit)
  await command('edit', { expectedDraftRevision: 0, edits: [
    { op: 'add', kind: 'load-text', id: 'script', data: { text: 'Long script '.repeat(10000) } },
    { op: 'add', type: 'core.preview', id: 'preview' },
    { op: 'connect', source: 'script', target: 'preview' },
  ] })
  const summary = await command('summary')
  assert.equal(summary.draftRevision, 1)
  assert.equal(summary.nodeCount, 2)
  assert.ok(JSON.stringify(summary).length < 400)
  assert.equal((await command('nodes', { limit: 1 })).nextOffset, 1)
  assert.equal((await command('node', { id: 'script', fields: ['text'] })).data.text.excerpt.length, 8000)
  assert.ok(JSON.stringify(await command('nodes')).length < 1000)
  await assert.rejects(command('edit', { expectedDraftRevision: 1, edits: [{ op: 'remove', id: 'script' }, { op: 'move', id: 'missing', position: { x: 0, y: 0 } }] }), /Unknown node/)
  assert.equal((await command('summary')).nodeCount, 2)
  await assert.rejects(rpc('projects/draft', { projectId: project.id, expectedDraftRevision: 0, draft: project }), error => error.code === 'video-director/draft-conflict')
  await assert.rejects(rpc('projects/discard', { projectId: project.id, expectedDraftRevision: 0 }), error => error.code === 'video-director/draft-conflict')
  await assert.rejects(command('save', {}), /expectedDraftRevision/)
  const races = await Promise.allSettled(['one', 'two'].map(name => command('edit', { expectedDraftRevision: 1, edits: [{ op: 'rename', name }] })))
  assert.equal(races.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(races.find(row => row.status === 'rejected').reason.code, 'video-director/draft-conflict')
  await assert.rejects(rpc('canvas/command', { projectId: project.id, sessionId: 'different-chat', command: 'nodes' }), /owning chat/)
  const tool = canvasTool(host)
  await assert.rejects(tool.execute({ projectId: project.id, command: 'summary' }, {}), /owning chat/)
  assert.equal((await tool.execute({ projectId: project.id, command: 'summary', sessionId: 'spoofed' }, { agent: { session: { id: project.sessionId } } })).draftRevision, 2)
  assert.equal((await command('definition', { type: 'core.preview' })).behavior, 'preview')
})

test('attachment aliases survive Host restart, preserve filenames, and expose folders on demand', async t => {
  const { root, host, project, command, reference } = await fixture(t)
  const entries = await Promise.all([1, 2].map(index => reference({ action: 'reserve', id: randomUUID(), kind: 'image', name: `original ${index}.png`, files: [{ name: `original ${index}.png`, mimeType: 'image/png', size: 3 }] })))
  assert.deepEqual(entries.map(row => row.entry.alias), ['<Image 1>', '<Image 2>'])
  const { entry } = await reference({ action: 'upload', id: entries[0].entry.id, fileIndex: 0, dataBase64: Buffer.from('png').toString('base64') })
  assert.equal(entry.asset.name, 'original 1.png')
  await command('edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'input', alias: entry.alias }] })
  const saved = await host.store.getProject(project.id)
  assert.equal(saved.draft.graph.nodes[0].data.asset.name, 'original 1.png')
  assert.equal(saved.draft.graph.nodes[0].data.kind, 'load-image')
  await assert.rejects(command('edit', { expectedDraftRevision: 1, edits: [{ op: 'add', alias: '<Image 2>' }] }), /uploading/)
  const { entry: folder } = await reference({ action: 'reserve', id: randomUUID(), kind: 'folder', name: 'Script folder', files: Array.from({ length: 105 }, (_, i) => ({ name: `scene-${i}.txt`, path: `Script folder/scenes/scene-${i}.txt`, mimeType: 'text/plain', size: 5 })) })
  await reference({ action: 'upload', id: folder.id, fileIndex: 0, dataBase64: Buffer.from('Hello').toString('base64') })
  const listing = await command('references', { alias: folder.alias, limit: 10 })
  assert.equal(listing.items.length, 10)
  assert.equal(listing.total, 105)
  assert.equal(JSON.stringify(listing).includes('Hello'), false)
  assert.equal((await command('text', { alias: folder.alias, fileIndex: 0 })).text, 'Hello')
  const restarted = await testHost(root)
  try {
    const result = await restarted.rpc('canvas/command', { projectId: project.id, sessionId: project.sessionId, command: 'references', args: { alias: entry.alias } })
    assert.equal(result.value.asset.name, 'original 1.png')
    const next = await restarted.rpc('chat/references', { projectId: project.id, sessionId: project.sessionId, action: 'reserve', id: randomUUID(), kind: 'image', name: 'third.png', files: [{ name: 'third.png', mimeType: 'image/png', size: 3 }] })
    assert.equal(next.value.entry.alias, '<Image 3>')
  } finally { await restarted.close() }
  await reference({ action: 'sent', id: entry.id })
  await reference({ action: 'hide', id: entry.id })
  assert.equal((await reference({ action: 'list' })).entries.some(row => row.id === entry.id), false)
  assert.equal((await command('references', { alias: entry.alias })).name, entry.name, 'historical aliases still resolve after removing a composer tile')
})

test('a sidebar workflow can be built and run entirely on the Host without any browser', async t => {
  const { command, host, project } = await fixture(t)
  await command('edit', { expectedDraftRevision: 0, edits: [
    { op: 'add', kind: 'load-text', id: 'script', data: { text: 'Synthetic story scene' } },
    { op: 'add', type: 'core.preview', id: 'preview' },
    { op: 'add', type: 'core.vram-trigger', id: 'trigger', data: { vramAction: 'skip', vramActionInitialized: true } },
    { op: 'connect', source: 'script', target: 'trigger', targetHandle: 'in:flow-in' },
    { op: 'connect', source: 'script', target: 'preview' },
  ] })
  assert.ok((await command('validate')).nodeIds.includes('trigger'))
  const runId = randomUUID()
  const submitted = await command('run', { runId })
  assert.equal(submitted.runs[0].scheduler, 'host')
  for (let n = 0; n < 100; n++) {
    const run = await host.store.getVdRun(project.id, runId)
    if (!['queued', 'running'].includes(run.status)) { assert.equal(run.status, 'completed', run.error); break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await command('job', { runId })).status, 'completed')
  const saved = await command('save', { expectedDraftRevision: 1 })
  assert.equal(saved.saved, true)
  assert.equal((await host.store.getProject(project.id)).graph.nodes.length, 3)
})

test('explicit image inspection uses the native durable attachment protocol and checks vision capability', async t => {
  const { host, project, rpc } = await fixture(t)
  const { asset } = await rpc('assets/put', { projectId: project.id, kind: 'image', name: 'synthetic.png', mimeType: 'image/png', dataBase64: Buffer.from('synthetic').toString('base64') })
  let admitted = false
  const nativeRef = { attachmentId: 'sha256:synthetic', mediaType: 'image/png', bytes: 9, width: 1, height: 1 }
  const ctx = { get: key => key === 'attachments' ? { saveImage: async input => { assert.equal(input.name, 'synthetic.png'); assert.equal(input.data.toString(), 'synthetic'); admitted = true; return nativeRef } } : { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }
  const tool = canvasTool(host, ctx)
  const args = { projectId: project.id, command: 'image', args: { assetId: asset.id } }
  const exec = { agent: { session: { id: project.sessionId }, options: { provider: 'synthetic', model: 'vision' } } }
  const result = await tool.execute(args, exec)
  assert.equal(admitted, true)
  assert.deepEqual(tool.output.render(args, result)[1], { type: 'image', attachment: nativeRef })
  assert.equal(JSON.stringify(result).includes('c3ludGhldGlj'), false)
  await assert.rejects(canvasTool(host, { get: key => key === 'attachments' ? {} : { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } }).execute(args, exec), /image-capable/)
})

test('audio transcription is explicit, project scoped, and uses the configured Host speech path', async t => {
  const { host, project, rpc, command } = await fixture(t)
  const { asset } = await rpc('assets/put', { projectId: project.id, kind: 'audio', name: 'original-tone.wav', mimeType: 'audio/wav', dataBase64: Buffer.from('synthetic audio').toString('base64') })
  host.providers.transcribe = async (providerId, audio) => {
    assert.equal(providerId, 'speech'); assert.equal(audio.model, 'test-model')
    assert.equal(audio.name, 'original-tone.wav'); assert.equal(Buffer.from(audio.dataBase64, 'base64').toString(), 'synthetic audio')
    return { text: 'Synthetic transcript' }
  }
  assert.equal((await command('transcribe', { assetId: asset.id, providerId: 'speech', model: 'test-model' })).text, 'Synthetic transcript')
})

test('canvas edits cannot import another conversation asset or spoof its serving URL', async t => {
  const { host, project, rpc, command } = await fixture(t)
  const other = await host.store.createProject({ name: 'Other synthetic canvas', sessionId: 'other-session' })
  const { asset: foreign } = await rpc('assets/put', { projectId: other.id, kind: 'image', name: 'other.png', mimeType: 'image/png', dataBase64: Buffer.from('other').toString('base64') })
  await assert.rejects(command('edit', { expectedDraftRevision: 0, edits: [{ op: 'add', kind: 'load-image', data: { asset: { id: foreign.id, sha256: '' } } }] }), /not in this workflow/)
  const { asset } = await rpc('assets/put', { projectId: project.id, kind: 'image', name: 'mine.png', mimeType: 'image/png', dataBase64: Buffer.from('mine').toString('base64') })
  await command('edit', { expectedDraftRevision: 0, edits: [{ op: 'add', kind: 'load-image', data: { asset: { ...asset, url: 'https://invalid.test/spoof.png' } } }] })
  assert.equal((await host.store.getProject(project.id)).draft.graph.nodes[0].data.asset.url, asset.url)
})


test('removed draft references renumber by kind and released numbers are reused without retargeting sent aliases', async t => {
  const { command, reference } = await fixture(t)
  await command('edit', { expectedDraftRevision: 0, edits: ['first', 'second', 'third'].map(id => ({ op: 'add', type: 'core.preview', id })) })
  const add = nodeId => reference({ action: 'reserve', id: randomUUID(), kind: 'node', name: nodeId, nodeId })
  const first = (await add('first')).entry
  assert.equal(first.alias, '<Node 1>')
  await reference({ action: 'hide', id: first.id })
  const second = (await add('second')).entry
  assert.equal(second.alias, '<Node 1>', 'removing the only unsent reference should release index 1')
  const third = (await add('third')).entry
  assert.equal(third.alias, '<Node 2>')
  await reference({ action: 'hide', id: second.id })
  const remaining = (await reference({ action: 'list' })).entries
  assert.deepEqual(remaining.map(item => [item.id, item.alias]), [[third.id, '<Node 1>']], 'remaining draft aliases should close the gap')
  await reference({ action: 'sent', id: third.id })
  await reference({ action: 'hide', id: third.id })
  const next = (await add('first')).entry
  assert.equal(next.alias, '<Node 2>', 'published aliases must remain bound to their original node')
  assert.equal((await command('references', { alias: '<Node 1>' })).nodeId, 'third')
})
