import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
test.after(() => dom.window.close())
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
import React, { act, useState, useRef } from 'react'; import { createRoot } from 'react-dom/client';
import { ChatPromptEditor } from './ChatPromptEditor'; export { ChatAttachmentRegistry, updateChatAliases, chatDroppedFiles } from './chat-attachments'; export { act };
export function mount(api) {
  const root=createRoot(document.getElementById('root'));
  function Fixture() {
    const [text,setText]=useState('Use <Image 1> here'); const [items,setItems]=useState([{id:'image',alias:'<Image 1>',kind:'image',name:'original.png'}]); const ref=useRef(null);
    api.value=text;api.setText=setText;api.editor=ref;api.setItems=setItems;
    return <ChatPromptEditor ref={ref} value={text} attachments={items} onChange={setText} placeholder="Prompt" onPreview={item=>api.preview=item} onKeyDown={()=>{}} onFiles={()=>{}}/>;
  }
  root.render(<Fixture/>);return root;
}` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false, jsx: 'automatic' })
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const { act, mount, ChatAttachmentRegistry, updateChatAliases, chatDroppedFiles } = compiled.exports

test('aliases copy/cut/paste as whole text references, and backward selection inserts at its start', t => {
  const api = {}; let root
  act(() => { root = mount(api) }); t.after(() => act(() => root.unmount()))
  const editor = document.querySelector('[role=textbox]')
  const token = editor.querySelector('[data-alias]')
  assert.equal(token.contentEditable, 'false')
  act(() => token.click()); assert.equal(api.preview.name, 'original.png')
  const selection = dom.window.getSelection(); const range = document.createRange(); range.selectNode(token); selection.removeAllRanges(); selection.addRange(range)
  const clipboard = new Map()
  const dispatchClipboard = type => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => clipboard.set(type, value), getData: type => clipboard.get(type), files: [] } })
    act(() => editor.dispatchEvent(event))
  }
  dispatchClipboard('cut'); assert.equal(clipboard.get('text/plain'), '<Image 1>'); assert.equal(api.value, 'Use  here')
  dispatchClipboard('paste'); assert.equal(api.value, 'Use <Image 1> here'); assert.equal(editor.querySelectorAll('[data-alias]').length, 1)
  editor.focus(); selection.setBaseAndExtent(editor.firstChild, 3, editor.firstChild, 0)
  act(() => api.editor.current.insert('Replace'))
  assert.equal(api.value, 'Replace <Image 1> here')
  act(() => { api.setText(value => value.replaceAll('<Image 1>', '')); api.setItems([]) })
  assert.equal(editor.querySelectorAll('[data-alias]').length, 0)
  assert.equal(api.value, 'Replace  here')
})

test('upload acknowledgement is distinct from chat delivery so a failed send can retry its references', async () => {
  const calls = []
  const remote = { id: 'ref', alias: '<Image 1>', kind: 'image', name: 'original.png', projectId: 'p', ready: false, files: [{ name: 'original.png', path: 'original.png', size: 3, mimeType: 'image/png' }] }
  const registry = new ChatAttachmentRegistry(async input => {
    calls.push(input.action)
    if (input.action === 'list') return { entries: [] }
    if (input.action === 'reserve') return { entry: { ...remote, id: input.id } }
    if (input.action === 'upload') return { entry: { ...remote, id: input.id, ready: true }, fileIndex: 0, file: { ...remote.files[0], uploaded: true } }
    return {}
  }, 'p', 's')
  const item = await registry.addFile(new File(['png'], 'original.png', { type: 'image/png' }))
  const uploaded = await registry.prepare([item])
  assert.equal(uploaded[0].ready, true)
  assert.equal(uploaded[0].sent, undefined)
  await registry.prepare(uploaded)
  assert.equal(calls.filter(action => action === 'upload').length, 1)
  await registry.markSent(uploaded)
  assert.equal(registry.getSnapshot()[0].sent, true)
  registry.dispose()
})

test('removing a reference updates prompt aliases by identity and keeps local files for renumbered cards', async () => {
  let rows = []
  const registry = new ChatAttachmentRegistry(async input => {
    if (input.action === 'list') return { entries: rows }
    if (input.action === 'reserve') {
      const entry = { id: input.id, alias: `<Image ${rows.length + 1}>`, kind: 'image', name: input.name, files: input.files }
      rows = [...rows, entry]; return { entry }
    }
    if (input.action === 'hide') {
      rows = rows.filter(row => row.id !== input.id).map((row, index) => ({ ...row, alias: `<Image ${index + 1}>` }))
      return { entries: rows }
    }
  }, 'p', 's')
  const files = [1, 2, 3].map(index => new File(['png'], `${index}.png`, { type: 'image/png' }))
  for (const file of files) await registry.addFile(file)
  const before = registry.getSnapshot()
  await registry.remove(before[0].id)
  const after = registry.getSnapshot()
  assert.deepEqual(after.map(item => item.alias), ['<Image 1>', '<Image 2>'])
  assert.equal(after[0].file, files[1])
  assert.equal(after[0].previewUrl, before[1].previewUrl)
  assert.equal(updateChatAliases('Remove <Image 1>; use <Image 2> with <Image 3> and <Image 2>. <Node 1>', before, after),
    'Remove ; use <Image 1> with <Image 2> and <Image 1>. <Node 1>')
  registry.dispose()
})

test('file drops support FileList and entry fallbacks and snapshot every file before asynchronous work', async () => {
  const first = new File(['png'], 'frame.png', { type: 'image/png' })
  const second = new File(['wav'], 'voice.wav', { type: 'audio/wav' })
  assert.deepEqual(await chatDroppedFiles({ files: [first], items: [{ kind: 'file', getAsFile: () => null }] }), [{ directory: false, files: [first] }])
  const entry = { isFile: true, isDirectory: false, name: first.name, file: callback => setTimeout(() => callback(first), 0) }
  let readable = true
  const pending = chatDroppedFiles({ files: [], items: [
    { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => entry },
    { kind: 'file', getAsFile: () => readable ? second : null },
  ] })
  readable = false
  assert.deepEqual((await pending).flatMap(group => group.files), [first, second])
})
