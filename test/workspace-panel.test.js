import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { testHost } from './fixtures/director-host.js'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://synthetic.local/' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
test.after(() => dom.window.close())
const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
import React, { act } from 'react'; import { createRoot } from 'react-dom/client'; import { Simulate } from 'react-dom/test-utils';
import { SkillsPanel, SkillsDialog, WorkspaceHistory } from './WorkspacePanel';
import { ChatSkillComposer } from './ChatSkillComposer'; export { act, Simulate };
export function mount(director,projectId,history=false) { const root=createRoot(document.getElementById('root'));root.render(history?<WorkspaceHistory director={director} projectId={projectId} onHighlightNode={()=>{}}/>:<SkillsPanel director={director} projectId={projectId}/>);return root; }
function Composer({director, projectId, events}) {
  const [value,setValue]=React.useState(''); const [manager,setManager]=React.useState(false); const [revision,setRevision]=React.useState(0);
  return <><ChatSkillComposer director={director} projectId={projectId} sessionId="composer-test" refreshKey={revision} disabled={false} onManage={()=>setManager(true)} value={value} onChange={setValue} attachments={[]} placeholder="Synthetic message" onPreview={()=>{}} onFiles={()=>{}} onKeyDown={event=>{events.push(event.key)}}/>
    {manager && <SkillsDialog director={director} projectId={projectId} onChange={()=>setRevision(x=>x+1)} onClose={()=>setManager(false)}/>}</>;
}
export function mountComposer(director,projectId,events) { const root=createRoot(document.getElementById('root'));root.render(<Composer director={director} projectId={projectId} events={events}/>);return root; }
` }, bundle: true, packages: 'external', format: 'cjs', platform: 'node', write: false, jsx: 'automatic' })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { mount, mountComposer, act, Simulate } = module.exports
const settled = () => new Promise(resolve => setTimeout(resolve, 35))
async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await act(async () => { await settled() })
  assert.ok(predicate(), 'Synthetic sidebar did not reach its expected state')
}

test('sidebar creates and loads a skill through the real Host, then inspects and undoes a synthetic edit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-sidebar-synthetic-'))
  const host = await testHost(directory)
  const project = await host.store.createProject({ name: 'Synthetic sidebar', sessionId: 'sidebar-test' })
  let root
  t.after(async () => { if (root) await act(async () => root.unmount()); await host.close(); await rm(directory, { recursive: true, force: true }) })
  const director = { workspace: async (surface, command, args) => {
    const result = await host.rpc(`${surface}/command`, { projectId: project.id, sessionId: project.sessionId, command, args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  } }
  await act(async () => { root = mount(director, project.id); await settled() })
  const form = document.querySelectorAll('form')[1]
  for (const [field, value] of [[form.querySelectorAll('input')[0], 'sidebar-synthetic'], [form.querySelectorAll('input')[1], 'Synthetic instructions'], [form.querySelector('textarea'), 'Create a text node and preview.']]) {
    await act(async () => { Simulate.change(field, { target: { value } }) })
  }
  await act(async () => { Simulate.submit(form); await settled() })
  await until(() => document.body.textContent.includes('Saved sidebar-synthetic v1'))
  assert.match(document.body.textContent, /Saved sidebar-synthetic v1/)
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Load in chat').click(); await settled() })
  assert.match(document.body.textContent, /Selected for this chat/)
  assert.equal((await director.workspace('library', 'active')).items.length, 1)
  await director.workspace('canvas', 'edit', { expectedDraftRevision: 0, edits: [{ op: 'add', id: 'text', kind: 'load-text', data: { text: 'Synthetic' } }] })
  await act(async () => { root.unmount(); root = mount(director, project.id, true); await settled() })
  await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Inspect'))
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Inspect').click() })
  assert.match(document.querySelector('pre').textContent, /text/)
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Undo').click(); await settled() })
  assert.equal((await director.workspace('canvas', 'summary')).nodeCount, 0)
})

test('composer inserts boxed $skills in the draft and manages selections separately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-composer-synthetic-'))
  const host = await testHost(directory)
  const project = await host.store.createProject({ name: 'Synthetic composer', sessionId: 'composer-test' })
  let root
  t.after(async () => { if (root) await act(async () => root.unmount()); await host.close(); await rm(directory, { recursive: true, force: true }) })
  const director = { workspace: async (surface, command, args = {}) => {
    const result = await host.rpc(`${surface}/command`, { projectId: project.id, sessionId: project.sessionId, command, args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  } }
  const activeCount = async () => {
    let count
    await act(async () => { count = (await director.workspace('library', 'active')).items.length; await settled() })
    return count
  }
  await director.workspace('library', 'create', { name: 'story-board', description: 'Synthetic storyboard skill', content: 'Synthetic instructions.' })
  const events = []
  await act(async () => { root = mountComposer(director, project.id, events); await settled() })
  const editor = document.querySelector('[role=textbox]')
  await act(async () => {
    editor.focus(); editor.textContent = 'Use $sto next'
    const range = document.createRange(); range.setStart(editor.firstChild, 8); range.collapse(true)
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range)
    Simulate.input(editor); await settled()
  })
  await until(() => document.querySelector('[role=option]'))
  await act(async () => { Simulate.keyDown(editor, { key: 'Enter', nativeEvent: { isComposing: false } }); await settled() })
  await until(() => editor.textContent === 'Use $story-board  next')
  assert.deepEqual(events, [], 'Enter selects the suggestion without sending')
  assert.equal(editor.querySelector('.vd-chat-skill-mention')?.textContent, '$story-board')
  assert.doesNotMatch(document.querySelector('.vd-chat-skill-row').textContent, /story-board/)
  assert.equal(await activeCount(), 1)
  await act(async () => { document.querySelector('.vd-chat-skills-trigger').click(); await settled() })
  await until(() => document.querySelector('.vd-chat-skills-manage'))
  const manage = document.querySelector('.vd-chat-skills-manage')
  await act(async () => { manage.focus() })
  assert.ok(manage.isConnected, 'Moving focus from the editor to Manage skills keeps the picker open')
  await act(async () => { manage.click(); await settled() })
  assert.ok(document.querySelector('[role=dialog][aria-modal=true]'))
  assert.ok(document.querySelector('[aria-label="Skills library"]'))
  const unload = () => [...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Unload')
  await until(unload)
  await act(async () => { unload().click(); await settled() })
  assert.equal(await activeCount(), 0)
  await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settled() })
  assert.equal(document.querySelector('[role=dialog]'), null)
  assert.match(editor.textContent, /story-board/, 'Closing the manager preserves the draft')
})
