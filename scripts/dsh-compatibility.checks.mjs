import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import * as plugin from '../index.js'
import { canvasTool } from '../src/canvas-agent.js'
import { libraryTool } from '../src/library-agent.js'
import { qualityTool } from '../src/quality-agent.js'
import { workspaceTool } from '../src/workspace-agent.js'
import { testHost } from '../test/fixtures/director-host.js'

const { Context, Service, ClientSessions, Session, ClientAssistantStream, ProjectChatSource, HostConnectionService, bridge, createWebConnectionRpc, createSettingsShellStore, ModelDirectoryResolver, directorInject } = await import(pathToFileURL(process.env.VD_DSH_SURFACES))
const runtimeRequire = createRequire(join(process.env.VD_DSH_RUNTIME, 'package.json'))
const native = name => import(pathToFileURL(runtimeRequire.resolve(`@deepseek-ai/${name}`)))
const ok = value => ({ ok: true, value })
const SID = 'compatibility-session'
const idleModels = { current: null, routable: null, groups: [], failures: [], status: 'ready', pending: null, error: null }
const tick = () => new Promise(resolve => setImmediate(resolve))
function observable(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    publish(next) { value = next; for (const fn of listeners) fn() } }
}
function director(sessionId = SID) {
  return { ...observable({ project: { id: sessionId, sessionId } }), currentContext: () => '' }
}
async function chatFixture(t, options = {}) {
  const session = new Session(SID, { session: { prompt: async () => ok({ accepted: true }), ...options } })
  const binding = { session, eventSource: session.eventSource }
  const models = { store: observable(idleModels), load: async () => idleModels, select: options.select ?? (async () => ok(undefined)) }
  let references = 0
  const selection = director()
  const chat = new ProjectChatSource({
    sessions: { list: observable({ byId: { [SID]: { id: SID } } }), retain() {
      references++
      let released = false
      return { binding, ready: Promise.resolve(binding), release() { if (!released) references--; released = true } }
    } }, modelDirectories: { directoryFor: () => models },
  }, selection)
  t.after(() => { chat.dispose(); assert.equal(references, 0) })
  await tick()
  return { chat, session, selection, references: () => references }
}
const user = (id, text, rpcId = id) => ({ id, role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] })
const assistant = (seq, text, surfaceOp = 'append', turn = 0) => ({ type: 'event', event: {
  type: 'assistant/message', seq, time: seq, surfaceOp,
  data: { turn, step: 0, stream: [], message: { id: `assistant-${seq}`, role: 'assistant', content: [{ type: 'text', text }] } },
} })

test('Video Director publishes valid command schemas to the native model tool registry', async () => {
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await native('dsh-tools')
  for (const [createTool, command] of [[canvasTool, 'help'], [libraryTool, 'list'], [qualityTool, 'create'], [workspaceTool, 'manifest']]) {
    const { parameters } = createTool({})
    assertSupportedJsonSchema(parameters)
    assert.deepEqual(validateJsonSchemaValue(parameters, { projectId: 'synthetic', command }), [])
    assert.notEqual(validateJsonSchemaValue(parameters, { projectId: 'synthetic', action: command }).length, 0)
  }
  const { parameters } = canvasTool({})
  const edit = { projectId: 'synthetic', command: 'edit', args: { expectedDraftRevision: 0, edits: [{ op: 'add', kind: 'load-text', id: 'prompt' }] } }
  assert.deepEqual(validateJsonSchemaValue(parameters, edit), [])
  assert.notEqual(validateJsonSchemaValue(parameters, { ...edit, args: { ...edit.args, expectedDraftRevision: '0' } }).length, 0)
  assert.notEqual(validateJsonSchemaValue(parameters, { ...edit, args: { ...edit.args, edits: [{ kind: 'load-text' }] } }).length, 0)
})

test('native DSH accepts the built-in skill, dry run, and canvas edit results as lossless JSON', async t => {
  const { Context: HostContext } = await native('cordis')
  const { default: SystemPrompt } = await native('dsh-system-prompt')
  const { default: ToolRuntime } = await native('dsh-tools')
  const directory = await mkdtemp(join(tmpdir(), 'vd-native-canvas-'))
  const host = await testHost(directory)
  const ctx = new HostContext()
  t.after(async () => { await ctx.fiber.dispose(); await host.close(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(libraryTool(host))
  ctx.tools.register(canvasTool(host, ctx))
  const project = await host.store.createProject({ name: 'Synthetic native canvas', sessionId: SID })
  let sequence = 0
  const call = async (name, command, args = {}) => {
    const result = await ctx.tools.execute({ name, callId: `synthetic-${++sequence}`, signal: new AbortController().signal,
      arguments: { projectId: project.id, command, args }, agent: { ctx, session: { id: project.sessionId } } })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    return result.value
  }
  const { items: [skill] } = await call('vd_library', 'list', { name: 'canvas-builder' })
  await call('vd_library', 'bind', { id: skill.id, revision: skill.revision })
  assert.match((await call('vd_library', 'load', { id: skill.id })).content, /plan-edit/)
  assert.equal((await call('vd_canvas', 'catalog', { query: 'Text Input' })).items[0].kind, 'load-text')
  assert.equal((await call('vd_canvas', 'definition', { type: 'load-text' })).outputs[0].handle, 'out')
  const args = { expectedDraftRevision: 0, edits: [
    { op: 'add', id: 'brief', kind: 'load-text', data: { text: 'A synthetic scene.' } },
    { op: 'add', id: 'preview', type: 'core.preview' },
    { op: 'connect', id: 'text-preview', source: 'brief', target: 'preview' },
  ] }
  assert.equal((await call('vd_canvas', 'plan-edit', args)).edgeCount, 1)
  assert.equal((await call('vd_canvas', 'summary')).edgeCount, 0)
  assert.equal((await call('vd_canvas', 'edit', args)).draftRevision, 1)
  assert.equal((await call('vd_canvas', 'nodes')).items.length, 2)
  assert.equal((await call('vd_canvas', 'edges')).items[0].targetHandle, 'in')
})

test('Stop cancels the linked native session and allows retry if cancellation fails', async t => {
  const requests = []
  let response = { ok: false, error: { code: 'session/failed', message: 'Could not stop' } }
  const { chat, session } = await chatFixture(t, { cancel: async request => { requests.push(request); return response } })
  session.handleRunning(true)
  await tick()
  await chat.stop()
  assert.equal(chat.getSnapshot().running, true)
  assert.equal(chat.getSnapshot().stopping, false)
  assert.equal(chat.getSnapshot().error, 'Could not stop')
  response = ok({ accepted: true })
  const stopping = chat.stop()
  assert.equal(chat.getSnapshot().stopping, true)
  await chat.stop()
  await stopping
  session.handleRunning(false)
  await tick()
  assert.deepEqual(requests, [{ sessionId: SID }, { sessionId: SID }])
  assert.equal(chat.getSnapshot().running, false)
  assert.equal(chat.getSnapshot().stopping, false)
  assert.equal(chat.getSnapshot().error, null)
})

test('sent image references stay attached to their user bubble and resolve through the owning session', async t => {
  const requests = []
  const red = { attachmentId: 'red-ref', name: 'red.png', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const blue = { ...red, attachmentId: 'blue-ref', name: 'blue.png' }
  const { chat, session } = await chatFixture(t, { attachment: async request => {
    requests.push(request)
    return ok({ attachment: red, data: 'AQID' })
  } })
  const message = user('image-turn', 'Describe these frames')
  message.content.unshift(...[red, blue].map(attachment => ({ type: 'image', attachment })))
  session.eventSource.replace([{ type: 'event', event: { type: 'user/message', seq: 2, time: 2, surfaceOp: 'append', data: message } }], false)
  const [row] = chat.getSnapshot().messages
  assert.equal(row.text, 'Describe these frames')
  assert.deepEqual(row.images.map(image => image.attachmentId), ['red-ref', 'blue-ref'])
  const blob = await chat.readImage(SID, row.images[0].attachmentId)
  assert.equal(blob.type, 'image/png')
  assert.equal(blob.size, 3)
  assert.deepEqual(requests, [{ sessionId: SID, attachmentId: 'red-ref' }])
  await assert.rejects(chat.readImage('another-session', 'red-ref'), /session changed/)
})

test('assistant and tool image blocks are preserved in the sidebar transcript', async t => {
  const { chat, session } = await chatFixture(t)
  const image = { type: 'image', attachment: { attachmentId: 'synthetic-image', name: 'grid.png' } }
  const reply = assistant(3, 'Preview')
  reply.event.data.message.content = [image]
  session.eventSource.replace([
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { name: 'vd_canvas', callId: 'view', arguments: '{"command":"image"}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { id: 'tool-image', content: [{ type: 'tool-result', toolCallId: 'view', content: [image] }] } } } },
    reply,
  ], false)
  const rows = chat.getSnapshot().messages
  assert.deepEqual(rows.map(row => [row.kind, row.callId, row.toolCommand, row.images?.[0]?.attachmentId]), [
    ['tool-call', 'view', 'image', undefined],
    ['tool-result', 'view', undefined, 'synthetic-image'],
    ['assistant', undefined, undefined, 'synthetic-image'],
  ])
  assert.equal(rows[1].text, '')
  assert.equal(rows[2].text, '')
})

test('historical image labels are local to each prompt and replies keep their recorded model', async t => {
  const { chat, session } = await chatFixture(t)
  const prompt = (seq, first, second, local) => {
    const attachments = [first, second].map((number, i) => ({
      alias: `<Image ${number}>`, kind: 'image',
      ...(local ? { label: `Image ${i + 1}`, imageIndex: i + 1 } : {}),
    }))
    const text = `Compare <Image ${local ? 1 : first}> and <Image ${local ? 2 : second}>.\n\n<dsh-video-director-context version="1">\n{}\n${JSON.stringify({ attachments })}\n</dsh-video-director-context>`
    return { type: 'event', event: { type: 'user/message', seq, data: user(`user-${seq}`, text) } }
  }
  const first = assistant(1, 'Image 3 is red and Image 4 is blue.', 'append', 0)
  first.event.data.message.source = { kind: 'model', provider: 'ollama', model: 'qwen-q4' }
  const second = assistant(3, 'Image 2 is red and Image 5 is blue.', 'append', 1)
  second.event.data.message.source = { kind: 'model', provider: 'ollama', model: 'qwen-q6' }
  session.eventSource.replace([prompt(0, 3, 4, false), first, prompt(2, 5, 6, true), second], false)
  const rows = chat.getSnapshot().messages
  assert.deepEqual(rows.map(row => row.text), [
    'Compare <Image 1> and <Image 2>.',
    'Image 1 is red and Image 2 is blue.',
    'Compare <Image 1> and <Image 2>.',
    'Image 2 is red and Image 1 is blue.',
  ])
  assert.deepEqual(rows.filter(row => row.role === 'assistant').map(row => row.model?.model), ['qwen-q4', 'qwen-q6'])
})

test('a follow-up sends its local image labels with the new images and their stable tool aliases', async t => {
  const { chat, selection } = await chatFixture(t)
  let number = 1
  const sent = []
  Object.assign(selection, {
    prepareChatSkills: async () => {},
    prepareChatContext: async () => {},
    chatReferences: async input => {
      if (input.action === 'list') return { entries: [{ id: 'old', alias: '<Image 1>', kind: 'image', name: 'old.png', sent: true, ready: true }] }
      if (input.action === 'reserve') return { entry: { id: input.id, alias: `<Image ${++number}>`, kind: input.kind, name: input.name, ready: true } }
      if (input.action === 'sent') sent.push(input.id)
    },
  })
  const registry = chat.attachments()
  const first = await registry.addFile(new File(['a'], 'a.png', { type: 'image/png' }))
  const second = await registry.addFile(new File(['b'], 'b.png', { type: 'image/png' }))
  let payload
  chat.send = async (text, files, context) => { payload = { text, files, context: JSON.parse(context) } }
  await chat.sendAttachments('Compare <Image 1> and <Image 2>.')
  assert.equal(payload.text, 'Compare <Image 1> and <Image 2>.')
  assert.deepEqual(payload.files.map(file => file.name), ['a.png', 'b.png'])
  assert.deepEqual(payload.context.attachments.map(({ alias, label, imageIndex }) => [alias, label, imageIndex]), [
    ['<Image 2>', 'Image 1', 1], ['<Image 3>', 'Image 2', 2],
  ])
  assert.deepEqual(sent, [first.id, second.id])
})

test('Director can open a fresh native model directory and pick models added through Settings', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const shell = createSettingsShellStore().create()
  const selection = { provider: 'synthetic', model: 'new-model' }
  let groups = []
  let loads = 0
  let selected
  const events = new Map()
  // The real gateway exposes each remote namespace as a separate Cordis service.
  class TestRemote extends Service {
    constructor(scope) { super(scope, 'remote') }
    $on(name, listener) { events.set(name, listener) }
  }
  await ctx.plugin(TestRemote)
  const projected = observable({ next: null })
  const sessionRpc = {
    async modelCatalog() {
      loads++
      return ok({ default: selection, groups, failures: [], routableProviders: groups.map(group => group.id) })
    },
    async selectModel(request) {
      selected = request
      projected.publish({ next: selection })
      return ok(undefined)
    },
  }
  await ctx.plugin(scope => { scope.provide('remote.session', sessionRpc) })
  const session = new Session(SID, { session: { prompt: async () => ok({ accepted: true }) } })
  const binding = { session: { getSnapshot: () => session.getSnapshot(), subscribe: listener => session.subscribe(listener),
    projections: { faceOf: name => name === 'modelSelection' ? projected : session.projections.faceOf(name) } }, eventSource: session.eventSource }
  ctx.provide('sessions', {
    list: observable({ byId: { [SID]: { id: SID } } }),
    retain: () => ({ binding, ready: Promise.resolve(binding), release() {} }),
    scope: () => ctx, binding: () => binding, subagentAddress: () => undefined,
  })
  ctx.provide('slots', { entries: name => { assert.equal(name, 'sidebar.settings'); return [{ store: { create: () => shell } }] } })
  ctx.provide('connection', {})
  ctx.provide('uiWorkspace', {})
  await ctx.plugin(ModelDirectoryResolver)
  let chat
  await ctx.plugin({ inject: directorInject, apply(scope) {
    chat = new ProjectChatSource(scope, director())
    scope.effect(() => () => chat.dispose())
  } })
  await tick()
  assert.equal(chat.getSnapshot().models.error, null)
  assert.deepEqual(chat.getSnapshot().models.groups, [])
  const before = loads
  const open = chat.openModelSettings()
  assert.equal(shell.getSnapshot().activeId, 'models')
  assert.equal(shell.getSnapshot().open, true)
  groups = [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'new-model', name: 'New model' }] }]
  events.get('settings/document-updated')()
  shell.actions.close()
  await open
  assert.equal(loads, before + 1)
  assert.equal(chat.getSnapshot().models.groups[0].models[0].id, 'new-model')
  await chat.selectModel(selection)
  assert.deepEqual(selected, { sessionId: SID, ...selection })
  assert.equal(chat.getSnapshot().models.routable, true)
  const reopened = chat.openModelSettings()
  chat.dispose()
  await reopened
})

test('real ClientSessions retains catalogued sessions, releases on switch/dispose, and never navigates', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const remote = { session: {
    list: async () => ok({ items: ['a', 'b'].map(sessionId => ({ sessionId, updatedAt: 0, running: false, blank: true, agentAvailable: true })) }),
    async *follow(request, signal) {
      yield { type: 'snapshot', header: { version: 4, id: request.address.sessionId, createdAt: 0, isSeeded: false },
        cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
  } }
  const sessions = new ClientSessions(ctx, remote)
  await sessions.refresh()
  assert.equal(sessions.open, undefined)
  assert.equal(sessions.binding('a'), undefined, 'catalog membership must not own a binding')
  const selection = director('a')
  const chat = new ProjectChatSource({ sessions, modelDirectories: { directoryFor: id => {
    assert.ok(sessions.scope(id))
    return { store: observable(idleModels), load: async () => idleModels }
  } } }, selection)
  t.after(() => chat.dispose())
  await tick()
  assert.equal(sessions.retainInfo('a').getSnapshot().referenceCount, 1)
  assert.equal(chat.getSnapshot().sessionId, 'a')
  selection.publish({ project: { id: 'b', sessionId: 'b' } })
  await tick()
  assert.equal(sessions.binding('a'), undefined)
  assert.equal(sessions.retainInfo('b').getSnapshot().retainedBy.videoDirector, 1)
  chat.dispose()
  assert.equal(sessions.binding('b'), undefined)
  assert.equal(sessions.retainInfo('b').getSnapshot().referenceCount, 0)
})

test('late readiness from a replaced project cannot attach stale events or models', async t => {
  const gates = { a: Promise.withResolvers(), b: Promise.withResolvers() }
  const released = []
  const selection = director('a')
  const chat = new ProjectChatSource({
    sessions: { list: observable({ byId: { a: {}, b: {} } }), retain(id) { return { ready: gates[id].promise, release() { released.push(id) } } } },
    modelDirectories: { directoryFor: () => { throw new Error('No obsolete model directory should be created') } },
  }, selection)
  t.after(() => chat.dispose())
  selection.publish({ project: { id: 'b', sessionId: 'b' } })
  gates.a.resolve({ session: { subscribe: () => assert.fail('stale binding attached') } })
  await tick()
  assert.equal(chat.getSnapshot().sessionId, 'b')
  chat.dispose()
  gates.b.reject(new Error('closed'))
  await tick()
  assert.deepEqual(released, ['a', 'b'])
})

test('text submissions provide the native attachments array', async t => {
  const { chat, session } = await chatFixture(t)
  await chat.send('A text-only prompt')
  assert.deepEqual(session.getSnapshot().pendingSubmissions[0].attachments, [])
})

test('native image echoes carry typed previews and disposal retires a pending upload', async t => {
  let request
  const { chat, session, references } = await chatFixture(t, { prompt: async input => { request = input; return ok({ accepted: true }) } })
  const sending = chat.send('Describe a frame', [new File([new Uint8Array([1, 2, 3])], 'frame.png', { type: 'image/png' })])
  const rejected = assert.rejects(sending, /not added to the project session/)
  await tick()
  const [attachment] = session.getSnapshot().pendingSubmissions[0].attachments
  assert.equal(attachment.type, 'image')
  assert.equal(attachment.value.name, 'frame.png')
  assert.match(attachment.value.previewUrl, /^blob:/)
  assert.equal(request.content[0].data, 'AQID')
  chat.dispose()
  await rejected
  assert.equal(references(), 0)
})

test('an in-flight send retains its session after the project view is released', async t => {
  const gate = Promise.withResolvers()
  const { chat, selection, references } = await chatFixture(t, { prompt: () => gate.promise })
  const sending = chat.send('Pending admission')
  await tick()
  assert.equal(references(), 2)
  selection.publish({ project: null })
  assert.equal(references(), 1)
  gate.resolve(ok({ accepted: true }))
  await sending
  assert.equal(references(), 0)
})

test('accepted inbox changes are observed and deduplicate optimistic and durable messages', async t => {
  const { chat, session } = await chatFixture(t)
  await chat.send('Queued prompt')
  const requestId = session.getSnapshot().pendingSubmissions[0].requestId
  const message = user('queued', 'Queued prompt', requestId)
  session.projections.apply('inbox', { 'next-turn': [message], 'next-step': [] }, 1)
  await tick()
  assert.deepEqual(chat.getSnapshot().messages.map(row => [row.text, row.status]), [['Queued prompt', 'pending']])
  session.eventSource.replace([{ type: 'event', event: { type: 'user/message', seq: 2, time: 2, surfaceOp: 'append', data: message } }], false)
  assert.deepEqual(chat.getSnapshot().messages.map(row => [row.text, row.status]), [['Queued prompt', 'complete']])
})

test('real assistant stream deltas display once and settle without duplicate text', async t => {
  const { chat, session } = await chatFixture(t)
  const stream = new ClientAssistantStream()
  stream.replace([])
  stream.acceptFrame({ type: 'start', attemptId: 'attempt-1', turn: 0, step: 0, startedAfterSeq: -1 })
  const delta = stream.acceptFrame({ type: 'chunk', attemptId: 'attempt-1', index: 0, time: 1, chunk: { type: 'text-delta', text: 'Live answer' } })
  const header = { type: 'event', event: { type: 'request/header', seq: -1, data: { header: { config: { provider: 'ollama', model: 'qwen-q6' } } } } }
  session.eventSource.replace([header, delta.entry], false)
  assert.deepEqual(chat.getSnapshot().messages.map(row => [row.text, row.status]), [['Live answer', 'streaming']])
  assert.equal(chat.getSnapshot().messages[0].model?.model, 'qwen-q6')
  session.eventSource.replace([header, delta.entry, assistant(0, 'Final answer')], false)
  assert.deepEqual(chat.getSnapshot().messages.map(row => [row.text, row.status]), [['Final answer', 'complete']])
  session.eventSource.settleAssistant('attempt-1')
  assert.equal(chat.getSnapshot().messages.length, 1)
})

test('surface replacements remove the compacted prefix', async t => {
  const { chat, session } = await chatFixture(t)
  session.eventSource.replace([assistant(0, 'Old answer'), assistant(1, 'Compacted answer', { op: 'replace', startSeq: 0, endSeq: 0 })], false)
  assert.deepEqual(chat.getSnapshot().messages.map(row => row.text), ['Compacted answer'])
})

test('first-class native tool errors retain their call identity and error status', async t => {
  const { createToolResultMessage } = await native('dsh-llm')
  const { chat, session } = await chatFixture(t)
  const message = createToolResultMessage({ callId: 'call-1', isError: true, content: [{ type: 'text', text: 'Provider refused' }] })
  session.eventSource.replace([{ type: 'event', event: { type: 'tool/result', seq: 1, time: 1, surfaceOp: 'append', data: { turn: 0, step: 0, message } } }], false)
  assert.equal(chat.getSnapshot().messages[0].status, 'error')
  assert.equal(chat.getSnapshot().messages[0].callId, 'call-1')
})

test('model selection propagates a resolved RemoteResult failure', async t => {
  const { chat } = await chatFixture(t, { select: async () => ({ ok: false, error: { code: 'model/not-found', message: 'Unavailable model', details: {} } }) })
  await assert.rejects(chat.selectModel({ provider: 'missing', model: 'missing' }), /Unavailable model/)
  assert.equal(chat.getSnapshot().error, 'Unavailable model')
})

test('scoped Connection registers owner-only RPC and withdraws it when the plugin unloads', async t => {
  const { Context: HostContext } = await native('cordis')
  const { HostConnectionService: NativeConnection } = await native('dsh-client-connection')
  const root = await mkdtemp(join(tmpdir(), 'vd-route-lifetime-'))
  const ctx = new HostContext()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin({ apply(ctx) { new NativeConnection(ctx, [], {}) } })
  const fiber = ctx.plugin(plugin, { dataDir: root, providers: [] })
  await fiber.await()
  const connection = ctx.get('connection')
  const handler = connection.createSharedFetchHandler('/api')
  const request = () => new Request('http://localhost/api/video-director', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'scoped', method: 'video-director', payload: { endpoint: 'projects/list', payload: {} } }),
  })
  const response = await handler.fetch(request(), connection.browserPeer)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).result.ok, true)
  assert.equal((await handler.fetch(request(), { principal: { kind: 'remote' } })).status, 403)
  const invalid = await handler.fetch(new Request('http://localhost/api/video-director', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), connection.browserPeer)
  assert.equal(invalid.status, 400)
  await fiber.dispose()
  assert.equal((await handler.fetch(request(), connection.browserPeer)).status, 404)
})

async function hostFixture(t, { legacy = false } = {}) {
  const { boot, initProfile, readProfilePatches } = await native('dsh-app-boot')
  const { default: ConfigEditor } = await native('dsh-config-editor')
  const { default: Settings } = await native('dsh-settings')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vd-rc-host-')))
  const dir = join(home, 'profiles/test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules/test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"vd-test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const entryId = legacy ? 'video-director' : 'director-custom-entry'
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: entryId, name: 'cordis:director', config: { dataDir: join(home, 'assets'), providers: [
      { id: 'test', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: { __jsExpr: "'fixture-' + 'base-secret'" } },
    ] } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  if (legacy) await writeFile(join(home, 'settings.yaml'), JSON.stringify({ 'video-director': { providerOverrides: { test: { model: 'legacy-model' } }, minimaxH3LicenseAccepted: false } }))
  const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const contexts = []
  t.after(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const start = async () => {
    const routes = new Map()
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: fn => { fn(); return () => {} } })
      ctx.provide('webServer', { register: () => () => {} })
      ctx.provide('connection', {
        fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
      })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, director: plugin })
    })
    contexts.push(ctx)
    const caller = createWebConnectionRpc((input, init) => routes.get('/api/video-director').fetch(new Request(`http://localhost/${input}`, init)))
    const rpc = async (endpoint, payload = {}) => {
      const result = await caller.call('/api', 'video-director', { endpoint, payload })
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
    return { ctx, routes, rpc }
  }
  return { ...await start(), start, profile, entryId, home }
}

test('real Loader and Settings persist provider edits, redact secrets, and restore without remounting', async t => {
  const app = await hostFixture(t)
  const fiber = [...app.ctx.loader.entries()].find(entry => entry.options.id === app.entryId).fiber
  await app.rpc('providers/update', { providerId: 'test', patch: { model: 'changed-model', apiKey: 'fixture-override-secret' } })
  assert.equal([...app.ctx.loader.entries()].find(entry => entry.options.id === app.entryId).fiber, fiber)
  assert.equal((await app.rpc('providers/list')).providers[0].model, 'changed-model')
  const form = app.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === app.entryId)
  assert.equal(JSON.stringify(form).includes('fixture-override-secret'), false)
  const patch = await readFile(app.profile.patchPath, 'utf8')
  assert.match(patch, /changed-model/)
  assert.doesNotMatch(patch, /fixture-base-secret/)
  await app.ctx.fiber.dispose()
  const restored = await app.start()
  assert.equal((await restored.rpc('providers/list')).providers[0].model, 'changed-model')
  await restored.rpc('providers/update', { providerId: 'test', patch: { clearApiKey: true, model: null } })
  assert.doesNotMatch(await readFile(app.profile.patchPath, 'utf8'), /fixture-override-secret|changed-model/)
})

test('legacy settings.yaml imports into the new volatile Config fields', async t => {
  const app = await hostFixture(t, { legacy: true })
  // The importer runs after Loader settlement, outside boot's initial await.
  for (let i = 0; i < 100 && (await app.rpc('providers/list')).providers[0].model !== 'legacy-model'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await app.rpc('providers/list')).providers[0].model, 'legacy-model')
  assert.equal([...app.ctx.loader.entries()].find(entry => entry.options.id === app.entryId).fiber.config.minimaxH3LicenseAccepted.get(), false)
  assert.match(await readFile(join(app.home, 'settings.yaml.imported'), 'utf8'), /legacy-model/)
})

test('plugin assets pass the real HTTP bridge for GET, HEAD, Range and properties', async t => {
  const app = await hostFixture(t)
  const { project } = await app.rpc('projects/create', { name: 'Route fixture', sessionId: SID })
  const { asset } = await app.rpc('assets/put', { projectId: project.id, kind: 'video', name: 'fixture.mp4', mimeType: 'video/mp4', dataBase64: Buffer.from('0123456789').toString('base64') })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const connection = new HostConnectionService(ctx, [], {})
  for (const route of app.routes.values()) {
    assert.equal(route.requestBody, 'buffered')
    connection.fetch.register(route)
  }
  const handler = connection.createSharedFetchHandler('/api')
  const errors = []
  const server = createServer(async (req, res) => {
    try { await bridge(req, res, handler, connection.browserPeer) }
    catch (error) { errors.push(error); res.writeHead(500); res.end(error.message) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}${asset.url}`
  assert.equal(await (await fetch(url)).text(), '0123456789')
  const head = await fetch(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const range = await fetch(url, { headers: { Range: 'bytes=2-5' } })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), '2345')
  const properties = await fetch(`${url}/properties`)
  // Synthetic bytes are deliberately not decodable media: reaching the
  // plugin's structured failure still proves GET made it through the bridge.
  assert.equal(properties.status, 503)
  assert.equal((await properties.json()).ok, false)
  assert.deepEqual(errors, [])
})
