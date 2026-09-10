import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexModelCatalog, fetchCodexModels } from '../src/codex-model-catalog.js'

const model = (id, extra = {}) => ({ id, model: id, displayName: id, defaultReasoningEffort: 'low', ...extra })

function appServer(respond) {
  const messages = []
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line)
      messages.push(message)
      const result = respond(message)
      if (result !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, ...result }) + '\n'))
    }
    done()
  } })
  child.kill = () => { if (!child.signalCode) { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit', null)) }; return true }
  return { child, messages, options: {
    checkAccess() {},
    spawnProcess(executable, args, options) {
      assert.ok(executable)
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://'])
      assert.equal(options.shell, false)
      return child
    },
  } }
}

test('model discovery initializes stdio, paginates visible models, and stops without starting a thread', async () => {
  const fixture = appServer(message => {
    if (message.method === 'initialize') return { result: {} }
    if (message.method === 'model/list') return { result: message.params.cursor
      ? { data: [model('future-variant')], nextCursor: null }
      : { data: [model('future-base')], nextCursor: 'page-two' } }
  })
  assert.deepEqual((await fetchCodexModels(fixture.options)).map(row => row.model), ['future-base', 'future-variant'])
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'initialized', 'model/list', 'model/list'])
  assert.deepEqual(fixture.messages[2].params, { limit: 100, includeHidden: false })
  assert.equal(fixture.messages[3].params.cursor, 'page-two')
  assert.equal(fixture.child.signalCode, 'SIGTERM')
})

test('model discovery rejects protocol errors, repeated cursors, timeouts, and cancellation', async () => {
  for (const [response, expected] of [
    [{ error: { message: 'Account not signed in' } }, /Account not signed in/u],
    [{ result: { data: [], nextCursor: 'repeat' } }, /pagination/u],
    [{ result: { data: null } }, /invalid model catalog/u],
  ]) {
    const fixture = appServer(message => message.method === 'initialize' ? { result: {} } : message.method === 'model/list' ? response : undefined)
    await assert.rejects(fetchCodexModels(fixture.options), expected)
    assert.equal(fixture.child.signalCode, 'SIGTERM')
  }
  const timeout = appServer(() => undefined)
  await assert.rejects(fetchCodexModels({ ...timeout.options, timeoutMs: 10 }), /timed out/u)
  const controller = new AbortController()
  const abort = appServer(() => undefined)
  const pending = fetchCodexModels({ ...abort.options, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(abort.child.signalCode, 'SIGTERM')
})

test('catalog discovers arbitrary new variants, filters hidden models, and follows each default effort', async () => {
  let calls = 0
  let rows = [model('new-base', { isDefault: true, serviceTiers: [{ id: 'priority' }] }), model('internal', { hidden: true })]
  let now = 1000
  const catalog = new CodexModelCatalog({ now: () => now, fetchModels: async () => { calls++; return rows } })
  assert.deepEqual(catalog.snapshot().models, [])
  await Promise.all([catalog.refresh(), catalog.refresh()])
  assert.equal(calls, 1)
  assert.deepEqual(catalog.snapshot().models, ['new-base'])
  assert.deepEqual(await catalog.resolve(), { model: 'new-base', reasoningEffort: 'low', serviceTier: 'default' })
  assert.equal((await catalog.resolve(undefined, { fastMode: true })).serviceTier, 'priority')
  assert.equal(calls, 1)
  rows = [...rows, model('new-base-long', { defaultReasoningEffort: 'ultra', inputModalities: ['text'] })]
  await catalog.refresh({ force: true })
  assert.deepEqual(await catalog.resolve('new-base-long', { fastMode: true }), { model: 'new-base-long', reasoningEffort: 'ultra', serviceTier: 'default' })
  await assert.rejects(catalog.resolve('new-base-long', { imageInput: true }), /does not support image references/u)
  await assert.rejects(catalog.resolve('retired-model'), /retired-model.*no longer available/u)
  now += 5 * 60_000
  await catalog.refresh()
  assert.equal(calls, 3)
})

test('last successful catalog survives restart and network failure, but a successful empty catalog replaces it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-model-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'codex-models.json')
  const catalog = new CodexModelCatalog({ cachePath, fetchModels: async () => [model('account-model', { serviceTiers: [{ id: 'priority' }] })] })
  await catalog.init()
  await catalog.refresh()
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).models[0].id, 'account-model')
  let offline = true
  let requests = 0
  const reopened = new CodexModelCatalog({ cachePath, fetchModels: async () => { requests++; if (offline) throw new Error('Offline'); return [] } })
  await reopened.init()
  assert.equal(reopened.snapshot().codexCatalog.source, 'cache')
  assert.deepEqual((await reopened.refresh()).models, ['account-model'])
  assert.equal(reopened.snapshot().codexCatalog.error, 'Offline')
  assert.equal((await reopened.resolve('account-model', { fastMode: true })).serviceTier, 'priority')
  assert.equal(requests, 1, 'Do not repeatedly retry an offline catalog during one workflow')
  offline = false
  await reopened.refresh({ force: true })
  assert.deepEqual(reopened.snapshot().models, [])
  await assert.rejects(reopened.resolve('account-model'), /no longer available/u)
})

test('an unavailable or corrupt catalog never creates hardcoded fallback models', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-model-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'codex-models.json')
  await writeFile(cachePath, 'not json')
  const catalog = new CodexModelCatalog({ cachePath, fetchModels: async () => { throw new Error('Offline') } })
  await catalog.init()
  await assert.rejects(catalog.refresh(), /Offline/u)
  assert.deepEqual(catalog.snapshot().models, [])
  assert.equal(catalog.snapshot().codexCatalog.source, 'unavailable')
})

test('closing the catalog aborts an in-flight discovery', async () => {
  const catalog = new CodexModelCatalog({ fetchModels: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const pending = catalog.refresh()
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await catalog.close()
  await rejected
})
