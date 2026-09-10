import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderSettings } from '../src/provider-settings.js'

function applyPath(root, op) {
  const path = [...op.path]
  const key = path.pop()
  let cursor = root
  for (const segment of path) cursor = cursor[segment] ??= {}
  if (op.op === 'unset') delete cursor[key]
  else cursor[key] = op.value
}

test('Fast is a Codex-only boolean setting and an explicit off value is preserved', async () => {
  const document = { providerOverrides: {} }
  const settings = new ProviderSettings({ providers: [
    { id: 'codex-plan', kind: 'codex-plan', fastMode: false },
    { id: 'ollama', kind: 'ollama' },
  ] }, () => {})
  settings.attach({ mutate: async (_namespace, ops) => { for (const op of ops) applyPath(document, op) } }, () => document)
  assert.equal(settings.resolved().providers[0].fastMode, false)
  await settings.updateProvider('codex-plan', { fastMode: true })
  assert.equal(settings.resolved().providers[0].fastMode, true)
  await settings.updateProvider('codex-plan', { fastMode: false })
  assert.equal(document.providerOverrides['codex-plan'].fastMode, false)
  await assert.rejects(settings.updateProvider('codex-plan', { fastMode: 'true' }), /boolean/u)
  await assert.rejects(settings.updateProvider('ollama', { fastMode: true }), /only available for Codex/u)
})

test('ProviderSettings accepts the MiniMax H3 license by default while preserving explicit opt-out', () => {
  let document = { providerOverrides: {} }
  const settings = new ProviderSettings({ providers: [] }, () => {})

  assert.equal(settings.resolved().minimaxH3LicenseAccepted, true)

  settings.attach({ mutate: async () => {} }, () => document)
  assert.equal(settings.resolved().minimaxH3LicenseAccepted, true)

  document = { providerOverrides: {}, minimaxH3LicenseAccepted: false }
  assert.equal(settings.resolved().minimaxH3LicenseAccepted, false)

  const optedOut = new ProviderSettings({ providers: [], minimaxH3LicenseAccepted: false }, () => {})
  assert.equal(optedOut.resolved().minimaxH3LicenseAccepted, false)
})

test('ProviderSettings writes live overrides without materializing base secrets', async () => {
  const document = { providerOverrides: {}, minimaxH3LicenseAccepted: false }
  const changes = []
  const settings = new ProviderSettings({
    providers: [{
      id: 'openai',
      label: 'OpenAI compatible',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'environment-secret',
      model: 'gpt-text',
    }],
    minimaxH3LicenseAccepted: false,
  }, value => changes.push(value))
  const writer = {
    async mutate(namespace, ops) {
      assert.equal(namespace, 'video-director')
      for (const op of ops) applyPath(document, op)
    },
  }
  settings.attach(writer, () => document)

  await settings.updateProvider('openai', {
    baseUrl: 'https://gateway.example.test/v1/',
    model: 'vision-model',
  })
  assert.deepEqual(document.providerOverrides, {
    openai: {
      baseUrl: 'https://gateway.example.test/v1',
      model: 'vision-model',
    },
  })
  assert.equal(JSON.stringify(document).includes('environment-secret'), false)
  assert.equal(settings.resolved().providers[0].apiKey, 'environment-secret')
  assert.equal(settings.resolved().providers[0].baseUrl, 'https://gateway.example.test/v1')

  await settings.updateProvider('openai', { apiKey: 'user-secret' })
  assert.equal(document.providerOverrides.openai.apiKey, 'user-secret')
  await settings.updateProvider('openai', { clearApiKey: true })
  assert.equal('apiKey' in document.providerOverrides.openai, false)
  assert.equal(changes.length >= 4, true)
})

test('ProviderSettings rejects non-http endpoints and unknown provider fields', async () => {
  const settings = new ProviderSettings({
    providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
  }, () => {})
  settings.attach({ mutate: async () => {} }, () => ({ providerOverrides: {} }))

  await assert.rejects(settings.updateProvider('ollama', { baseUrl: 'file:///tmp/socket' }), /http or https/i)
  await assert.rejects(settings.updateProvider('ollama', { kind: 'openai-compatible' }), /not editable/i)
})

test('ProviderSettings normalizes ComfyUI host and port shorthand', async () => {
  const document = { providerOverrides: {} }
  const settings = new ProviderSettings({
    providers: [{ id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188' }],
  }, () => {})
  settings.attach({
    async mutate(_namespace, ops) {
      for (const op of ops) applyPath(document, op)
    },
  }, () => document)

  await settings.updateProvider('comfyui', { baseUrl: '127.0.0.1:8188' })

  assert.equal(document.providerOverrides.comfyui.baseUrl, 'http://127.0.0.1:8188')
  assert.equal(settings.resolved().providers[0].baseUrl, 'http://127.0.0.1:8188')
})

test('ProviderSettings keeps ComfyUI transport controls Host-owned', async () => {
  const document = {
    providerOverrides: {
      comfyui: {
        mcpTool: 'mcp__browser_supplied__call_tool',
        mcpBaseUrl: 'http://browser-supplied.invalid:8188',
      },
    },
  }
  const settings = new ProviderSettings({
    providers: [{
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui-mcp',
      baseUrl: 'http://127.0.0.1:8188',
      mcpTool: 'mcp__host_owned__call_tool',
      mcpBaseUrl: 'http://127.0.0.1:8188',
    }],
  }, () => {})
  settings.attach({ mutate: async () => assert.fail('hidden transport controls must not be written') }, () => document)

  const provider = settings.resolved().providers[0]
  assert.equal(provider.mcpTool, 'mcp__host_owned__call_tool')
  assert.equal(provider.mcpBaseUrl, 'http://127.0.0.1:8188')
  await assert.rejects(
    settings.updateProvider('comfyui', { mcpTool: 'mcp__browser_supplied__call_tool' }),
    /not editable/i,
  )
  await assert.rejects(
    settings.updateProvider('comfyui', { mcpBaseUrl: 'http:\/\/browser-supplied.invalid:8188' }),
    /not editable/i,
  )
})
