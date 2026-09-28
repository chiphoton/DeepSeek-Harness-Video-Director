import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'InputEvent']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
    import React, { act, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlowProvider } from '@xyflow/react';
    import { DirectorNodeView, DirectorRuntimeProvider } from './DirectorNode';
    import { setLanguage } from './i18n';
    export { act, setLanguage };
    export function mount(calls, field = {}) {
      function Fixture() {
        const [data, setData] = useState({ kind: 'video-generation', nodeType: 'test.numeric', title: 'Synthetic video', duration: 10 });
        const runtime = { providers: [], workflows: [], references: {},
          nodeDefinitions: [{ type: 'test.numeric', version: '1.0.0', behavior: 'workflow', inputs: [], outputs: [],
            fields: [{ id: 'duration', label: 'Duration', type: 'number', default: 10, min: 1, max: 15, placement: 'primary', ...field }] }],
          onChange: (_, patch) => { calls.push(patch); setData(current => ({ ...current, ...patch })); } };
        return <ReactFlowProvider><DirectorRuntimeProvider value={runtime}>
          <DirectorNodeView id="video" data={data} />
          <button onClick={() => setData(current => ({ ...current, progress: .5 }))}>Poll progress</button>
          <button onClick={() => setData(current => ({ ...current, duration: 12 }))}>External edit</button>
        </DirectorRuntimeProvider></ReactFlowProvider>;
      }
      const root = createRoot(document.getElementById('root')); root.render(<Fixture />); return root;
    }
  ` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', target: 'es2022', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports

function mount(t, field) {
  const calls = []; let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mount(calls, field) })
  t.after(() => ui.act(() => root.unmount()))
  const input = [...document.querySelectorAll('label')].find(label => label.textContent === 'Duration').querySelector('input')
  ui.act(() => input.focus())
  return { calls, input }
}

function type(input, value) {
  ui.act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

test('workflow duration can be cleared and replaced without publishing an incomplete edit', t => {
  const { input, calls } = mount(t)
  type(input, '1')
  type(input, '')
  assert.equal(input.value, '', 'clearing 10 must leave an empty editing draft')
  assert.deepEqual(calls, [], 'typing must not change the workflow until Enter or blur')
  type(input, '8')
  ui.act(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.equal(input.value, '8')
  assert.deepEqual(calls, [{ duration: 8 }])
  ui.act(() => document.getElementById('outside').focus())
  assert.equal(calls.length, 1, 'blur after Enter must not publish the same edit twice')
})

test('a background canvas update preserves the exact numeric draft and the focused input', t => {
  const { input, calls } = mount(t)
  type(input, '008')
  ui.act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Poll progress').click())
  assert.equal(document.activeElement, input)
  assert.equal(input.value, '008')
  assert.deepEqual(calls, [])
  ui.act(() => input.blur())
  assert.equal(input.value, '8')
  assert.deepEqual(calls, [{ duration: 8 }])
})

test('range and integer validation runs on commit, without rejecting intermediate digits', t => {
  const { input, calls } = mount(t, { integer: true })
  type(input, '20')
  assert.equal(input.value, '20')
  assert.deepEqual(calls, [])
  ui.act(() => input.blur())
  assert.equal(input.value, '15')
  assert.deepEqual(calls, [{ duration: 15 }])
  ui.act(() => input.focus())
  type(input, '2.8')
  assert.equal(input.value, '2.8')
  ui.act(() => input.blur())
  assert.equal(input.value, '3')
  assert.deepEqual(calls.at(-1), { duration: 3 })
})

test('empty or invalid required commits restore the latest model value without writing zero or NaN', t => {
  const { input, calls } = mount(t)
  type(input, '')
  ui.act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'External edit').click())
  assert.equal(input.value, '', 'even a changed external value must not overwrite a draft')
  ui.act(() => input.blur())
  assert.equal(input.value, '12')
  assert.deepEqual(calls, [])
  ui.act(() => input.focus())
  type(input, '1e')
  ui.act(() => input.blur())
  assert.equal(input.value, '12')
  assert.deepEqual(calls, [])
})

test('fractional and negative numbers survive editing and commit intact', t => {
  const { input, calls } = mount(t, { min: -15, step: 'any' })
  type(input, '-0.25')
  assert.deepEqual(calls, [])
  ui.act(() => input.blur())
  assert.equal(input.value, '-0.25')
  assert.deepEqual(calls, [{ duration: -.25 }])
})

test('schema sliders still update the model while dragging', t => {
  const { input, calls } = mount(t, { control: 'slider' })
  assert.equal(input.type, 'range')
  type(input, '8')
  assert.deepEqual(calls, [{ duration: 8 }])
})
