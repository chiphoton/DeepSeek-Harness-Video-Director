import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let modulePromise

async function sketchDocumentModule() {
  modulePromise ??= (async () => {
    const entry = fileURLToPath(new URL('../src/client/sketch-document.ts', import.meta.url))
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

const asset = {
  id: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  kind: 'sketch',
  name: 'legacy.png',
  mimeType: 'image/png',
  size: 1024,
  sha256: 'a'.repeat(64),
  createdAt: '2026-09-04T00:00:00.000Z',
  url: '/asset/legacy.png',
}

test('clearing a legacy sketch removes its raster base without mutating the undoable document', async () => {
  const { clearSketchDocument, legacySketchDocument, sketchHasContent } = await sketchDocumentModule()
  const original = legacySketchDocument(asset, 1280, 720, '#ffffff')

  const cleared = clearSketchDocument(original)

  assert.equal(sketchHasContent(original), true)
  assert.equal(original.base?.asset.id, asset.id)
  assert.equal(sketchHasContent(cleared), false)
  assert.equal(cleared.base, undefined)
  assert.deepEqual(cleared.elements, [])
})

test('resizing a sketch keeps its content centered while changing the output canvas', async () => {
  const { legacySketchDocument, resizeSketchDocument } = await sketchDocumentModule()
  const original = {
    ...legacySketchDocument(asset, 1280, 720, '#ffffff'),
    elements: [
      { id: 'line', type: 'line', color: '#111111', width: 8, start: { x: 100, y: 200 }, end: { x: 300, y: 400 } },
      { id: 'text', type: 'text', color: '#111111', fontSize: 24, point: { x: 640, y: 360 }, text: 'Center' },
    ],
  }

  const resized = resizeSketchDocument(original, 1000, 600)

  assert.equal(resized.width, 1000)
  assert.equal(resized.height, 600)
  assert.deepEqual(resized.base, { ...original.base, x: -140, y: -60 })
  assert.deepEqual(resized.elements[0].start, { x: -40, y: 140 })
  assert.deepEqual(resized.elements[0].end, { x: 160, y: 340 })
  assert.deepEqual(resized.elements[1].point, { x: 500, y: 300 })
  assert.deepEqual(original.elements[1].point, { x: 640, y: 360 })
})
