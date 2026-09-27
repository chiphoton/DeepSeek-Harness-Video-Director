import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
    import {ProjectPicker} from './ProjectPicker'; import {ProjectActionsMenu} from './ProjectActionsMenu'; export {act}; export {setLanguage} from './i18n';
    function Fixture({calls, running, options}) {
      const [projects, setProjects] = useState([{id:'a', name:'Saved', unsaved:false, status:running?'running':'ready'}, {id:'b', name:'Draft', unsaved:true}]);
      return <ProjectPicker snapshot={{project:projects.find(p=>p.id==='b'), projects, dirty:true, examples:[], workflowRuns:[], projectFolders:options.layout}}
        disabled={false} onRefresh={()=>{}} onSelectProject={async id=>calls.push(['select',id])}
        onSelectExample={async id=>calls.push(['example',id])} onProjectAction={(id,action)=>calls.push([action,id])}
        onReorder={ids=>{calls.push(['reorder',ids]);setProjects(ids.map(id=>projects.find(p=>p.id===id)))}}
        onCreateWorkflow={async (name,parentId,revision)=>calls.push(['create-workflow',{name,parentId,revision}])}
        onOrganize={options.organize ? async change=>{calls.push(['organize',change]);await options.organize(change)} : undefined} />;
    }
    export function mount(calls, running, options) {const root=createRoot(document.getElementById('root'));root.render(<Fixture calls={calls} running={running} options={options}/>);return root;}
    export function mountGlobal(calls) {const root=createRoot(document.getElementById('root'));root.render(<ProjectActionsMenu hasProject disabled={false} busy={false} onAction={action=>calls.push(action)}/>);return root;}
  `,
}, bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false })
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
function mount(t, running = false, options = {}) {
  const calls = []
  let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mount(calls, running, options) })
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

test('a running workflow keeps navigation, rename, duplicate, move and export available', t => {
  const calls = mount(t, true)
  ui.act(() => document.querySelector('[aria-label="Actions for Saved"]').click())
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  for (const item of items) assert.equal(item.disabled, ['Discard changes', 'Delete project'].includes(item.textContent))
  ui.act(() => items.find(item => item.textContent === 'Rename project').click())
  ui.act(() => document.querySelector('.vd-project-picker-trigger').click())
  ui.act(() => document.querySelector('[role="treeitem"][aria-label="Saved"]').click())
  assert.deepEqual(calls, [['rename', 'a'], ['select', 'a']])
})

for (const [label, action] of [
  ['Rename project', 'rename'], ['Duplicate project', 'duplicate'],
  ['Export project', 'export'], ['Discard changes', 'discard'], ['Delete project', 'delete'],
]) {
  test(`pointer activation of ${action} survives browsers that blur without focusing buttons`, t => {
    const calls = mount(t)
    ui.act(() => document.querySelector('[aria-label="Actions for Saved"]').click())
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === label)
    assert.ok(item)
    // Safari/macOS can leave relatedTarget null when a pointer clicks a button.
    ui.act(() => {
      item.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      document.activeElement.blur()
    })
    assert.equal(item.isConnected, true, 'the action must remain mounted until the click arrives')
    ui.act(() => item.click())
    assert.deepEqual(calls, [[action, 'a']])
  })
}

for (const method of ['focus', 'pointer']) {
  test(`project menus still close on outside ${method}`, t => {
    mount(t)
    ui.act(() => document.querySelector('[aria-label="Actions for Saved"]').click())
    const outside = document.createElement('button')
    document.body.append(outside)
    t.after(() => outside.remove())
    ui.act(() => {
      if (method === 'focus') outside.focus()
      else outside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    })
    assert.equal(document.querySelector('[role="tree"]'), null)
    assert.equal(document.querySelector('[role="menu"]'), null)
  })
}

const examplesId = '00000000-0000-4000-8000-000000000001'
const childId = '00000000-0000-4000-8000-000000000002'
const nestedLayout = { version: 1, revision: 8,
  folders: [{ id: examplesId, name: 'examples', parentId: null }, { id: childId, name: 'Nested', parentId: examplesId }],
  projectParents: { a: childId }, projectOrder: [], examplesParentId: examplesId }
const buttonWithText = text => [...document.querySelectorAll('button')].find(item => item.textContent === text)
function setInput(input, value) {
  ui.act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function submit() {
  await ui.act(async () => { document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) })
}

test('folder menu creates a subfolder and does not select a workflow', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Folder actions for examples"]').click())
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(b => b.textContent), ['New Workflow', 'New Folder', 'Move to…', 'Rename Folder', 'Delete Folder'])
  ui.act(() => buttonWithText('New Folder').click())
  assert.equal(document.querySelector('[role="tree"]'), null)
  assert.equal(document.activeElement, document.querySelector('input'))
  setInput(document.querySelector('input'), 'New scene')
  await submit()
  assert.deepEqual(calls, [['organize', { action: 'create', name: 'New scene', parentId: examplesId, expectedRevision: 8 }]])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('new root folder, rename and cancellation use the virtual folder dialog', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="New Folder"]').click())
  setInput(document.querySelector('input'), 'Top level')
  await submit()
  assert.equal(calls[0][1].parentId, null)
  ui.act(() => document.querySelector('.vd-project-picker-trigger').click())
  ui.act(() => document.querySelector('[aria-label="Folder actions for examples"]').click())
  ui.act(() => buttonWithText('Rename Folder').click())
  assert.equal(document.querySelector('input').value, 'examples')
  setInput(document.querySelector('input'), 'Templates')
  await submit()
  assert.deepEqual(calls.at(-1)[1], { action: 'rename', id: examplesId, name: 'Templates', expectedRevision: 8 })
  ui.act(() => document.querySelector('.vd-project-picker-trigger').click())
  ui.act(() => document.querySelector('[aria-label="New Folder"]').click())
  ui.act(() => buttonWithText('Cancel').click())
  assert.equal(calls.length, 2)
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('row Move to replaces Import, survives pointer blur, and includes nested destinations', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Actions for Draft"]').click())
  assert.equal(buttonWithText('Import project'), undefined)
  const move = buttonWithText('Move to…')
  ui.act(() => {
    move.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    document.activeElement.blur()
  })
  ui.act(() => move.click())
  assert.equal(document.querySelector('[role="dialog"] header strong').textContent, 'Move “Draft” to…')
  assert.deepEqual([...document.querySelectorAll('[role="treeitem"]')].map(o => o.getAttribute('aria-label')), ['/', 'examples'])
  ui.act(() => document.querySelector('[aria-label="Expand examples"]').click())
  ui.act(() => document.querySelector('[role="treeitem"][aria-label="Nested"]').click())
  assert.equal(document.querySelector('[role="treeitem"][aria-label="Nested"]').getAttribute('aria-selected'), 'true')
  await submit()
  assert.deepEqual(calls, [['organize', { action: 'move', kind: 'project', id: 'b', parentId: childId, expectedRevision: 8 }]])
})

test('folder Move to excludes itself and all descendants', t => {
  mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Folder actions for examples"]').click())
  ui.act(() => buttonWithText('Move to…').click())
  assert.equal(document.querySelector('[role="dialog"] header strong').textContent, 'Move “examples” to…')
  assert.deepEqual([...document.querySelectorAll('[role="treeitem"]')].map(o => o.getAttribute('aria-label')), ['/'])
})

for (const deleteChildren of [false, true]) {
  test(`folder deletion confirms ${deleteChildren ? 'deleting child workflows' : 'keeping child workflows by default'}`, async t => {
    const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
    ui.act(() => document.querySelector('[aria-label="Folder actions for examples"]').click())
    ui.act(() => buttonWithText('Delete Folder').click())
    assert.equal(calls.length, 0)
    assert.match(document.querySelector('[role="dialog"]').textContent, /1 child workflow/)
    const radios = document.querySelectorAll('input[type="radio"]')
    assert.equal(radios[0].checked, true)
    if (deleteChildren) ui.act(() => radios[1].click())
    await submit()
    assert.deepEqual(calls, [['organize', { action: 'delete', id: examplesId, mode: deleteChildren ? 'delete-workflows' : 'keep-workflows', expectedRevision: 8 }]])
  })
}

test('running descendants allow keeping workflows but disable deleting them', t => {
  mount(t, true, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Folder actions for examples"]').click())
  ui.act(() => buttonWithText('Delete Folder').click())
  assert.equal(document.querySelectorAll('input[type="radio"]')[0].disabled, false)
  assert.equal(document.querySelectorAll('input[type="radio"]')[1].disabled, true)
})

test('failed organization stays in the dialog and reports the error', async t => {
  mount(t, false, { organize: async () => { throw new Error('Folders changed in another tab') } })
  ui.act(() => document.querySelector('[aria-label="New Folder"]').click())
  setInput(document.querySelector('input'), 'Scene')
  await submit()
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Folders changed in another tab')
  assert.equal(buttonWithText('Cancel').disabled, false)
})

test('global navigation project menu retains Import project', t => {
  const calls = []; let root
  ui.act(() => { ui.setLanguage('en'); root = ui.mountGlobal(calls) })
  t.after(() => { ui.act(() => root.unmount()) })
  assert.equal(buttonWithText('Move to…'), undefined)
  ui.act(() => buttonWithText('Import project').click())
  assert.deepEqual(calls, ['import'])
})

test('New Workflow creates in the chosen folder without dispatching a folder action', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Folder actions for Nested"]').click())
  ui.act(() => buttonWithText('New Workflow').click())
  assert.equal(document.querySelector('[role="dialog"] header strong').textContent, 'New Workflow')
  setInput(document.querySelector('input'), 'New scene')
  await submit()
  assert.deepEqual(calls, [['create-workflow', { name: 'New scene', parentId: childId, revision: 8 }]])
})

function multiSelect() { ui.act(() => document.querySelector('[aria-label="Multi-Select"]').click()) }
function batchMenu() { ui.act(() => document.querySelector('[aria-label="Batch operations"]').click()) }
function check(label) { ui.act(() => document.querySelector(`input[aria-label="${label}"]`).click()) }

test('multi-select replaces row menus and applies select all, deselect all and invert to collapsed descendants too', t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  multiSelect()
  assert.equal(document.querySelectorAll('.vd-project-row-more').length, 0)
  assert.equal(document.querySelector('[role="tree"]').getAttribute('aria-multiselectable'), 'true')
  batchMenu()
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent), ['Select all', 'Deselect all', 'Invert selection', 'Move to…', 'Delete'])
  assert.equal(buttonWithText('Move to…').disabled, true)
  ui.act(() => buttonWithText('Select all').click())
  assert.equal(document.querySelector('.vd-project-picker-hint').textContent, '4 selected')
  ui.act(() => document.querySelector('[aria-label="Expand Nested"]').click())
  assert.equal(document.querySelector('[aria-label="Select workflow Saved"]').checked, true)
  batchMenu(); ui.act(() => buttonWithText('Deselect all').click())
  assert.equal(document.querySelector('.vd-project-picker-hint').textContent, '0 selected')
  check('Select workflow Draft')
  batchMenu(); ui.act(() => buttonWithText('Invert selection').click())
  assert.equal(document.querySelector('.vd-project-picker-hint').textContent, '3 selected')
  assert.equal(document.querySelector('[aria-label="Select workflow Draft"]').checked, false)
  assert.equal(document.querySelector('[aria-label="Select folder Nested"]').checked, true)
  assert.deepEqual(calls, [], 'selecting does not navigate or modify data')
  multiSelect()
  assert.equal(document.querySelectorAll('.vd-project-row-select').length, 0)
  assert.ok(document.querySelector('[aria-label="Folder actions for Nested"]'))
})

test('batch move opens a folder-only tree and sends one operation for mixed selection', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  multiSelect(); check('Select folder Nested'); check('Select workflow Draft')
  batchMenu(); ui.act(() => buttonWithText('Move to…').click())
  assert.equal(document.querySelector('[role="dialog"] header strong').textContent, 'Move 2 items to…')
  assert.deepEqual([...document.querySelectorAll('[role="treeitem"]')].map(item => item.getAttribute('aria-label')), ['/', 'examples'])
  ui.act(() => document.querySelector('[role="treeitem"][aria-label="examples"]').click())
  await submit()
  assert.deepEqual(calls, [['organize', { action: 'batch-move', items: [{ kind: 'folder', id: childId }, { kind: 'project', id: 'b' }], parentId: examplesId, expectedRevision: 8 }]])
})

for (const kind of ['project', 'folder', 'mixed']) {
  test(`batch delete confirmation handles ${kind} selection and lists affected items`, async t => {
    const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
    multiSelect()
    if (kind !== 'project') check('Select folder examples')
    if (kind !== 'folder') check('Select workflow Draft')
    batchMenu(); ui.act(() => buttonWithText('Delete').click())
    assert.equal(calls.length, 0)
    const panel = document.querySelector('[role="dialog"]')
    if (kind !== 'folder') assert.match(panel.textContent, /\/Draft/)
    if (kind !== 'project') {
      assert.match(panel.textContent, /\/examples\//)
      assert.match(panel.textContent, /\/examples\/Nested\/Saved/)
      assert.equal(panel.querySelector('input[type="radio"]').checked, true)
    }
    if (kind === 'mixed') {
      assert.equal(buttonWithText('Delete').disabled, true)
      await submit()
      assert.equal(calls.length, 0, 'mixed workflow deletion needs its separate confirmation')
      ui.act(() => panel.querySelector('input[type="checkbox"]').click())
      assert.equal(buttonWithText('Delete').disabled, false)
    }
    await submit()
    assert.deepEqual(calls, [['organize', { action: 'batch-delete', folderIds: kind === 'project' ? [] : [examplesId], projectIds: kind === 'folder' ? [] : ['b'], mode: 'keep-workflows', expectedRevision: 8 }]])
  })
}

test('a selected running workflow blocks batch deletion even when folder children would be kept', t => {
  mount(t, true, { layout: nestedLayout, organize: async () => {} })
  multiSelect()
  ui.act(() => document.querySelector('[aria-label="Expand Nested"]').click())
  check('Select folder examples'); check('Select workflow Saved')
  batchMenu(); ui.act(() => buttonWithText('Delete').click())
  assert.equal(document.querySelector('input[type="checkbox"]').disabled, true)
  assert.equal(buttonWithText('Delete').disabled, true)
})

test('destination tree supports keyboard navigation and collapse without submitting the form', async t => {
  const calls = mount(t, false, { layout: nestedLayout, organize: async () => {} })
  ui.act(() => document.querySelector('[aria-label="Actions for Draft"]').click())
  ui.act(() => buttonWithText('Move to…').click())
  const key = value => ui.act(() => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
  assert.equal(document.activeElement.getAttribute('aria-label'), '/')
  key('ArrowDown'); key('ArrowRight'); key('ArrowDown'); key('Enter')
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Nested')
  assert.equal(document.activeElement.getAttribute('aria-selected'), 'true')
  assert.deepEqual(calls, [])
  ui.act(() => document.querySelector('[aria-label="Collapse /"]').click())
  assert.equal(document.querySelectorAll('[role="treeitem"]').length, 1)
  assert.equal(document.activeElement.getAttribute('aria-label'), '/')
  key('Enter')
  await submit()
  assert.equal(calls[0][1].parentId, null)
})
