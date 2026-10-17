import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import * as plugin from '../index.js'

const { Context, ClientSessions, Session, ClientAssistantStream, ProjectChatSource, HostConnectionService, bridge, createWebConnectionRpc } = await import(pathToFileURL(process.env.VD_DSH_SURFACES))
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
  const session = new Session(SID, { session: { prompt: options.prompt ?? (async () => ok({ accepted: true })) } })
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
  session.eventSource.replace([delta.entry], false)
  assert.deepEqual(chat.getSnapshot().messages.map(row => [row.text, row.status]), [['Live answer', 'streaming']])
  session.eventSource.replace([delta.entry, assistant(0, 'Final answer')], false)
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
