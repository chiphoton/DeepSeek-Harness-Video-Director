import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let parser

async function imageParser() {
  if (parser !== undefined) return parser
  const entry = fileURLToPath(new URL('../src/client/image-properties.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  parser = await import(`data:text/javascript;base64,${source}`)
  return parser
}

test('image properties read PNG dimensions and per-pixel bit depth', async () => {
  const { parseImageProperties } = await imageParser()
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(1920, 16)
  bytes.writeUInt32BE(1080, 20)
  bytes[24] = 8
  bytes[25] = 2

  assert.deepEqual(parseImageProperties(bytes, 'image/png'), {
    format: 'PNG',
    width: 1920,
    height: 1080,
    bitDepth: '8 bits/channel · 24 bits/pixel',
    metadata: [],
  })
})

test('image properties read JPEG precision, components, and dimensions', async () => {
  const { parseImageProperties } = await imageParser()
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11,
    0x08, 0x02, 0x00, 0x03, 0x20, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ])

  const result = parseImageProperties(bytes, 'image/jpeg')
  assert.equal(result.format, 'JPEG')
  assert.equal(result.width, 800)
  assert.equal(result.height, 512)
  assert.equal(result.bitDepth, '8 bits/channel · 24 bits/pixel')
})

test('unknown binary images fall back to their MIME format', async () => {
  const { parseImageProperties } = await imageParser()
  assert.deepEqual(parseImageProperties(new Uint8Array([1, 2, 3]), 'image/avif'), {
    format: 'AVIF',
    metadata: [],
  })
})
