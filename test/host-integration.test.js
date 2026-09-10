import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config } from '../index.js'

test('Harness RPC, asset routes and native settings remain connected after moving storage', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-director-harness-test-')))
  const routes = new Map()
  const channels = new Map()
  const disposers = []
  let schema
  let document = { providerOverrides: {} }
  const settings = {
    installSection(_owner, namespace, sectionSchema, _defaults, hooks) {
      assert.equal(namespace, 'video-director')
      schema = sectionSchema
      hooks.setSource(() => document)
    },
    async mutate(_namespace, operations) {
      const next = structuredClone(document)
      for (const operation of operations) {
        const [field, id, key] = operation.path
        next[field][id] ??= {}
        next[field][id][key] = operation.value
      }
      document = schema(next)
    },
  }
  const ctx = {
    connection: {
      fetch: { register: route => { routes.set(route.path, route) } },
      rpc: { handle: (channel, rpc) => { channels.set(channel, rpc) } },
    },
    get() {},
    inject(names, callback) { if (names.includes('settings')) callback({ settings }) },
    on(event, callback) { assert.equal(event, 'dispose'); disposers.push(callback) },
    logger: { info() {} },
  }
  t.after(async () => { await Promise.all(disposers.map(dispose => dispose())); await rm(root, { recursive: true, force: true }) })
  await apply(ctx, Config({ dataDir: join(root, 'initial'), providers: [
    { id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan' },
  ] }))
  assert.deepEqual([...channels.keys()], ['/video-director'])
  const rpc = async (endpoint, input = {}) => {
    const result = await channels.get('/video-director')(endpoint, input)
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
