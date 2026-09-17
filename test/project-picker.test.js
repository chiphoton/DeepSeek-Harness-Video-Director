import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const bundle = await build({ stdin: {
  resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx',
  contents: `
    import React, {act, useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {ProjectPicker} from './ProjectPicker'; export {act}; export {setLanguage} from './i18n';
    function Fixture({calls}) {
      const [projects, setProjects] = useState([{id:'a', name:'Saved', unsaved:false}, {id:'b', name:'Draft', unsaved:true}]);
      return <ProjectPicker snapshot={{project:projects.find(p=>p.id==='b'), projects, dirty:true, examples:[], workflowRuns:[]}}
        disabled={false} onRefresh={()=>{}} onSelectProject={async id=>calls.push(['select',id])}
        onSelectExample={async id=>calls.push(['example',id])} onProjectAction={(id,action)=>calls.push([action,id])}
        onReorder={ids=>{calls.push(['reorder',ids]);setProjects(ids.map(id=>projects.find(p=>p.id===id)))}} />;
    }
    export function mount(calls) {const root=createRoot(document.getElementById('root'));root.render(<Fixture calls={calls}/>);return root;}
  `,
}, bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"development"' } })
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
function mount(t) {
  const calls = []
  let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mount(calls) })
  t.after(() => { ui.act(() => root.unmount()) })
  ui.act(() => document.querySelector('.vd-project-picker-trigger').click())
  return calls
}

test('project picker marks drafts, counts them, and row actions target the correct workflow without selecting it', t => {
  const calls = mount(t)
  assert.equal(document.querySelector('.vd-project-picker-trigger .vd-project-unsaved').textContent, 'Draft *')
  assert.equal(document.querySelector('[aria-label="Draft"] .vd-project-unsaved').textContent, 'Draft *')
  assert.equal(document.querySelector('.vd-project-picker-hint').textContent, '1 unsaved workflow')
  ui.act(() => document.querySelector('[aria-label="Actions for Saved"]').click())
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 6)
  assert.doesNotMatch(document.querySelector('[role="menu"]').textContent, /Clear Preview/)
  ui.act(() => [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === 'Export project').click())
  assert.deepEqual(calls, [['export', 'a']])
  assert.equal(document.querySelector('[role="tree"]'), null)
})

test('project order changes by drag-and-drop and keyboard without opening a workflow', t => {
  const calls = mount(t)
  const first = document.querySelector('[role="treeitem"][aria-label="Saved"]')
  const second = document.querySelector('[role="treeitem"][aria-label="Draft"]')
  const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' }
  ui.act(() => {
    const start = new dom.window.Event('dragstart', { bubbles: true })
    Object.defineProperty(start, 'dataTransfer', { value: dataTransfer })
    second.dispatchEvent(start)
  })
  ui.act(() => {
    const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'clientY', { value: -1 })
    first.dispatchEvent(drop)
  })
  assert.deepEqual(calls, [['reorder', ['b', 'a']]])
  ui.act(() => { first.focus() })
  ui.act(() => first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })))
  assert.deepEqual(calls.at(-1), ['reorder', ['a', 'b']])
})
