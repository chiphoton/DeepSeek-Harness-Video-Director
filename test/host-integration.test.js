import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config } from '../index.js'
import { testHost } from './fixtures/director-host.js'
import { providerConnectionsFixture } from './fixtures/provider-connections.js'

test('connection edits, discovery, and scoped unload work through the Host RPC', async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-director-connections-test-'))
  const fixture = providerConnectionsFixture()
  const host = await testHost(root, { providerOptions: { fetchImpl: fixture.fetchImpl } })
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  host.providerSettings.base.providers = fixture.providers
  host.providerSettings.refresh()
  const saved = await host.rpc('providers/update', { providerId: 'ollama', patch: { baseUrl: 'ollama-new.test:11434' } })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.providers.find(provider => provider.id === 'ollama').baseUrl, 'http://ollama-new.test:11434')
  const catalog = await host.rpc('providers/check', { providerId: 'openai' })
  assert.deepEqual(catalog.value.models, ['studio-chat', 'studio-image'])
  assert.equal(JSON.stringify(catalog).includes('synthetic-key'), false)
  const unloaded = await host.rpc('providers/unload-models', { providerId: 'ollama' })
  assert.deepEqual(unloaded, { ok: true, value: { status: 'unloaded', unloadedModels: ['studio-vision:27b'] } })
  assert.deepEqual((await host.rpc('providers/models', { providerId: 'ollama' })).value.loadedModels, [])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'POST').map(call => call.url), ['http://ollama-new.test:11434/api/generate'])
  assert.deepEqual(await host.rpc('providers/unload-models', { providerId: 'comfyui' }), { ok: true, value: { status: 'requested' } })
  assert.deepEqual(fixture.calls.at(-1).body, { unload_models: true, free_memory: true })
  assert.equal((await host.rpc('providers/unload-models', { providerId: 'openai' })).ok, false)
  const comfyCatalog = await host.rpc('providers/models', { providerId: 'comfyui' })
  assert.equal(comfyCatalog.ok, true)
  assert.deepEqual(comfyCatalog.value.modelInventory, Object.fromEntries(Object.entries(fixture.modelInventory).map(([folder, models]) => [folder, { models }])))
  assert.equal('modelInputs' in comfyCatalog.value, false)
})

test('Harness RPC, asset routes and native settings remain connected after moving storage', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-director-harness-test-')))
  const routes = new Map()
  const disposers = []
  const listeners = new Map()
  let document = { providerOverrides: {} }
  const settings = {
    async mutate(namespace, operations) {
      assert.equal(namespace, 'director-custom-entry')
      const next = structuredClone(document)
      for (const operation of operations) {
        const [field, id, key] = operation.path
        next[field][id] ??= {}
        next[field][id][key] = operation.value
      }
      document = { providerOverrides: Config({ providerOverrides: next.providerOverrides }).providerOverrides.get() }
      listeners.get('loader/volatile-update')?.()
    },
  }
  const ctx = {
    connection: {
      fetch: { register: route => { assert.equal(route.requestBody, 'buffered'); routes.set(route.path, route); return () => routes.delete(route.path) } },
    },
    get() {},
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    fiber: { entry: { options: { id: 'director-custom-entry' } } },
    inject(names, callback) { if (names.includes('settings')) callback({ settings, effect: fn => { disposers.push(fn()) } }) },
    on(event, callback) { if (event === 'dispose') disposers.push(callback); else listeners.set(event, callback) },
    logger: { info() {} },
  }
  t.after(async () => { await Promise.all(disposers.map(dispose => dispose())); await rm(root, { recursive: true, force: true }) })
  await apply(ctx, { ...Config({ dataDir: join(root, 'initial'), providers: [
    { id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan' },
  ] }), providerOverrides: { get: () => document.providerOverrides } })
  assert.ok(routes.has('/api/video-director'))
  const rpc = async (endpoint, input = {}) => {
    const response = await routes.get('/api/video-director').fetch(new Request('http://localhost/api/video-director', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'video-director', payload: { endpoint, payload: input } }),
    }))
    const { result } = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const { project } = await rpc('projects/create', { name: 'Harness project', sessionId: 'existing-harness-session' })
  const { asset } = await rpc('assets/put', {
    projectId: project.id, kind: 'image', name: 'native.png', mimeType: 'image/png', dataBase64: Buffer.from('native asset').toString('base64'),
  })
  await rpc('providers/update', { providerId: 'codex-plan', patch: { fastMode: true } })
  assert.equal(document.providerOverrides['codex-plan'].fastMode, true)
  const readAsset = () => routes.get(asset.url).fetch(new Request(`http://localhost${asset.url}`)).then(response => response.text())
  assert.equal(await readAsset(), 'native asset')
  await rpc('storage/change', { dataDir: join(root, 'moved'), expectedDataDir: join(root, 'initial') })
  // Route callbacks must resolve the current store, including after reset and later moves.
  assert.equal(await readAsset(), 'native asset')
  assert.equal((await rpc('projects/get', { projectId: project.id })).project.sessionId, 'existing-harness-session')
  assert.equal((await rpc('providers/list')).providers[0].fastMode, true)
  await rpc('providers/update', { providerId: 'codex-plan', patch: { fastMode: false } })
  assert.equal(document.providerOverrides['codex-plan'].fastMode, false)
  assert.equal((await rpc('providers/list')).providers[0].fastMode, false)
  await rpc('storage/reset', { expectedDataDir: join(root, 'moved') })
  assert.equal(await readAsset(), 'native asset')
})
