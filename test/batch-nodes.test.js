import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'InputEvent']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BatchInputBody, BatchOutputBody } from './BatchNodes';
import { setLanguage } from './i18n';
export { act, setLanguage };
export function mount(initial, extra, calls) {
  function Fixture() {
    const [data, setData] = useState(initial);
    const runtime = { onChange: (_id, patch) => setData(current => ({ ...current, ...patch })),
      onRunBatch: async (...args) => { calls.push(['run', ...args]); return 'run-id'; },
      onCancelBatch: async id => { calls.push(['cancel', id]); },
      ...extra };
    const Component = data.kind === 'batch-input' ? BatchInputBody : BatchOutputBody;
    return <Component id="batch-node" data={data} runtime={runtime} />;
  }
  const root = createRoot(document.getElementById('root')); root.render(<Fixture />); return root;
}` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"development"' } })
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
async function mount(t, data, runtime = {}) {
  const calls = []; let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(data, runtime, calls) })
  t.after(() => ui.act(() => root.unmount()))
  return calls
}
const button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text)

test('Batch Input has a direct Run Batch action and validates inclusive indices', async t => {
  const calls = await mount(t, { kind: 'batch-input', batch: { source: 'text', text: 'first\nsecond', startIndex: 2, endIndex: 2 } })
  assert.equal(button('Run Batch').disabled, false)
  await ui.act(async () => button('Run Batch').click())
  assert.deepEqual(calls, [['run', 'batch-node']])
  const end = [...document.querySelectorAll('input[type=number]')][1]
  await ui.act(async () => {
    end.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(end, '1')
    end.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  assert.equal(button('Run Batch').disabled, false, 'an incomplete range edit must not be validated while typing')
  await ui.act(async () => end.blur())
  assert.equal(button('Run Batch').disabled, true)
  assert.match(document.body.textContent, /inclusive range/)
})

test('FROZEN Batch Input disables run, import and source edits', async t => {
  await mount(t, { kind: 'batch-input', frozen: true, batch: { source: 'files', items: [{ id: 'one', name: 'one', text: 'one' }] } })
  assert.equal(button('Run Batch').disabled, true)
  assert.equal(button('Choose files').disabled, true)
  assert.equal(button('Choose folder').disabled, true)
  assert.ok(document.querySelector('input[webkitdirectory]'))
})

test('Batch Input allows empty drafts, restoring required start and clearing optional end on blur', async t => {
  await mount(t, { kind: 'batch-input', batch: { source: 'text', text: 'first\nsecond', startIndex: 1, endIndex: 1 } })
  const [start, end] = document.querySelectorAll('input[type=number]')
  const clear = async input => ui.act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await clear(start)
  assert.equal(start.value, '')
  assert.equal(button('Run Batch').disabled, false)
  await ui.act(async () => start.blur())
  assert.equal(start.value, '1')
  await clear(end)
  assert.equal(end.value, '')
  await ui.act(async () => end.blur())
  assert.equal(end.value, '')
  assert.equal(button('Run Batch').disabled, false)
  await ui.act(async () => button('2 matched cases · preview').click())
  assert.equal(document.querySelectorAll('.vd-batch-excluded').length, 0, 'clearing end must include all cases')
})

test('Batch Output selects an exact failed index without showing another case’s artifact', async t => {
  const rows = [1, 2, 3].map(index => ({ caseId: `case-${index}`, caseIndex: index, batchRunId: 'run-id', input: { id: String(index), name: `Input ${index}`, text: `prompt ${index}` }, status: index === 2 ? 'failed' : 'completed', artifacts: index === 2 ? [] : [{ outputNodeId: 'batch-node', sourceNodeId: 'generator', sourcePortId: 'text', ordinal: 0, text: `result for ${index}` }], error: index === 2 ? 'Rendering failed' : undefined }))
  await mount(t, { kind: 'batch-output', batchRunId: 'run-id' }, { batchRuns: [{ id: 'run-id', startedAt: '2026-09-18T00:00:00Z', startIndex: 1, endIndex: 3, status: 'failed' }], batchCases: { 'run-id': rows } })
  const select = document.querySelector('select[aria-label="Case index"]')
  assert.equal(select.value, '3')
  await ui.act(async () => { select.value = '2'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  assert.equal(select.value, '2')
  assert.match(document.body.textContent, /Rendering failed/)
  assert.match(document.body.textContent, /No artifacts for this case/)
  assert.doesNotMatch(document.body.textContent, /result for 3/)
  assert.equal(button('Save selected case').disabled, false)
})
