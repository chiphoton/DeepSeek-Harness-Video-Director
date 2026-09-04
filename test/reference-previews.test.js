import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

async function referencePreviewsModule() {
  const entry = fileURLToPath(new URL('../src/client/reference-previews.ts', import.meta.url))
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
}

test('Text Workflow References previews follow reference-edge order and ignore parameter inputs', async () => {
  const { referencePreviewsByTarget } = await referencePreviewsModule()
  const asset = {
    id: 'asset-image',
    projectId: 'project',
    kind: 'image',
    name: 'room.png',
    mimeType: 'image/png',
    size: 10,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-03T00:00:00.000Z',
    url: '/assets/room.png',
  }
  const graph = {
    nodes: [
      { id: 'text', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Brief', text: 'Warm evening room' } },
      { id: 'image', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-image', title: 'Room', mediaKind: 'image', asset } },
      { id: 'parameter', type: 'director', position: { x: 0, y: 400 }, data: { kind: 'load-text', title: 'Prompt override', text: 'Override' } },
      {
        id: 'enhancer', type: 'director', position: { x: 400, y: 0 },
        data: { kind: 'prompt-enhancer', title: 'Prompt Enhancer', prompt: '', fieldInputModes: { prompt: { mode: 'input' } } },
      },
    ],
    edges: [
      { id: 'reference-1', source: 'text', sourceHandle: 'out', target: 'enhancer', targetHandle: 'in' },
      { id: 'reference-2', source: 'image', sourceHandle: 'out', target: 'enhancer', targetHandle: 'in' },
      { id: 'prompt-input', source: 'parameter', sourceHandle: 'out', target: 'enhancer', targetHandle: 'in:field:prompt' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const previews = referencePreviewsByTarget(graph, [])

  assert.deepEqual(previews.enhancer, [
    {
      edgeId: 'reference-1',
      sourceNodeId: 'text',
      sourceTitle: 'Brief',
      kind: 'text',
      text: 'Warm evening room',
      asset: undefined,
    },
    {
      edgeId: 'reference-2',
      sourceNodeId: 'image',
      sourceTitle: 'Room',
      kind: 'image',
      text: undefined,
      asset,
    },
  ])
})

test('all Reference thumbnails use per-type numbering in connection order', async () => {
  const { referenceLabelsByKind } = await referencePreviewsModule()

  assert.deepEqual(referenceLabelsByKind([
    { kind: 'image' },
    { kind: 'audio' },
    { kind: 'image' },
    { kind: 'video' },
    { kind: 'audio' },
    { kind: 'text' },
  ]), [
    'Image 1',
    'Audio 1',
    'Image 2',
    'Video 1',
    'Audio 2',
    'Text 1',
  ])
})
