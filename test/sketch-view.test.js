import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let modulePromise

async function sketchViewModule() {
  modulePromise ??= (async () => {
    const entry = fileURLToPath(new URL('../src/client/sketch-view.ts', import.meta.url))
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
    })
    const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
    return import(`data:text/javascript;base64,${source}`)
  })()
  return modulePromise
}

test('wheel zoom keeps the canvas coordinate beneath the pointer stationary', async () => {
  const { zoomSketchCanvasView } = await sketchViewModule()
  const view = { scale: 1.4, x: 35, y: -28 }
  const pointer = { x: 210, y: -95 }
  const before = {
    x: (pointer.x - view.x) / view.scale,
    y: (pointer.y - view.y) / view.scale,
  }

  const zoomed = zoomSketchCanvasView(view, pointer, -420)
  const after = {
    x: (pointer.x - zoomed.x) / zoomed.scale,
    y: (pointer.y - zoomed.y) / zoomed.scale,
  }

  assert.ok(zoomed.scale > view.scale)
  assert.ok(Math.abs(after.x - before.x) < 1e-9)
  assert.ok(Math.abs(after.y - before.y) < 1e-9)
})

test('wheel zoom is bounded and Fit returns the identity view', async () => {
  const { fitSketchCanvasView, zoomSketchCanvasView } = await sketchViewModule()
  const view = fitSketchCanvasView()

  assert.deepEqual(view, { scale: 1, x: 0, y: 0 })
  assert.equal(zoomSketchCanvasView(view, { x: 0, y: 0 }, -100_000).scale, 8)
  assert.equal(zoomSketchCanvasView(view, { x: 0, y: 0 }, 100_000).scale, 0.25)
})
