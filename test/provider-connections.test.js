import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'InputEvent']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: String.raw`
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProviderConnections } from './ProviderConnections';
import { setLanguage } from './i18n';
export { act, setLanguage };
export function mount(fixture) {
  function Fixture() {
    const [snapshot, setSnapshot] = useState({ providers: fixture.providers, providerChecks: {} });
    fixture.snapshot = snapshot;
    fixture.publish = setSnapshot;
    const director = {
      getSnapshot: () => fixture.snapshot,
      updateProvider: async (id, patch) => {
        fixture.calls.push(['save', id, patch]); await fixture.save?.(id, patch);
        setSnapshot(current => ({ ...current, providers: current.providers.map(provider => provider.id !== id ? provider : {
          ...provider, ...(patch.baseUrl !== undefined ? { baseUrl: new URL(patch.baseUrl.includes('://') ? patch.baseUrl : 'http://' + patch.baseUrl).href.replace(/\/$/, '') } : {}),
          ...('apiKey' in patch ? { apiKeySet: true } : {}), ...(patch.clearApiKey ? { apiKeySet: false } : {}),
          ...('fastMode' in patch ? { fastMode: patch.fastMode } : {})
        }) }));
      },
      checkProvider: async id => { fixture.calls.push(['check', id]); },
      unloadProviderModels: async id => { fixture.calls.push(['unload', id]); return id === 'comfy' ? 'requested' : 'unloaded'; },
    };
    return <ProviderConnections snapshot={snapshot} director={director} />;
  }
  const root = createRoot(document.getElementById('root')); root.render(<Fixture />); return root;
}` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"development"' } })
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
const providers = [
  { id: 'openai', kind: 'openai-compatible', baseUrl: 'http://api.test/v1', apiKeySet: true, availableModels: ['api-text', 'api-image'] },
  { id: 'codex', kind: 'codex-plan', fastMode: false, availableModels: ['coding-model'] },
  { id: 'comfy', kind: 'comfyui', baseUrl: 'http://comfy.test', availableModels: ['clip.safetensors', 'video.safetensors'] },
  { id: 'ollama', kind: 'ollama', baseUrl: 'http://ollama.test', loadedModels: ['vision:latest'], availableModels: ['vision:latest', 'text:latest'] },
].map(row => ({ ...row, label: 'Configured label', configured: true, model: 'hidden-default', imageModel: 'hidden-image-default' }))
async function mount(t, options = {}) {
  const fixture = { providers: structuredClone(providers), calls: [], ...options }; let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(fixture) })
  t.after(() => ui.act(() => root.unmount()))
  return fixture
}
const card = id => document.querySelector(`[data-provider-id="${id}"]`)
const url = id => card(id).querySelector('.vd-provider-endpoint input')
const button = (id, label) => [...card(id).querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function type(input, value) {
  await ui.act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const blur = input => ui.act(async () => input.blur())
const click = element => ui.act(async () => element.click())

test('Connections uses the requested order, compact model lists, and provider-specific actions', async t => {
  await mount(t)
  assert.deepEqual([...document.querySelectorAll('h3')].map(el => el.textContent), ['Ollama', 'ComfyUI', 'OpenAI Compatible', 'Codex Coding Plan'])
  assert.equal(document.querySelectorAll('.vd-settings-note, select').length, 0)
  assert.doesNotMatch(document.body.textContent, /hidden-default|Save settings|Configured label/)
  assert.match(card('ollama').textContent, /vision:latestLoaded/)
  assert.match(card('openai').textContent, /api-text/)
  for (const id of ['ollama', 'comfy']) assert.ok(button(id, 'Unload Models'))
  for (const id of ['openai', 'codex']) assert.equal(button(id, 'Unload Models'), undefined)
})

test('editing only saves after blur and writes just that field', async t => {
  const fixture = await mount(t)
  await type(url('ollama'), 'http://new.test')
  assert.deepEqual(fixture.calls, [])
  await blur(url('ollama'))
  assert.deepEqual(fixture.calls, [['save', 'ollama', { baseUrl: 'http://new.test' }]])
  await ui.act(async () => url('ollama').focus())
  await blur(url('ollama'))
  assert.equal(fixture.calls.length, 1)
})

test('Refresh waits for the blur save without disabling and swallowing the click', async t => {
  const gate = deferred()
  const fixture = await mount(t, { save: () => gate.promise })
  await type(url('ollama'), 'http://new.test')
  await blur(url('ollama'))
  const refresh = button('ollama', 'Check connection and refresh models')
  assert.equal(refresh.disabled, false)
  await click(refresh)
  assert.deepEqual(fixture.calls.map(call => call[0]), ['save'])
  await ui.act(async () => gate.resolve())
  assert.deepEqual(fixture.calls.map(call => call[0]), ['save', 'check'])
})

test('acknowledging a pending save keeps a newer URL draft until its own blur', async t => {
  const gate = deferred()
  const fixture = await mount(t, { save: () => gate.promise })
  await type(url('ollama'), 'http://first.test'); await blur(url('ollama'))
  await type(url('ollama'), 'http://second.test')
  await ui.act(async () => gate.resolve())
  assert.equal(url('ollama').value, 'http://second.test')
  assert.equal(fixture.calls.length, 1)
  await blur(url('ollama'))
  assert.equal(fixture.calls[1][2].baseUrl, 'http://second.test')
})

test('a late secret save does not erase a newer replacement and empty secrets are never sent', async t => {
  const gate = deferred()
  const fixture = await mount(t, { save: () => gate.promise })
  const input = card('openai').querySelector('input[type=password]')
  await type(input, 'synthetic-key-one'); await blur(input)
  await type(input, 'synthetic-key-two')
  await ui.act(async () => gate.resolve())
  assert.equal(input.value, 'synthetic-key-two')
  await blur(input)
  assert.equal(input.value, '')
  assert.deepEqual(fixture.calls.map(row => row[2]), [{ apiKey: 'synthetic-key-one' }, { apiKey: 'synthetic-key-two' }])
  await type(input, ''); await blur(input)
  assert.equal(fixture.calls.length, 2)
  await click(button('openai', 'Clear saved key'))
  assert.deepEqual(fixture.calls.at(-1)[2], { clearApiKey: true })
})

test('failed autosave leaves an editable draft and Retry saves it', async t => {
  let fail = true
  const fixture = await mount(t, { save: async () => { if (fail) throw new Error('Settings unavailable') } })
  await type(url('comfy'), 'http://new-comfy.test'); await blur(url('comfy'))
  assert.match(card('comfy').querySelector('[role=alert]').textContent, /Settings unavailable/)
  assert.equal(url('comfy').value, 'http://new-comfy.test')
  fail = false
  await click(button('comfy', 'Retry'))
  assert.equal(card('comfy').querySelector('[role=alert]'), null)
  assert.equal(fixture.calls.length, 2)
})

test('unload targets its own provider and the priority toggle autosaves', async t => {
  const fixture = await mount(t)
  await click(button('ollama', 'Unload Models'))
  await click(button('comfy', 'Unload Models'))
  await click(card('codex').querySelector('input[type=checkbox]'))
  assert.deepEqual(fixture.calls, [['unload', 'ollama'], ['unload', 'comfy'], ['save', 'codex', { fastMode: true }]])
  assert.match(card('comfy').textContent, /Unload requested/)
})

test('abandoning a failed replacement key keeps the saved key and allows refresh', async t => {
  const fixture = await mount(t, { save: async () => { throw new Error('Settings unavailable') } })
  const input = card('openai').querySelector('input[type=password]')
  await type(input, 'synthetic-replacement'); await blur(input)
  assert.ok(card('openai').querySelector('[role=alert]'))
  await type(input, ''); await blur(input)
  await click(button('openai', 'Check connection and refresh models'))
  assert.equal(card('openai').querySelector('[role=alert]'), null)
  assert.deepEqual(fixture.calls.map(call => call[0]), ['save', 'check'])
})

test('large model inventories render in chunks and search the full list', async t => {
  const rows = structuredClone(providers)
  rows.find(row => row.id === 'ollama').availableModels = Array.from({ length: 180 }, (_, index) => `model-${index}`)
  await mount(t, { providers: rows })
  assert.equal(card('ollama').querySelectorAll('li').length, 30)
  await type(card('ollama').querySelector('input[type=search]'), 'model-179')
  assert.equal(card('ollama').querySelectorAll('li').length, 1)
  assert.match(card('ollama').querySelector('li').textContent, /model-179/)
})

test('ComfyUI tabs show only their folder inventory and reset search and pagination when switching', async t => {
  const rows = structuredClone(providers)
  const comfy = rows.find(row => row.id === 'comfy')
  comfy.availableModels = ['beta', 'euler', 'fp8', 'workflow-choice.safetensors']
  comfy.modelInventory = {
    checkpoints: { models: ['checkpoint.safetensors'] },
    diffusion_models: { models: Array.from({ length: 75 }, (_, index) => `diffusion-${index}.safetensors`) },
    loras: { models: ['style.safetensors'] },
    vae: { models: [] },
  }
  await mount(t, { providers: rows })
  const tabs = [...card('comfy').querySelectorAll('[role=tab]')]
  assert.deepEqual(tabs.map(tab => tab.textContent), ['checkpoints', 'diffusion_models', 'loras', 'vae'])
  assert.equal(card('comfy').querySelector('li').textContent, 'checkpoint.safetensors')
  assert.doesNotMatch(card('comfy').textContent, /beta|euler|fp8|workflow-choice/)
  await click(tabs[1])
  assert.equal(card('comfy').querySelectorAll('li').length, 30)
  await click(button('comfy', 'Show more'))
  assert.equal(card('comfy').querySelectorAll('li').length, 60)
  await type(card('comfy').querySelector('input[type=search]'), 'diffusion-74')
  assert.equal(card('comfy').querySelector('li').textContent, 'diffusion-74.safetensors')
  await click(tabs[2])
  assert.equal(card('comfy').querySelector('li').textContent, 'style.safetensors')
  await click(tabs[1])
  assert.equal(card('comfy').querySelectorAll('li').length, 30)
  assert.equal(card('comfy').querySelector('input[type=search]').value, '')
  await ui.act(() => tabs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' })))
  assert.equal(tabs[3].getAttribute('aria-selected'), 'true')
  assert.equal(document.activeElement, tabs[3])
  assert.equal(card('comfy').querySelectorAll('li').length, 0)
})

test('a failed model folder reports its error without falling back to workflow enums', async t => {
  const rows = structuredClone(providers)
  rows.find(row => row.id === 'comfy').modelInventory = { checkpoints: { models: [], error: 'Inventory unavailable' } }
  await mount(t, { providers: rows })
  assert.equal(card('comfy').querySelector('[role=alert]').textContent, 'Inventory unavailable')
  assert.equal(card('comfy').querySelectorAll('li').length, 0)
  assert.match(card('codex').textContent, /Uses your local Codex sign-in and coding plan\./)
  assert.doesNotMatch(card('codex').textContent, /Local Codex/)
})
