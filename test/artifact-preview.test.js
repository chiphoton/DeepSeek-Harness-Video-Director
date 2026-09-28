import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'HTMLVideoElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLMediaElement.prototype.play = function () {
  Object.defineProperty(this, 'paused', { value: false, configurable: true })
  this.dispatchEvent(new dom.window.Event('play'))
  return Promise.resolve()
}
dom.window.HTMLMediaElement.prototype.pause = function () {
  Object.defineProperty(this, 'paused', { value: true, configurable: true })
  this.dispatchEvent(new dom.window.Event('pause'))
}
globalThis.OfflineAudioContext = class {
  async decodeAudioData() { return { duration: 3, length: 1000, numberOfChannels: 1,
    getChannelData: () => Float32Array.from({ length: 1000 }, (_, index) => Math.sin(index / 10)) } }
}
const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
    import React, { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlowProvider } from '@xyflow/react';
    import { DirectorNodeView, DirectorRuntimeProvider } from './DirectorNode';
    import { ArtifactPreviewDialog, previewArtifactFromAsset } from './ArtifactPreview';
    import { MediaEditingContext } from './media-editing';
    export { act };
    export { setLanguage } from './i18n';
    export function mount(kind, asset, editMedia) {
      const root = createRoot(document.getElementById('root'));
      const render = next => root.render(<MediaEditingContext.Provider value={editMedia ?? null}>{kind === 'inspect'
        ? <ArtifactPreviewDialog artifact={previewArtifactFromAsset(next)} onClose={() => {}} />
        : <ReactFlowProvider><DirectorRuntimeProvider value={{nodeDefinitions: [{type: 'test.output', version: '1.0.0', inputs: [], outputs: [], fields: []}], references: {}}}>
            <DirectorNodeView id="output" data={{kind, nodeType: 'test.output', title: 'Output', assets: [next]}} />
          </DirectorRuntimeProvider></ReactFlowProvider>}</MediaEditingContext.Provider>);
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

async function mount(t, kind, media = asset, editMedia) {
  let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(kind, media, editMedia) })
  t.after(() => ui.act(() => root.unmount()))
  return root
}

function click(label) {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === label || el.getAttribute('aria-label') === label)
  assert.ok(button, label)
  return ui.act(async () => button.click())
}

test('equivalent live snapshots keep an open preview and its metadata request intact', async t => {
  let reads = 0
  globalThis.fetch = async () => { reads++; return Response.json({ ok: true, value: properties }) }
  const root = await mount(t, 'inspect')
  const player = document.querySelector('.vd-artifact-dialog video')
  for (let index = 0; index < 5; index++) {
    await ui.act(async () => root.render(structuredClone(asset)))
  }
  assert.equal(document.querySelector('.vd-artifact-dialog video'), player)
  assert.equal(reads, 1, 'polls must not restart ffprobe for an unchanged immutable asset')
})

test('offscreen video thumbnails do not load media and release their source when hidden', async t => {
  let notify, target
  globalThis.IntersectionObserver = class {
    constructor(callback) { notify = callback }
    observe(element) { target = element }
    unobserve() {}
    disconnect() {}
  }
  t.after(() => { delete globalThis.IntersectionObserver })
  await mount(t, 'preview')
  assert.ok(target)
  assert.equal(target.hasAttribute('src'), false)
  await ui.act(async () => notify([{ target, isIntersecting: true }]))
  assert.equal(target.getAttribute('src'), asset.url)
  await ui.act(async () => notify([{ target, isIntersecting: false }]))
  assert.equal(target.hasAttribute('src'), false)
})

for (const kind of ['inspect', 'preview', 'save']) {
  test(`${kind} audio popup shows duration, format, sample rate, channels and embedded metadata`, async t => {
    const audio = { ...asset, id: `audio-${kind}`, url: `/api/video-director/assets/audio-${kind}`, kind: 'audio', mimeType: 'audio/wav', name: 'sound.wav' }
    const requests = []
    globalThis.fetch = async url => { requests.push(url); return url === audio.url ? new Response(new Uint8Array(10)) : Response.json({ ok: true, value: {
      duration: 3, format: 'WAV', codec: 'pcm_s16le', sampleRate: 48000, channels: 2,
      metadata: [{ name: 'Container · comment', value: 'Bird song' }],
    } }) }
    await mount(t, kind, audio)
    if (kind !== 'inspect') await click('Preview sound.wav')
    assert.deepEqual(requests, [`${audio.url}/properties`, audio.url])
    const info = document.querySelector('[aria-label="Audio properties"]')
    assert.match(info.textContent, /3.00 s/)
    assert.match(info.textContent, /WAV/)
    assert.match(info.textContent, /48000 Hz/)
    assert.match(info.textContent, /Channels2/)
    assert.match(info.textContent, /12,345/)
    assert.ok(document.querySelector('.vd-artifact-dialog.is-audio-dialog'))
    assert.ok(document.querySelector('[aria-label="Audio waveform"]'))
    assert.ok(document.querySelector('[aria-label="Audio overview"]'))
    assert.equal(document.querySelector('.vd-artifact-dialog audio').controls, false)
    await click('Forward 15 seconds')
    assert.equal(document.querySelector('audio').currentTime, 3)
    assert.equal(document.querySelector('[aria-label="Playback time"]').textContent, '00:03.00')
    await click('Back 15 seconds')
    assert.equal(document.querySelector('audio').currentTime, 0)
    await click('Play')
    assert.ok(document.querySelector('[aria-label="Pause"]'))
    await click('Pause')
    const overview = document.querySelector('[aria-label="Audio overview"]')
    ui.act(() => overview.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(document.querySelector('audio').currentTime, .1)
    await click('Mute')
    assert.equal(document.querySelector('audio').muted, true)
    const speed = document.querySelector('[aria-label="Playback speed"]')
    ui.act(() => { speed.value = '1.5'; speed.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    assert.equal(document.querySelector('audio').playbackRate, 1.5)
    await click('Metadata')
    assert.match(document.querySelector('.vd-image-metadata').textContent, /Bird song/)
    assert.doesNotMatch(document.querySelector('.vd-image-properties-dialog').textContent, /Dimensions|Bit depth/)
    await click('Close audio properties')
  })

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

test('audio decoding failure leaves playback and seeking available and switching clips resets the player', async t => {
  const previousContext = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = class { async decodeAudioData() { throw new Error('unsupported decoder') } }
  t.after(() => { globalThis.OfflineAudioContext = previousContext })
  globalThis.fetch = async url => String(url).endsWith('/properties')
    ? Response.json({ ok: true, value: { duration: 10, format: 'FLAC', metadata: [] } }) : new Response(new Uint8Array(10))
  const root = await mount(t, 'inspect', { ...asset, id: 'first-audio', kind: 'audio', mimeType: 'audio/flac' })
  assert.match(document.querySelector('[role="status"]').textContent, /Waveform unavailable/)
  await click('Play')
  const first = document.querySelector('audio')
  await click('Forward 15 seconds')
  assert.equal(first.currentTime, 10)
  await ui.act(async () => root.render({ ...asset, id: 'second-audio', kind: 'audio', url: '/another-audio', mimeType: 'audio/flac' }))
  assert.equal(first.paused, true)
  assert.equal(document.querySelector('audio').currentTime, 0)
  assert.ok(document.querySelector('[aria-label="Play"]'))
})

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

function inputNumber(label, value) {
  const input = [...document.querySelectorAll('.vd-media-editor label')].find(node => node.textContent === label)?.querySelector('input')
  assert.ok(input, label)
  return ui.act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, String(value))
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    input.blur()
  })
}

test('preview context menu dismisses on clicks stopped by the dialog, and its Edit action opens the editor', async t => {
  globalThis.fetch = async () => Response.json({ ok: true, value: properties })
  await mount(t, 'inspect')
  const content = document.querySelector('.is-video')
  const open = () => ui.act(() => content.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 })))
  open()
  assert.ok(document.querySelector('[role="menu"]'))
  ui.act(() => document.querySelector('.vd-artifact-dialog header').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
  assert.equal(document.querySelector('[role="menu"]'), null)
  open()
  const button = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'Edit Video')
  ui.act(() => button.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
  assert.ok(document.querySelector('[role="menu"]'), 'pointerdown inside a menu must not swallow its action')
  await click('Edit Video')
  assert.ok(document.querySelector('.vd-media-editor'))
  assert.equal(document.querySelector('[role="menu"]'), null)
  await click('Close media editor')
  assert.equal(document.querySelector('.vd-media-editor'), null)
  assert.ok(document.querySelector('.vd-artifact-dialog'))
})

for (const kind of ['audio', 'video']) {
  test(`${kind} editor closes without confirmation when only the browser duration changes`, async t => {
    const media = { ...asset, id: `close-${kind}`, kind, mimeType: `${kind}/${kind === 'audio' ? 'flac' : 'mp4'}` }
    globalThis.fetch = async url => String(url).endsWith('/properties')
      ? Response.json({ ok: true, value: properties }) : new Response(new Uint8Array(10))
    await mount(t, 'inspect', media)
    await click('Edit')
    const player = document.querySelector(`.vd-media-editor ${kind}`)
    Object.defineProperty(player, 'duration', { value: 4, configurable: true })
    await ui.act(async () => player.dispatchEvent(new dom.window.Event('durationchange')))
    await click('Close media editor')
    assert.ok(document.querySelector('.vd-media-editor') === null, 'loading a more precise duration is not a user edit')
    assert.ok(document.querySelector('.vd-artifact-dialog'), 'closing the editor keeps the source preview open')
  })

  test(`${kind} editor asks for confirmation with keyboard focus before discarding changes`, async t => {
    const media = { ...asset, id: `confirm-${kind}`, kind, mimeType: `${kind}/${kind === 'audio' ? 'flac' : 'mp4'}` }
    globalThis.fetch = async url => String(url).endsWith('/properties')
      ? Response.json({ ok: true, value: properties }) : new Response(new Uint8Array(10))
    let writes = 0
    await mount(t, 'inspect', media, async () => { writes++; throw new Error('Closing must not save media') })
    await click('Edit')
    await inputNumber('Start (seconds)', 1)
    await click('Close media editor')
    const confirmation = document.querySelector('[role="alertdialog"]')
    assert.ok(confirmation, 'close must present a confirmation dialog')
    assert.ok(confirmation.contains(document.activeElement), 'the confirmation must receive keyboard focus')
    const buttons = confirmation.querySelectorAll('button')
    ui.act(() => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, buttons[1])
    ui.act(() => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, buttons[0])
    await click('Keep editing')
    assert.equal(document.querySelector('[role="alertdialog"]'), null)
    assert.equal(document.querySelector('[aria-label="Trim start"]').getAttribute('aria-valuenow'), '1')
    await click('Close media editor')
    const discard = [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Discard changes')
    await ui.act(async () => discard.click())
    assert.equal(document.querySelector('.vd-media-editor'), null)
    assert.equal(writes, 0)
  })

  test(`${kind} editor combines selected trims with crop where applicable, activates a saved copy, and discards without writing`, async t => {
    const media = { ...asset, id: `editable-${kind}`, kind, name: `source.${kind === 'audio' ? 'flac' : 'mp4'}`, mimeType: `${kind}/${kind === 'audio' ? 'flac' : 'mp4'}` }
    globalThis.fetch = async url => String(url).endsWith('/properties')
      ? Response.json({ ok: true, value: { ...properties, duration: 10 } }) : new Response(new Uint8Array(10))
    const calls = []
    await mount(t, 'inspect', media, async (source, edit, action, signal) => {
      calls.push({ source, edit, action, signal })
      return { asset: { ...source, id: 'edited', url: '/edited', name: 'edited-copy.' + (kind === 'audio' ? 'flac' : 'mp4') } }
    })
    const header = document.querySelector('.vd-artifact-dialog header')
    assert.match(header.textContent, /EditMetadata/)
    await click('Edit')
    assert.equal(document.querySelector('.vd-media-editor [aria-label="Save"]').disabled, true)
    await inputNumber('Start (seconds)', 1)
    await inputNumber('End (seconds)', 5)
    assert.equal(document.querySelector('.vd-media-editor [aria-label="Save"]').disabled, false)
    assert.equal(document.querySelector('[aria-label="Trim start"]').getAttribute('aria-valuenow'), '1')
    if (kind === 'video') {
      await click('Crop')
      await click('1:1')
      assert.ok(document.querySelector('.vd-media-crop-box'))
    } else assert.equal(document.querySelector('.vd-media-editor [aria-label="Crop"]'), null)
    await click('Save as new copy')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].action, 'copy')
    assert.deepEqual([calls[0].edit.start, calls[0].edit.end], [1, 5])
    if (kind === 'video') assert.deepEqual(calls[0].edit.crop, { x: 420, y: 0, width: 1080, height: 1080 })
    assert.equal(document.querySelector('.vd-media-editor'), null)
    assert.match(document.querySelector('.vd-artifact-dialog header').textContent, /edited-copy/)
    await click('Edit')
    await inputNumber('Start (seconds)', 2)
    await click('Close media editor')
    assert.match(document.querySelector('.vd-media-editor-confirm').textContent, /Discard unsaved edits/)
    await click('Keep editing')
    await click('Discard changes')
    assert.equal(calls.length, 1)
    assert.equal(document.querySelector('.vd-media-editor'), null)
    assert.match(document.querySelector('.vd-artifact-dialog header').textContent, /edited-copy/)
  })
}

test('metadata changes preserve a manual trim, while Reset trim makes closing immediate again', async t => {
  globalThis.fetch = async () => Response.json({ ok: true, value: properties })
  await mount(t, 'inspect')
  await click('Edit')
  await inputNumber('End (seconds)', 2)
  const player = document.querySelector('.vd-media-editor video')
  Object.defineProperty(player, 'duration', { value: 4, configurable: true })
  await ui.act(async () => player.dispatchEvent(new dom.window.Event('durationchange')))
  assert.equal(document.querySelector('[aria-label="Trim end"]').getAttribute('aria-valuenow'), '2')
  await click('Close media editor')
  assert.ok(document.querySelector('[role="alertdialog"]'))
  ui.act(() => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })))
  assert.ok(document.querySelector('.vd-media-editor'))
  assert.equal(document.querySelector('[role="alertdialog"]'), null)
  await click('Reset trim')
  await click('Close media editor')
  assert.equal(document.querySelector('.vd-media-editor'), null)
})

test('opening Crop on an odd-sized video is not itself an edit', async t => {
  globalThis.fetch = async () => Response.json({ ok: true, value: { ...properties, width: 1921, height: 1081 } })
  await mount(t, 'inspect')
  await click('Edit')
  await click('Crop')
  assert.ok(document.querySelector('.vd-media-crop-box'))
  await click('Close media editor')
  assert.ok(document.querySelector('.vd-media-editor') === null)
})

test('closing unchanged media during an export cancels processing and closes the editor', async t => {
  globalThis.fetch = async () => Response.json({ ok: true, value: properties })
  let signal
  await mount(t, 'inspect', asset, async (_source, _edit, _action, operationSignal) => {
    signal = operationSignal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))
  })
  await click('Edit')
  await click('Export')
  assert.ok(signal && !signal.aborted)
  await click('Close media editor')
  assert.equal(signal.aborted, true)
  assert.equal(document.querySelector('.vd-media-editor'), null)
})
