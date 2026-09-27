import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<button id="opener">Open</button><div id="root"></div>', { url: 'http://localhost/' })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
    import React, { act } from 'react'; import { createRoot } from 'react-dom/client';
    import { AssetPicker } from './AssetPicker'; import { setLanguage } from './i18n'; export { act };
    export function mount(props) { setLanguage('en'); const root = createRoot(document.getElementById('root')); root.render(<AssetPicker {...props}/>); return root; }
  ` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false,
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
const asset = (id, kind, origin, name) => ({ id, kind, origin, name, filename: `${origin}s/${name}`, mimeType: kind === 'sketch' ? 'image/png' : `${kind}/fixture`, size: 1024, createdAt: '2026-09-20T12:00:00.000Z' })
async function mount(t, extra = {}) {
  const calls = []
  let root
  document.getElementById('opener').focus()
  await ui.act(async () => { root = ui.mount({ kind: 'image', nodeTitle: 'Input',
    load: async kind => { calls.push(['list', kind]); return [asset('input', 'image', 'input', 'photo.png'), asset('output', 'image', 'output', 'ComfyUI_00001.png'), asset('wrong', 'audio', 'input', 'audio.flac')] },
    onSelect: async value => { calls.push(['select', value.id]) }, onClose: () => calls.push(['close']), ...extra }) })
  t.after(() => { ui.act(() => root.unmount()) })
  return { calls, root }
}
const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
async function click(element) { assert.ok(element); await ui.act(async () => element.click()) }
async function input(value) {
  await ui.act(async () => {
    const input = document.querySelector('input[type=search]')
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

test('asset picker filters by type, original provider filename, and input/output source without loading media', async t => {
  const { calls } = await mount(t)
  assert.deepEqual(calls, [['list', 'image']])
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 2)
  assert.equal(document.querySelectorAll('img, audio, video').length, 0)
  assert.equal(button('Use asset').disabled, true)
  await input('ComfyUI')
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  await click(document.querySelector('.vd-asset-picker-row'))
  await click(button('Use asset'))
  assert.deepEqual(calls.slice(1), [['select', 'output'], ['close']])
  await input('')
  await ui.act(async () => {
    const select = document.querySelector('select'); select.value = 'input'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  assert.match(document.querySelector('.vd-asset-picker-row').textContent, /photo\.png/)
  assert.equal(button('Use asset').disabled, true)
})

test('asset picker shows link failures without closing, supports Escape and returns focus', async t => {
  const { calls, root } = await mount(t, { onSelect: async () => { throw new Error('File unavailable') } })
  assert.equal(document.activeElement, document.querySelector('input[type=search]'))
  await click(document.querySelector('.vd-asset-picker-row'))
  await click(button('Use asset'))
  assert.match(document.querySelector('[role=alert]').textContent, /File unavailable/)
  assert.equal(calls.some(call => call[0] === 'close'), false)
  await ui.act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.deepEqual(calls.at(-1), ['close'])
  ui.act(() => root.unmount())
  assert.equal(document.activeElement.id, 'opener')
})

test('sketch chooser presents only sketches and reports an empty search', async t => {
  await mount(t, { kind: 'sketch', load: async () => [asset('sketch', 'sketch', 'input', 'sketch-20260920-abcd0123.png'), asset('image', 'image', 'input', 'photo.png')] })
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  await input('missing')
  assert.match(document.querySelector('.vd-asset-picker-list').textContent, /No matching assets/)
})
