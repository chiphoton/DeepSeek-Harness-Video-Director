import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'InputEvent']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx',
    contents: `
      import React, { act, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ReactFlowProvider } from '@xyflow/react';
      import { DirectorNodeView, DirectorRuntimeProvider } from './DirectorNode';
      export { act };
      export { setLanguage } from './i18n';
      function Fixture({ initial, calls }) {
        const [data, setData] = useState({ ...initial, nodeType: 'test.input' });
        const runtime = { providers: [], workflows: [],
          nodeDefinitions: [{ type: 'test.input', version: '1.0.0', fields: [], inputs: [], outputs: [] }], references: {},
          onChange: (_, patch) => setData(current => ({ ...current, ...patch })),
          onChooseInputFile: id => calls.push(['file', id]),
          onInspectInput: id => calls.push(['inspect', id]) };
        return <ReactFlowProvider><DirectorRuntimeProvider value={runtime}>
          <DirectorNodeView id="input" data={data} />
        </DirectorRuntimeProvider></ReactFlowProvider>;
      }
      export function mount(initial, calls) {
        const root = createRoot(document.getElementById('root'));
        root.render(<Fixture initial={initial} calls={calls} />);
        return root;
      }
    `,
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
})
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

function mount(t, data) {
  const calls = []
  let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mount(data, calls) })
  t.after(() => { ui.act(() => root.unmount()) })
  return calls
}

function click(element) {
  assert.ok(element)
  ui.act(() => element.click())
}

test('text input counts Unicode characters as text changes and Clear empties and disables itself', t => {
  mount(t, { kind: 'load-text', title: 'Text', text: '' })
  const textarea = document.querySelector('textarea')
  const clear = [...document.querySelectorAll('button')].find(button => button.textContent === 'Clear')
  assert.equal(clear.disabled, true)
  assert.equal(document.querySelector('output').textContent, '0 characters')
  ui.act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Hello 🎬')
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  assert.equal(document.querySelector('output').textContent, '7 characters')
  assert.equal(clear.disabled, false)
  click(clear)
  assert.equal(textarea.value, '')
  assert.equal(document.querySelector('output').textContent, '0 characters')
  assert.equal(clear.disabled, true)
})

test('Import targets the text input and its new controls follow the selected language', t => {
  const calls = mount(t, { kind: 'load-text', title: 'Text', text: '你好' })
  click(document.querySelector('[title="Import text from a UTF-8 file"]'))
  assert.deepEqual(calls, [['file', 'input']])
  ui.act(() => ui.setLanguage('zh'))
  assert.equal(document.querySelector('output').textContent, '2 个字符')
  assert.match(document.querySelector('.vd-text-input-actions').textContent, /导入.*清空/)
})

for (const kind of ['image', 'video']) {
  test(`${kind} filename opens replacement while image inspection and video playback remain separate`, t => {
    const calls = mount(t, { kind: `load-${kind}`, mediaKind: kind, title: 'Reference', asset: {
      id: 'asset', kind, name: `${kind}.test`, size: 1024, url: '/asset',
    } })
    const filename = document.querySelector('.vd-input-filename')
    assert.equal(filename.getAttribute('aria-label'), `Replace ${kind}.test`)
    assert.equal(filename.querySelector('.vd-input-filename-text').textContent, `${kind}.test`)
    assert.match(filename.querySelector('.vd-input-filename-action').textContent, /Replace/)
    click(filename)
    assert.deepEqual(calls, [['file', 'input']])
    if (kind === 'image') {
      click(document.querySelector(`[aria-label="Inspect ${kind}.test"]`))
      assert.deepEqual(calls, [['file', 'input'], ['inspect', 'input']])
    } else {
      assert.equal(document.querySelector('video').controls, true)
    }
  })
}
