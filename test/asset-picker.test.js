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
const asset = (id, kind, origin, name) => ({ id, kind, origin, name, filename: `${origin}s/${name}`, mimeType: kind === 'sketch' ? 'image/png' : `${kind}/fixture`, url: `/fixtures/${id}`, sha256: 'fixture', size: 1024, createdAt: '2026-09-20T12:00:00.000Z' })
function pageAssets(rows, kind, options) {
  const matches = rows.filter(asset => asset.kind === kind && (options.origin === 'all' || asset.origin === options.origin)
    && asset.name.toLowerCase().includes(options.query.toLowerCase()))
  const offset = Number(options.cursor ?? 0)
  return { assets: matches.slice(offset, offset + options.limit), total: matches.length, nextCursor: offset + options.limit < matches.length ? String(offset + options.limit) : null }
}
async function mount(t, extra = {}) {
  const calls = []
  let root
  document.getElementById('opener').focus()
  await ui.act(async () => { root = ui.mount({ kind: 'image', nodeTitle: 'Input',
    load: async (kind, options) => { calls.push(['list', kind, options]); return pageAssets([asset('input', 'image', 'input', 'photo.png'), asset('output', 'image', 'output', 'ComfyUI_00001.png'), asset('wrong', 'audio', 'input', 'audio.flac')], kind, options) },
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

test('asset picker requests filtered pages and renders lazy thumbnails without mounting media players', async t => {
  const { calls } = await mount(t)
  assert.deepEqual(calls, [['list', 'image', { query: '', origin: 'all', limit: 15 }]])
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 2)
  assert.equal(document.querySelectorAll('img[loading=lazy]').length, 2)
  assert.equal(document.querySelectorAll('audio, video').length, 0)
  assert.equal(button('Use asset').disabled, true)
  await input('ComfyUI')
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  await click(document.querySelector('.vd-asset-picker-select'))
  await click(button('Use asset'))
  assert.deepEqual(calls.filter(call => call[0] !== 'list'), [['select', 'output'], ['close']])
  assert.equal(calls.filter(call => call[0] === 'list').at(-1)[2].query, 'ComfyUI')
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
  await click(document.querySelector('.vd-asset-picker-select'))
  await click(button('Use asset'))
  assert.match(document.querySelector('[role=alert]').textContent, /File unavailable/)
  assert.equal(calls.some(call => call[0] === 'close'), false)
  await ui.act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.deepEqual(calls.at(-1), ['close'])
  ui.act(() => root.unmount())
  assert.equal(document.activeElement.id, 'opener')
})

test('sketch chooser presents only sketches and reports an empty search', async t => {
  await mount(t, { kind: 'sketch', load: async (kind, options) => pageAssets([asset('sketch', 'sketch', 'input', 'sketch-20260920-abcd0123.png'), asset('image', 'image', 'input', 'photo.png')], kind, options) })
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  await input('missing')
  assert.match(document.querySelector('.vd-asset-picker-list').textContent, /No matching assets/)
})

async function scrollBottom() {
  const list = document.querySelector('.vd-asset-picker-list')
  for (const [key, value] of Object.entries({scrollHeight:1000,clientHeight:300,scrollTop:700})) Object.defineProperty(list, key, {value,writable:true,configurable:true})
  await ui.act(async () => list.dispatchEvent(new dom.window.Event('scroll', {bubbles:true})))
}

test('scrolling appends exactly 15 assets and search/source changes restart from the first page', async t => {
  const rows = Array.from({length:38}, (_, index) => asset(String(index), 'image', index < 23 ? 'input' : 'output', `scene-${index}.png`))
  const requests = []
  await mount(t, {load:async (kind, options) => {requests.push(options);return pageAssets(rows, kind, options)}})
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 15)
  await scrollBottom()
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 30)
  assert.equal(requests[1].cursor, '15')
  await scrollBottom()
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 38)
  assert.equal(button('Load 15 more'), undefined)
  await ui.act(async () => {
    const select=document.querySelector('select');select.value='input';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
  })
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 15)
  assert.equal(requests.at(-1).cursor, undefined)
  assert.equal(document.querySelector('.vd-asset-picker-list').scrollTop, 0)
  await scrollBottom()
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 23)
  await input('scene-1')
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 11)
  assert.equal(requests.at(-1).cursor, undefined)
  assert.equal(requests.at(-1).query, 'scene-1')
  assert.ok(requests.every(request => request.limit === 15))
})

test('only one next-page request runs at a time and late replies cannot replace a new search', async t => {
  const rows = Array.from({length:31}, (_, index) => asset(String(index), 'image', 'input', `scene-${index}.png`))
  let resolvePage; let pageRequests=0
  await mount(t, {load:async (kind, options) => {
    if (options.cursor) {pageRequests++;return new Promise(resolve => {resolvePage=()=>resolve(pageAssets(rows,kind,options))})}
    return pageAssets(rows,kind,options)
  }})
  await scrollBottom(); await scrollBottom()
  assert.equal(pageRequests, 1)
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 15)
  await input('scene-30')
  await ui.act(async () => resolvePage())
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length, 1)
  assert.match(document.querySelector('.vd-asset-picker-row').textContent, /scene-30/)
})

test('a failed next page retains its loaded rows and retries the same cursor', async t => {
  const rows = Array.from({length:18}, (_, index) => asset(String(index), 'image', 'input', `scene-${index}.png`))
  let fail=true;const requests=[]
  await mount(t, {load:async (kind,options) => {requests.push(options);if(options.cursor && fail)throw new Error('Temporary list error');return pageAssets(rows,kind,options)}})
  await scrollBottom()
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length,15)
  assert.match(document.querySelector('[role=alert]').textContent,/Temporary list error/)
  fail=false;await click(button('Retry'))
  assert.equal(document.querySelectorAll('.vd-asset-picker-row').length,18)
  assert.equal(requests.at(-1).cursor,requests.at(-2).cursor)
})

test('thumbnail preview is separate from selection and Escape returns to the chooser', async t => {
  const {calls}=await mount(t)
  const thumbnail=document.querySelector('.vd-artifact-thumbnail')
  await click(thumbnail)
  assert.ok(document.querySelector('.vd-artifact-dialog'))
  assert.equal(button('Use asset').disabled,true)
  assert.equal(calls.some(call=>call[0]==='select'),false)
  await ui.act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.equal(document.querySelector('.vd-artifact-dialog'),null)
  assert.ok(document.querySelector('.vd-asset-picker'))
  assert.equal(calls.some(call=>call[0]==='close'),false)
  assert.equal(document.activeElement,thumbnail)
})
