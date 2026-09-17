import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
    import React, { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlowProvider } from '@xyflow/react';
    import { DirectorNodeView, DirectorRuntimeProvider } from './DirectorNode';
    import { ArtifactPreviewDialog, previewArtifactFromAsset } from './ArtifactPreview';
    export { act };
    export { setLanguage } from './i18n';
    export function mount(kind, asset) {
      const root = createRoot(document.getElementById('root'));
      const render = next => root.render(kind === 'inspect'
        ? <ArtifactPreviewDialog artifact={previewArtifactFromAsset(next)} onClose={() => {}} />
        : <ReactFlowProvider><DirectorRuntimeProvider value={{nodeDefinitions: [{type: 'test.output', version: '1.0.0', inputs: [], outputs: [], fields: []}], references: {}}}>
            <DirectorNodeView id="output" data={{kind, nodeType: 'test.output', title: 'Output', assets: [next]}} />
          </DirectorRuntimeProvider></ReactFlowProvider>);
      render(asset);
      return { render, unmount: () => root.unmount() };
    }
  ` },
  bundle: true, format: 'cjs', platform: 'node', packages: 'external', target: 'es2022', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const ui = compiled.exports
const asset = { id: 'video', projectId: 'project', kind: 'video', name: 'scene.mp4', url: '/api/video-director/assets/video', mimeType: 'video/mp4', size: 12345, sha256: 'abc', createdAt: '2026-09-17T00:00:00Z' }
const properties = { width: 1920, height: 1080, duration: 4.004, fps: 30000 / 1001, format: 'MP4', metadata: [{ name: 'Container · comment', value: '{"prompt":"Sunrise"}' }] }

async function mount(t, kind) {
  let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(kind, asset) })
  t.after(() => ui.act(() => root.unmount()))
  return root
}

function click(label) {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === label || el.getAttribute('aria-label') === label)
  assert.ok(button, label)
  return ui.act(async () => button.click())
}

for (const kind of ['inspect', 'preview', 'save']) {
  test(`${kind} video popup shows dimensions, FPS, duration, format, size and readable embedded metadata`, async t => {
    const requests = []
    globalThis.fetch = async url => { requests.push(url); return Response.json({ ok: true, value: properties }) }
    await mount(t, kind)
    if (kind !== 'inspect') await click('Preview scene.mp4')
    assert.deepEqual(requests, [`${asset.url}/properties`])
    const info = document.querySelector('[aria-label="Video properties"]')
    assert.match(info.textContent, /1920 × 1080 px/)
    assert.match(info.textContent, /29.97 fps/)
    assert.match(info.textContent, /4.00 s/)
    assert.match(info.textContent, /MP4/)
    assert.match(info.textContent, /12,345/)
    assert.equal(document.querySelector('.vd-artifact-dialog video').controls, true)
    await click('Metadata')
    assert.match(document.querySelector('.vd-image-metadata').textContent, /Container · comment.*Sunrise/)
    assert.match(document.querySelector('.vd-image-properties-dialog').textContent, /29.97 fps/)
    await click('Close video properties')
    assert.equal(document.querySelector('.vd-image-properties-dialog'), null)
  })
}

test('video probe failure retains browser dimensions and duration and explains unavailable FPS', async t => {
  globalThis.fetch = async () => Response.json({ ok: false, error: { message: 'Video metadata requires ffprobe (FFmpeg) on the DSH host.' } }, { status: 503 })
  await mount(t, 'inspect')
  const video = document.querySelector('video')
  for (const [key, value] of Object.entries({ videoWidth: 640, videoHeight: 360, duration: 2 })) Object.defineProperty(video, key, { value })
  ui.act(() => video.dispatchEvent(new dom.window.Event('loadedmetadata')))
  const info = document.querySelector('[aria-label="Video properties"]')
  assert.match(info.textContent, /640 × 360 px/)
  assert.match(info.textContent, /2.00 s/)
  assert.match(info.textContent, /Unavailable/)
  assert.doesNotMatch(info.textContent, /Reading/)
  await click('Metadata')
  assert.match(document.querySelector('.vd-image-metadata').textContent, /requires ffprobe/)
})

test('switching inspected assets cancels stale metadata and never overwrites the newer video', async t => {
  let resolveFirst
  let firstSignal
  globalThis.fetch = (url, options) => {
    if (url === `${asset.url}/properties`) {
      firstSignal = options.signal
      return new Promise(resolve => { resolveFirst = resolve })
    }
    return Promise.resolve(Response.json({ ok: true, value: { ...properties, fps: 60, width: 1280 } }))
  }
  const root = await mount(t, 'inspect')
  await ui.act(async () => root.render({ ...asset, id: 'next', url: '/api/video-director/assets/next' }))
  assert.equal(firstSignal.aborted, true)
  await ui.act(async () => resolveFirst(Response.json({ ok: true, value: properties })))
  const info = document.querySelector('[aria-label="Video properties"]')
  assert.match(info.textContent, /60 fps/)
  assert.match(info.textContent, /1280 × 1080/)
  assert.doesNotMatch(info.textContent, /29.97/)
})
