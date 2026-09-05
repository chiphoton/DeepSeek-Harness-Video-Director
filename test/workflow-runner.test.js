import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let runner

async function workflowRunner() {
  if (runner !== undefined) return runner
  const entry = fileURLToPath(new URL('../src/client/workflow-runner.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  runner = await import(`data:text/javascript;base64,${source}`)
  return runner
}

function node(id, kind, data = {}) {
  return { id, type: 'director', position: { x: 0, y: 0 }, data: { kind, title: id, ...data } }
}

function edge(source, target) {
  return { id: `${source}-${target}`, source, target }
}

test('workflow planning collapses local data nodes into executable dependency stages', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [
      node('input', 'load-text'),
      node('enhance', 'prompt-enhancer'),
      node('preview', 'preview'),
      node('generate', 'video-generation'),
      node('independent', 'audio-generation'),
    ],
    edges: [edge('input', 'enhance'), edge('enhance', 'preview'), edge('preview', 'generate')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const plan = planVdRun(graph, { mode: 'all' })

  assert.deepEqual(plan.stages, [['enhance', 'independent'], ['generate']])
  assert.deepEqual(plan.nodeIds, ['enhance', 'independent', 'generate'])
})

test('selected and from-selection modes have distinct scopes', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [node('a', 'prompt-enhancer'), node('b', 'image-generation'), node('c', 'video-generation')],
    edges: [edge('a', 'b'), edge('b', 'c')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  assert.deepEqual(planVdRun(graph, { mode: 'selected', selectedNodeIds: ['b'] }).nodeIds, ['b'])
  assert.deepEqual(planVdRun(graph, { mode: 'from-selection', selectedNodeIds: ['b'] }).nodeIds, ['b', 'c'])
})

test('dependency mode runs only executable ancestors of the selected output', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [
      node('input', 'load-text'),
      node('enhance', 'prompt-enhancer'),
      node('generate', 'image-generation'),
      node('preview', 'preview'),
      node('unrelated', 'video-generation'),
    ],
    edges: [edge('input', 'enhance'), edge('enhance', 'generate'), edge('generate', 'preview')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const plan = planVdRun(graph, { mode: 'dependencies', selectedNodeIds: ['preview'] })

  assert.deepEqual(plan.nodeIds, ['enhance', 'generate'])
  assert.deepEqual(plan.stages, [['enhance'], ['generate']])
  assert.deepEqual(plan.frozenNodeIds, [])
})

test('a frozen node is a cached dependency boundary and is excluded from run stages', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [
      node('enhance', 'prompt-enhancer'),
      node('cached', 'image-generation', { frozen: true }),
      node('animate', 'video-generation'),
      node('preview', 'preview'),
    ],
    edges: [edge('enhance', 'cached'), edge('cached', 'animate'), edge('animate', 'preview')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const plan = planVdRun(graph, { mode: 'dependencies', selectedNodeIds: ['preview'] })

  assert.deepEqual(new Set(plan.scopeNodeIds), new Set(['cached', 'animate', 'preview']))
  assert.deepEqual(plan.frozenNodeIds, ['cached'])
  assert.deepEqual(plan.nodeIds, ['animate'])
  assert.deepEqual(plan.stages, [['animate']])
})

test('workflow planning rejects cycles before submitting any node', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [node('a', 'prompt-enhancer'), node('b', 'prompt-enhancer')],
    edges: [edge('a', 'b'), edge('b', 'a')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  assert.throws(() => planVdRun(graph, { mode: 'all' }), /cycle involving: a, b/)
})

test('VRAM triggers form sequential execution barriers between workflow nodes', async () => {
  const { planVdRun } = await workflowRunner()
  const graph = {
    nodes: [
      node('image', 'image-generation'),
      node('clear', 'vram-trigger'),
      node('video', 'video-generation'),
    ],
    edges: [edge('image', 'clear'), edge('clear', 'video')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  assert.deepEqual(planVdRun(graph, { mode: 'all' }).stages, [['image'], ['clear'], ['video']])
})

test('VRAM triggers reject isolated execution but accept either connected end', async () => {
  const { validateTriggerNodeConnections } = await workflowRunner()
  const isolated = {
    nodes: [node('clear', 'vram-trigger')],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  assert.throws(() => validateTriggerNodeConnections(isolated, 'clear'), /at least one connected end/i)

  const withOutput = {
    nodes: [node('clear', 'vram-trigger'), node('video', 'video-generation')],
    edges: [edge('clear', 'video')],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  assert.doesNotThrow(() => validateTriggerNodeConnections(withOutput, 'clear'))
})
