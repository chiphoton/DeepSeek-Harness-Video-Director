import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { testHost } from './fixtures/director-host.js'
import { canvasTool } from '../src/canvas-agent.js'
import { libraryTool } from '../src/library-agent.js'
import { prepareNodeRequest } from '../lib/workflow-execution.js'

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
  const entries = []
  for (const index of [1, 2]) entries.push(await reference({ action: 'reserve', id: randomUUID(), kind: 'image', name: `original ${index}.png`, files: [{ name: `original ${index}.png`, mimeType: 'image/png', size: 3 }] }))
  assert.deepEqual(entries.map(row => row.entry.alias), ['<Image 1>', '<Image 2>'])
  const { entry } = await reference({ action: 'upload', id: entries[0].entry.id, fileIndex: 0, dataBase64: Buffer.from('png').toString('base64') })
  assert.equal(entry.asset.name, 'original 1.png')
  const { kind, mimeType, size } = await command('properties', { assetId: entry.asset.id })
  assert.deepEqual({ kind, mimeType, size }, { kind: 'image', mimeType: 'image/png', size: 3 })
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

test('recorded canvas argument mistakes are recoverable without widening content access', async t => {
  const { host, project } = await fixture(t)
  const tool = canvasTool(host)
  const call = (command, args) => tool.execute({ projectId: project.id, command, args }, { agent: { session: { id: project.sessionId } } })
  const edits = [{ op: 'add', kind: 'load-text', id: 'script', data: { text: 'Synthetic script' } }]
  assert.deepEqual(await call('help', { command: 'inspect' }), {
    command: 'inspect', usage: (await call('help', {})).commands.inspect,
  })
  assert.equal((await call('definition', { kind: 'prompt-enhancer' })).kind, 'prompt-enhancer')
  await assert.rejects(call('edit', { expectedDraftRevision: 0, baseDraftRevision: 1, edits }), /must match/)
  await assert.rejects(call('edit', { expectedDraftRevision: 0, idempotencyKey: 'canvas-retry', edits }), /idempotencyKey must be a UUID.*Omit/)
  assert.equal((await call('plan-edit', { baseDraftRevision: 0, edits })).nodeCount, 1)
  const applied = await call('edit', { baseDraftRevision: 0, edits })
  await assert.rejects(call('inspect', { id: 'script' }), /operation\.id.*node/)
  assert.equal((await call('inspect', { operationId: applied.operation.id })).id, applied.operation.id)
  await assert.rejects(call('node', { id: 'script', fields: ['text'] }), /sharing is disabled/)
  await assert.rejects(call('edit', { baseDraftRevision: 0, edits }), { code: 'video-director/draft-conflict' })
})

test('layout optimizer spaces measured cards, orders inputs by port, and changes only titles and positions', async t => {
  const { host, project, rpc } = await fixture(t)
  const exec = { agent: { session: { id: project.sessionId } } }
  const canvas = (command, args) => canvasTool(host).execute({ projectId: project.id, command, args }, exec)
  const library = (command, args) => libraryTool(host).execute({ projectId: project.id, command, args }, exec)
  const { items: [optimizer] } = await library('list', { name: 'layout-optimizer' })
  assert.equal(optimizer.builtIn, true)
  await library('bind', { id: optimizer.id, revision: optimizer.revision })
  assert.match((await library('load', { id: optimizer.id })).content, /vd_canvas layout/)
  const { items: [video] } = await canvas('catalog', { query: 'MiniMax-H3 Reference to Video' })
  await canvas('edit', { expectedDraftRevision: 0, edits: [
    { op: 'add', kind: 'load-image', id: 'image', position: { x: 20, y: 20 }, data: { title: 'Grid reference' } },
    { op: 'add', kind: 'load-text', id: 'text', position: { x: 20, y: 40 }, data: { title: 'Ripple prompt', text: 'Animate a subtle ripple.' } },
    { op: 'add', type: video.type, id: 'video', position: { x: 350, y: 20 }, data: { fieldInputModes: { prompt: { mode: 'input' } } } },
    { op: 'add', type: 'core.preview', id: 'preview', position: { x: 720, y: 20 } },
    { op: 'connect', source: 'text', target: 'video', targetHandle: 'in:field:prompt' },
    { op: 'connect', source: 'image', target: 'video', targetHandle: 'in' },
    { op: 'connect', source: 'video', target: 'preview' },
  ] })
  const before = (await host.store.getProject(project.id)).draft
  const args = { expectedDraftRevision: 1, stageTitles: true, titles: [{ id: 'video', title: 'Animate the reference' }] }
  const fallback = await canvas('layout', args)
  assert.equal(fallback.measuredNodes, 0)
  assert.equal(fallback.estimatedCrossings, 0)
  const viewId = randomUUID()
  const sizes = [
    { id: 'image', width: 410, height: 780 },
    { id: 'text', width: 450, height: 640 },
    { id: 'video', width: 540, height: 870, inputs: [['in:field:prompt', 270], ['in', 690]] },
    { id: 'preview', width: 360, height: 250 },
  ]
  const reportGeometry = draftRevision => rpc('workspace/view', { projectId: project.id, sessionId: project.sessionId, viewId,
    geometry: { draftRevision, nodes: sizes } })
  await reportGeometry(0)
  assert.equal((await canvas('layout', args)).measuredNodes, 0, 'ignore geometry from a stale draft')
  await reportGeometry(1)
  const dryRun = await canvas('layout', args)
  assert.equal(dryRun.measuredNodes, 4)
  assert.equal(dryRun.stages, 3)
  assert.equal(dryRun.estimatedCrossings, 0)
  assert.equal(dryRun.applied, false)
  assert.deepEqual((await host.store.getProject(project.id)).draft, before)

  const applied = await canvas('layout', { ...args, apply: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.operation.kind, 'layout')
  assert.equal(applied.draftRevision, 2)
  const after = (await host.store.getProject(project.id)).draft
  const [image, text, action, preview] = after.graph.nodes
  assert.equal(image.position.x, text.position.x)
  assert.ok(image.position.y > text.position.y + 640, 'stack using rendered height and put prompt above reference')
  assert.equal(text.position.y, action.position.y)
  assert.equal(text.position.y, preview.position.y)
  assert.ok(action.position.x > text.position.x + 450)
  assert.ok(preview.position.x > action.position.x + 540)
  assert.equal(image.data.title, 'Stage 1: Grid reference')
  assert.equal(action.data.title, 'Stage 2: Animate the reference')
  assert.equal(preview.data.title, 'Stage 3: Preview')
  assert.deepEqual(after.graph.edges, before.graph.edges)
  assert.deepEqual(after.graph.nodes.map(({ data: { title, ...data } }) => data), before.graph.nodes.map(({ data: { title, ...data } }) => data))
  assert.deepEqual((await canvas('validate')).stages, [['video']])
  await reportGeometry(2)
  assert.equal((await canvas('layout', { ...args, expectedDraftRevision: 2, apply: true })).applied, false)
  await assert.rejects(canvas('layout', { ...args, apply: true }), { code: 'video-director/draft-conflict' })
  const viewport = { x: 90, y: -45, zoom: .5 }
  await host.store.cacheDraft(project.id, { ...after, graph: { ...after.graph, viewport } }, 2)
  const later = await canvas('edit', { expectedDraftRevision: 3, edits: [{ op: 'update', id: 'text', data: { text: 'A later edit' } }] })
  await assert.rejects(canvas('undo', { operationId: applied.operation.id, expectedDraftRevision: 4 }), { code: 'video-director/undo-conflict' })
  await canvas('undo', { operationId: later.operation.id, expectedDraftRevision: 4 })
  await canvas('undo', { operationId: applied.operation.id, expectedDraftRevision: 5 })
  assert.deepEqual((await host.store.getProject(project.id)).draft, { ...before, graph: { ...before.graph, viewport } })
})

test('canvas edits add a switchable video card from a discoverable preset', async t => {
  const { command, host, project } = await fixture(t)
  const workflowId = 'builtin-minimax-h3-reference-to-video-turbo'
  const { items } = await command('catalog', { query: 'video-generation' })
  assert.ok(items.some(item => item.kind === 'video-generation' && item.workflowSelection === 'switchable'))
  const definition = await command('definition', { type: 'video-generation', workflowId })
  assert.ok(definition.presets.some(preset => preset.id === 'builtin-minimax-h3-video-turbo'))
  assert.ok(definition.inputs.some(port => port.id === 'reference' && port.types.includes('image')))
  const add = { ...definition.add, id: 'video' }
  const args = { expectedDraftRevision: 0, edits: [add], nodeIds: ['video'] }
  assert.equal((await command('plan-edit', args)).nodeCount, 1)
  for (const invalid of [{ ...add, type: `builtin.${workflowId}` }, { ...add, workflowId: 'builtin-minimax-h3-audio-turbo' }]) {
    await assert.rejects(command('edit', { ...args, edits: [invalid] }), /switchable workflow node|Unknown video workflow ID/)
  }
  await command('edit', args)
  const projectWithDraft = await host.store.getProject(project.id)
  const [video] = projectWithDraft.draft.graph.nodes
  const preset = host.workflows.list().find(workflow => workflow.id === workflowId)
  assert.equal(video.data.nodeType, undefined)
  assert.equal(video.data.workflowId, workflowId)
  assert.equal(video.data.duration, preset.defaults.duration)
  assert.deepEqual(video.data.workflowValues, Object.fromEntries(preset.parameters.map(field => [field.id, field.default])))
  const { request } = prepareNodeRequest({ ...projectWithDraft, ...projectWithDraft.draft }, 'video', {
    nodeDefinitions: host.nodes.list(), providers: host.providers.publicCatalog(), workflows: host.workflows.list(),
  })
  assert.equal(request.workflowId, workflowId)
})

test('the sketch recipe builds a short typed pipeline with optional memory handoffs in one call', async t => {
  const { host, project } = await fixture(t)
  const asset = await host.store.putAsset({ projectId: project.id, kind: 'sketch', mimeType: 'image/png', name: 'boat.png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII=' })
  const exec = { agent: { session: { id: project.sessionId } } }
  const canvas = (command, args) => canvasTool(host).execute({ projectId: project.id, command, args }, exec)
  const args = { recipe: 'sketch-to-h3', expectedDraftRevision: 0, assetId: asset.id, brief: 'A paper boat on a teal pond.', modelId: 'synthetic-vision' }
  const without = await canvas('recipe', args)
  assert.deepEqual(without.stages, [['reference'], ['enhancer'], ['h3']])
  assert.equal(without.applied, false)
  assert.equal(without.duration, 5)
  assert.equal((await canvas('summary')).nodeCount, 0)
  await assert.rejects(canvas('recipe', { ...args, duration: 20 }), /between 5 and 15/)
  const applied = await canvas('recipe', { ...args, duration: 7, vramHandoffs: true, apply: true })
  assert.equal(applied.draftRevision, 1)
  assert.equal(applied.nodeCount, 12)
  assert.equal(applied.edgeCount, 14)
  assert.deepEqual(applied.stages.flat(), ['before-image', 'reference', 'before-prompt', 'enhancer', 'before-video', 'h3', 'after-video'])
  const graph = (await host.store.getProject(project.id)).draft.graph
  assert.match(graph.nodes.find(node => node.id === 'enhancer').data.prompt, /7-second MiniMax H3/)
  const h3 = graph.nodes.find(node => node.id === 'h3').data
  assert.equal(h3.workflowId, 'builtin-minimax-h3-reference-to-video-turbo')
  assert.equal(h3.nodeType, undefined)
  assert.equal(h3.duration, 7)
  assert.equal(graph.nodes.find(node => node.id === 'sketch').data.asset.id, asset.id)
  assert.ok(graph.nodes.every(node => node.data.title.startsWith('Stage ')))
  assert.ok(graph.edges.some(edge => edge.source === 'enhancer' && edge.target === 'h3' && edge.targetHandle === 'in:field:prompt'))
  assert.ok(graph.edges.some(edge => edge.source === 'reference' && edge.target === 'h3' && edge.targetHandle === 'in'))
  assert.ok(JSON.stringify(applied).length < 2000, 'Recipe returns counts and stages, not the whole graph')
  await assert.rejects(canvas('recipe', { ...args, expectedDraftRevision: 1, apply: true }), /empty canvas/)
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

test('the built-in skill can plan assets and wire prompt and media ports without workflow content access', async t => {
  const { host, project, reference } = await fixture(t)
  const exec = { agent: { session: { id: project.sessionId } } }
  const canvas = (command, args) => canvasTool(host).execute({ projectId: project.id, command, args }, exec)
  const library = (command, args) => libraryTool(host).execute({ projectId: project.id, command, args }, exec)
  const { items: [skill] } = await library('list', { name: 'canvas-builder' })
  assert.equal(skill.builtIn, true)
  await assert.rejects(library('save', { id: skill.id, expectedRevision: 1 }), /built-in skill/)
  await library('bind', { id: skill.id, revision: skill.revision })
  const loaded = await library('load', { id: skill.id })
  assert.match(loaded.content, /plan-edit/)
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(loaded)), 'Native DSH tool results must be lossless JSON')
  assert.match((await library('resource', { id: skill.id, path: 'references/few-shot.md' })).text, /canvas-demo[\s\S]*all-in-one/)

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII=', 'base64')
  const { entry } = await reference({ action: 'reserve', id: randomUUID(), kind: 'image', name: 'teal-grid.png', files: [
    { name: 'teal-grid.png', mimeType: 'image/png', size: png.length },
  ] })
  await reference({ action: 'upload', id: entry.id, fileIndex: 0, dataBase64: png.toString('base64') })
  const { items: [image] } = await canvas('assets', { query: 'GRID', kind: 'image' })
  assert.equal(image.name, 'teal-grid.png')
  const inputs = [
    { op: 'add', id: 'grid', alias: entry.alias, data: { title: 'Grid' } },
    { op: 'add', id: 'brief', kind: 'load-text', data: { text: 'A paper boat crosses a teal pond.' } },
  ]
  const preview = await canvas('plan-edit', { expectedDraftRevision: 0, edits: inputs, nodeIds: ['grid'] })
  assert.deepEqual(preview.changes.added, ['grid', 'brief'])
  assert.deepEqual(preview.ports[0].outputs[0].types, ['image'])
  assert.equal((await canvas('summary')).nodeCount, 0)
  await canvas('edit', { expectedDraftRevision: 0, edits: inputs })
  const listedNodes = await canvas('nodes')
  assert.deepEqual(listedNodes, JSON.parse(JSON.stringify(listedNodes)))
  await assert.rejects(canvas('plan-edit', { expectedDraftRevision: 0, edits: inputs }), /current draft revision/)
  await assert.rejects(canvas('edit', { expectedDraftRevision: 1, edits: [{ op: 'attach', id: 'brief', assetId: image.id }] }), /load-image/)

  const { items: [video] } = await canvas('catalog', { query: 'MiniMax-H3 Reference to Video' })
  const videoDefinition = await canvas('definition', { type: video.type, version: video.version })
  assert.ok(videoDefinition.fields.some(field => field.id === 'prompt' && field.placement === 'primary'), 'The prompt port has a visible field to anchor its edge')
  const processing = [
    { op: 'add', id: 'video', type: video.type, version: video.version, data: { fieldInputModes: { prompt: { mode: 'input' } } } },
    { op: 'add', id: 'preview', type: 'core.preview' },
  ]
  const planned = await canvas('plan-edit', { expectedDraftRevision: 1, edits: processing, nodeIds: ['video'] })
  const media = planned.ports[0].inputs.find(port => port.id === 'reference')
  const prompt = planned.ports[0].inputs.find(port => port.id === 'field:prompt')
  assert.ok(media.types.includes('image'))
  assert.equal(prompt.handle, 'in:field:prompt')
  await assert.rejects(canvas('plan-edit', { expectedDraftRevision: 1, edits: [...processing,
    { op: 'connect', source: 'grid', target: 'video', targetHandle: prompt.handle },
  ] }), /media types do not overlap/)
  const connected = [...processing,
    { op: 'connect', id: 'reference', source: 'grid', target: 'video', targetHandle: media.handle },
    { op: 'connect', id: 'prompt', source: 'brief', target: 'video', targetHandle: prompt.handle },
    { op: 'connect', id: 'result', source: 'video', target: 'preview' },
  ]
  const plan = await canvas('plan-edit', { expectedDraftRevision: 1, edits: connected })
  assert.deepEqual(plan.changes.edgesAdded, ['reference', 'prompt', 'result'])
  const applied = await canvas('edit', { expectedDraftRevision: 1, edits: connected })
  assert.deepEqual((await canvas('validate')).stages, [['video']])
  const stored = await host.store.getProject(project.id)
  const catalog = { nodeDefinitions: host.nodes.list(), providers: host.providers.publicCatalog(), workflows: host.workflows.list() }
  const { request } = prepareNodeRequest({ ...stored, ...stored.draft }, 'video', catalog)
  assert.equal(request.prompt, 'A paper boat crosses a teal pond.')
  assert.deepEqual(request.assetIds, [image.id])

  const revisionEdits = [
    { op: 'add', id: 'new-brief', kind: 'load-text', data: { text: 'The paper boat approaches a pier.' } },
    { op: 'add', id: 'grid-copy', assetId: image.id },
    { op: 'disconnect', id: 'prompt' },
    { op: 'connect', id: 'new-prompt', source: 'new-brief', target: 'video', targetHandle: prompt.handle },
  ]
  const revisionPlan = await canvas('plan-edit', { expectedDraftRevision: 2, edits: revisionEdits })
  assert.deepEqual(revisionPlan.changes.edgesRemoved, ['prompt'])
  assert.deepEqual(revisionPlan.changes.edgesAdded, ['new-prompt'])
  const revised = await canvas('edit', { expectedDraftRevision: 2, edits: revisionEdits })
  const revisedProject = await host.store.getProject(project.id)
  assert.equal(revisedProject.draft.graph.nodes.find(node => node.id === 'grid-copy').data.asset.id, image.id)
  const { request: revisedRequest } = prepareNodeRequest({ ...revisedProject, ...revisedProject.draft }, 'video', catalog)
  assert.equal(revisedRequest.prompt, 'The paper boat approaches a pier.')
  assert.deepEqual(revisedRequest.assetIds, [image.id])
  await canvas('undo', { operationId: revised.operation.id, expectedDraftRevision: 3 })
  await canvas('undo', { operationId: applied.operation.id, expectedDraftRevision: 4 })
  assert.deepEqual((await canvas('nodes')).items.map(node => node.id), ['grid', 'brief'])
  assert.equal((await canvas('assets')).total, 1, 'Undo leaves the original uploaded asset available')
})

test('explicit image inspection uses the native durable attachment protocol and checks vision capability', async t => {
  const { host, project, rpc } = await fixture(t)
  await rpc('workspace/access', { projectId: project.id, allowContent: true })
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
