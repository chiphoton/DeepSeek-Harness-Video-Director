import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
      function Fixture({ initial, calls, extra }) {
        const [data, setData] = useState({ ...initial, nodeType: 'test.input' });
        const runtime = { providers: [], workflows: [],
          nodeDefinitions: [{ type: 'test.input', version: '1.0.0', fields: [], inputs: [], outputs: [] }], references: {},
          onChange: (_, patch) => setData(current => ({ ...current, ...patch })),
          onChooseInputFile: id => calls.push(['file', id]),
          onReplaceInputFile: async (id, file) => calls.push(['replace', id, file.name]),
          onImportBatchFiles: async (id, files) => calls.push(['batch', id, files.map(file => file.name)]),
          onInspectInput: id => calls.push(['inspect', id]), ...extra };
        return <ReactFlowProvider><DirectorRuntimeProvider value={runtime}>
          <div onDrop={() => calls.push(['canvas-drop'])}>
          <DirectorNodeView id="input" data={data} />
          </div>
        </DirectorRuntimeProvider></ReactFlowProvider>;
      }
      export function mount(initial, calls, extra) {
        const root = createRoot(document.getElementById('root'));
        root.render(<Fixture initial={initial} calls={calls} extra={extra} />);
        return root;
      }
    `,
  },
  bundle: true, format: 'cjs', platform: 'node', packages: 'external', target: 'es2022', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports

function mount(t, data, extra = {}) {
  const calls = []
  let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mount(data, calls, extra) })
  t.after(() => { ui.act(() => root.unmount()) })
  return calls
}

function click(element) {
  assert.ok(element)
  ui.act(() => element.click())
}

for (const kind of ['image', 'audio', 'video', 'sketch']) {
  test(`${kind} input can open the existing asset chooser with or without an attached file`, t => {
    let selected
    mount(t, { kind: `load-${kind}`, mediaKind: kind, title: 'Input' }, {
      onChooseExistingAsset: id => { selected = id },
    })
    click([...document.querySelectorAll('button')].find(button => button.textContent === 'Choose from assets'))
    assert.equal(selected, 'input')
    if (kind === 'sketch') assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Draw sketch'))
  })
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

for (const kind of ['image', 'audio', 'video']) {
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
      assert.equal(document.querySelector(kind).controls, true)
    }
  })
}

async function drop(files, target = document.querySelector('[data-director-node]')) {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  await ui.act(async () => target.dispatchEvent(event))
  assert.equal(event.defaultPrevented, true, 'file drops must not navigate away')
}

for (const [kind, name] of [['text', 'script.MD'], ['image', 'photo.PNG'], ['audio', 'sound.WAV'], ['video', 'clip.MOV']]) {
  test(`${kind} input consumes a matching file drop from its controls without creating another node`, async t => {
    const calls = mount(t, { kind: `load-${kind}`, title: 'Input', mediaKind: kind })
    await drop([new File(['content'], name)], document.querySelector(kind === 'text' ? 'textarea' : 'input'))
    assert.deepEqual(calls, [['replace', 'input', name]])
  })
}

test('wrong extensions and multiple files leave a single input unchanged and do not reach the canvas', async t => {
  const calls = mount(t, { kind: 'load-image', title: 'Image', mediaKind: 'image' })
  await drop([new File(['content'], 'clip.mp4')])
  assert.deepEqual(calls, [])
  assert.match(document.querySelector('[role="alert"]').textContent, /No supported files/)
  await drop([new File(['a'], 'a.png'), new File(['b'], 'b.png')])
  assert.deepEqual(calls, [])
  assert.match(document.querySelector('[role="alert"]').textContent, /one file/)
})

test('Batch Input accepts multiple supported files and reports skipped extensions', async t => {
  let calls
  await ui.act(async () => { calls = mount(t, { kind: 'batch-input', title: 'Batch', batch: { source: 'text' } }) })
  await drop(['prompt.txt', 'image.jpg', 'audio.mp3', 'video.mp4', 'unsupported.zip'].map(name => new File(['content'], name)))
  assert.deepEqual(calls, [['batch', 'input', ['prompt.txt', 'image.jpg', 'audio.mp3', 'video.mp4']]])
  assert.match(document.querySelector('[role="alert"]').textContent, /1 unsupported files skipped/)
})

test('frozen Batch Input consumes but does not import dropped files', async t => {
  let calls
  await ui.act(async () => { calls = mount(t, { kind: 'batch-input', title: 'Batch', frozen: true, batch: { source: 'files' } }) })
  await drop([new File(['content'], 'image.png')])
  assert.deepEqual(calls, [])
})

test('a running Batch Input consumes drops without replacing its cases', async t => {
  let calls
  await ui.act(async () => { calls = mount(t, { kind: 'batch-input', title: 'Batch', batch: { source: 'files' } }, {
    batchRuns: [{ id: 'run', batchInputNodeId: 'input', status: 'running' }],
  }) })
  await drop([new File(['content'], 'image.png')])
  assert.deepEqual(calls, [])
})

test('file imports show pending feedback, prevent concurrent drops, and recover after errors', async t => {
  let complete
  let attempts = 0
  mount(t, { kind: 'load-audio', title: 'Audio', mediaKind: 'audio' }, {
    onReplaceInputFile: () => { attempts++; return new Promise((resolve, reject) => { complete = { resolve, reject } }) },
  })
  const files = [new File(['content'], 'sound.wav', { type: 'application/octet-stream' })]
  await drop(files)
  assert.equal(document.querySelector('article').getAttribute('aria-busy'), 'true')
  await drop(files)
  assert.equal(attempts, 1)
  await ui.act(async () => complete.reject(new Error('Import failed')))
  assert.match(document.querySelector('[role="alert"]').textContent, /Import failed/)
  await drop(files)
  assert.equal(attempts, 2)
  await ui.act(async () => complete.resolve())
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.equal(document.querySelector('article').getAttribute('aria-busy'), null)
})
