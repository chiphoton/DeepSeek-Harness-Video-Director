import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<button id="launcher">Gallery</button><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]))
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
  import React, { act, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ArtifactGallery } from './ArtifactGallery';
  export { projectGallery, allProjectGalleries, filterGallery } from './gallery-artifacts';
  export { setLanguage } from './i18n';
  export { act };
  function Fixture({project, loadProjects}) {
    const [open, setOpen] = useState(true);
    return open ? <ArtifactGallery project={project} loadProjects={loadProjects} onClose={() => setOpen(false)} /> : null;
  }
  export function mount(project, loadProjects) {
    const root = createRoot(document.getElementById('root'));
    root.render(<Fixture project={project} loadProjects={loadProjects}/>);
    return root;
  }
` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false, define: { 'process.env.NODE_ENV': '"development"' } })
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
const image = { id: 'image', projectId: 'project', kind: 'image', name: 'source.png', url: '/image', mimeType: 'image/png', size: 32, sha256: 'hash', createdAt: '2026-09-17T00:00:00Z' }
const video = { ...image, id: 'video', kind: 'video', name: 'output.mp4', url: '/video', mimeType: 'video/mp4' }
const node = (id, data) => ({ id, position: { x: 0, y: 0 }, type: 'director', data: { title: id, ...data } })
const project = { id: 'project', name: 'Gallery test', graph: { nodes: [
  node('Input image', { kind: 'load-image', asset: image, assets: [image] }),
  node('Input text', { kind: 'load-text', text: 'Hi' }),
  node('Image processing', { kind: 'image-generation', asset: image, prompt: 'Configuration is not an output' }),
  node('Save', { kind: 'save', assets: [video] }),
], edges: [] }, jobs: [
  { id: 'job-a', nodeId: 'deleted-node', operation: 'video-generation', createdAt: '2026-09-15T00:00:00Z', result: { kind: 'assets', assets: [video] } },
  { id: 'job-b', nodeId: 'text-node', operation: 'prompt-enhancer', createdAt: '2026-09-16T00:00:00Z', result: { kind: 'text', text: 'AB' } },
  { id: 'job-c', nodeId: 'text-node', operation: 'prompt-enhancer', createdAt: '2026-09-17T00:00:00Z', result: { kind: 'text', text: 'CD' } },
] }

async function mount(t, value = project, loadProjects = async () => []) {
  let root
  document.getElementById('launcher').focus()
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(value, loadProjects) })
  t.after(() => ui.act(() => root.unmount()))
  return root
}
async function click(label) {
  const button = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent === label)
  assert.ok(button, label)
  await ui.act(async () => button.click())
}
function escape() {
  ui.act(() => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
}

async function search(value) {
  const input = document.querySelector('[aria-label="Search resources"]')
  await ui.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function filterWorkflow(value) {
  const select = document.querySelector('[aria-label="Filter by workflow"]')
  await ui.act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}

const otherProject = { ...project, id: 'other', name: 'Rain Scene', graph: { nodes: [
  node('Reference lantern', { kind: 'load-image', asset: { ...image, id: 'lantern', name: 'Lantern.PNG', projectId: 'other' } }),
  node('Scene notes', { kind: 'load-text', text: 'Blue moon over the lake' }),
] }, jobs: [] }

test('all workflows are visible by default and workflow/search filters combine without changing the active project', async t => {
  const original = structuredClone(project)
  // The current unsaved canvas takes precedence over the host's older version.
  await mount(t, project, async () => [{ ...project, graph: { nodes: [] }, jobs: [] }, otherProject])
  assert.equal(document.querySelector('[aria-label="Filter by workflow"]').value, '')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 4)
  assert.ok([...document.querySelectorAll('.vd-gallery-workflow')].some(el => el.textContent === 'Rain Scene'))
  await search('  LANTERN  ')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 1)
  assert.match(document.querySelector('.vd-gallery-card').textContent, /Lantern.PNG/)
  await filterWorkflow('project')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 0)
  assert.match(document.querySelector('.vd-gallery-empty').textContent, /No resources match/)
  await filterWorkflow('other')
  await search('image/png')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 1)
  await search('RAIN moon')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 1)
  await click('Preview Scene notes')
  assert.equal(document.querySelector('.is-text pre').textContent, 'Blue moon over the lake')
  escape()
  assert.equal(document.querySelector('[aria-label="Search resources"]').value, 'RAIN moon')
  assert.equal(document.querySelector('[aria-label="Filter by workflow"]').value, 'other')
  await click('Output 0')
  assert.match(document.querySelector('.vd-gallery-empty').textContent, /No resources match/)
  await filterWorkflow('')
  await search('CD')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 1)
  assert.deepEqual(project, original)
})

test('cross-workflow text IDs stay distinct and searches include node names and Unicode text', () => {
  const catalog = ui.allProjectGalleries([project, otherProject])
  assert.equal(catalog.input.length, 4)
  assert.equal(ui.filterGallery(catalog.input, '', 'Reference lantern').length, 1)
  assert.equal(ui.filterGallery(catalog.input, 'project', 'moon').length, 0)
  const localized = ui.allProjectGalleries([{ ...otherProject, graph: { nodes: [node('文字', { kind: 'load-text', text: '月光下的湖面' })] } }])
  assert.equal(ui.filterGallery(localized.input, '', '月光 湖面').length, 1)
})

test('Gallery loads without an active workflow and can retry a failed catalog request', async t => {
  let attempts = 0
  await mount(t, null, async () => {
    if (++attempts === 1) throw new Error('offline')
    return [otherProject]
  })
  assert.match(document.querySelector('[role="alert"]').textContent, /Could not load all workflows/)
  await click('Refresh')
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 2)
  assert.equal(attempts, 2)
})

test('search covers resources beyond the initial page and Show more reveals them', async t => {
  const many = { ...otherProject, graph: { nodes: Array.from({ length: 61 }, (_, i) => node(`Text ${i}`, { kind: 'load-text', text: `Unique text ${i}` })) } }
  await mount(t, null, async () => [many])
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 60)
  await click('Show more resources')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 61)
  await search('Unique text 60')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 1)
  assert.match(document.querySelector('.vd-gallery-card').textContent, /Unique text 60/)
})

test('closing Gallery aborts the in-flight all-workflow request', async t => {
  let signal
  let resolve
  const root = await mount(t, project, incoming => { signal = incoming; return new Promise(done => { resolve = done }) })
  assert.equal(signal.aborted, false)
  assert.match(document.querySelector('.vd-gallery-status').textContent, /Loading resources/)
  ui.act(() => root.render(null))
  assert.equal(signal.aborted, true)
  await ui.act(async () => resolve([otherProject]))
  assert.equal(document.querySelector('.vd-gallery-dialog'), null)
})

test('gallery separates current sources and retained results, deduplicates files, and keeps distinct equal-length text outputs', () => {
  const original = structuredClone(project)
  const gallery = ui.projectGallery(project)
  assert.deepEqual(project, original)
  assert.equal(gallery.input.length, 2)
  assert.equal(gallery.output.length, 4)
  assert.deepEqual(gallery.output.slice(0, 2).map(item => item.artifact.text), ['CD', 'AB'])
  assert.notEqual(gallery.output[0].artifact.id, gallery.output[1].artifact.id)
  assert.deepEqual(gallery.output.find(item => item.artifact.id === 'video').sources, ['video-generation', 'Save'])
  assert.equal(gallery.input.some(item => item.artifact.id === 'image'), true)
  assert.equal(gallery.output.some(item => item.artifact.id === 'image'), true)
  assert.equal(gallery.output.some(item => item.artifact.text?.includes('Configuration')), false)
})

test('tabs support keyboard navigation and gallery inspection opens text results from deleted nodes', async t => {
  await mount(t)
  const tabs = document.querySelectorAll('[role="tab"]')
  assert.equal(tabs[0].textContent, 'Input 2')
  assert.equal(tabs[1].textContent, 'Output 4')
  assert.equal(document.activeElement, tabs[0])
  ui.act(() => tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
  assert.equal(document.querySelectorAll('.vd-gallery-card').length, 4)
  const textCard = [...document.querySelectorAll('.vd-gallery-card')].find(card => card.textContent.includes('CD'))
  await ui.act(async () => textCard.querySelector('button').click())
  assert.equal(document.querySelector('.vd-artifact-dialog-content.is-text pre').textContent, 'CD')
  escape()
  assert.equal(document.querySelector('.vd-artifact-dialog-content.is-text'), null)
  assert.ok(document.querySelector('.vd-gallery-dialog'))
  assert.equal(document.activeElement, textCard.querySelector('button'))
  assert.equal(document.body.style.overflow, 'hidden')
  escape()
  assert.equal(document.querySelector('.vd-gallery-dialog'), null)
  assert.equal(document.body.style.overflow, '')
  assert.equal(document.activeElement, document.getElementById('launcher'))
})

test('gallery image viewer supports zoom, panning, reset and metadata without closing its gallery', async t => {
  await mount(t)
  await click('Preview source.png')
  await click('Zoom in')
  assert.equal(document.querySelector('.vd-image-view-controls output').textContent, '125%')
  const view = document.querySelector('.vd-artifact-dialog-content.is-image')
  view.setPointerCapture = () => {}
  view.releasePointerCapture = () => {}
  for (const [type, x, y] of [['pointerdown', 10, 20], ['pointermove', 60, 90], ['pointerup', 60, 90]]) {
    const event = new dom.window.Event(type, { bubbles: true })
    for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value })
    ui.act(() => view.dispatchEvent(event))
  }
  assert.match(view.querySelector('img').style.transform, /translate3d\(50px, 70px, 0\) scale\(1.25\)/)
  await click('Reset view')
  assert.equal(view.querySelector('img').style.transform, 'translate3d(0px, 0px, 0) scale(1)')
  await click('Zoom out')
  assert.equal(document.querySelector('.vd-image-view-controls output').textContent, '80%')
  await click('Metadata')
  assert.ok(document.querySelector('.vd-image-properties-dialog'))
  escape()
  assert.equal(document.querySelector('.vd-image-properties-dialog'), null)
  assert.ok(document.querySelector('.vd-artifact-dialog-content.is-image'))
})

test('closing Gallery while its inspector is open releases both scroll locks', async t => {
  const root = await mount(t)
  await click('Preview source.png')
  assert.equal(document.body.style.overflow, 'hidden')
  ui.act(() => root.render(null))
  assert.equal(document.body.style.overflow, '')
  assert.equal(document.documentElement.style.overflow, '')
})

test('empty projects show useful input and output states and localized tabs', async t => {
  await mount(t, { ...project, graph: { nodes: [] }, jobs: [] })
  assert.match(document.querySelector('.vd-gallery-empty').textContent, /No input artifacts/)
  await click('Output 0')
  assert.match(document.querySelector('.vd-gallery-empty').textContent, /No output artifacts/)
  ui.act(() => ui.setLanguage('zh'))
  assert.equal(document.querySelector('.vd-gallery-dialog header strong').textContent, '素材库')
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, '输出 0')
})
