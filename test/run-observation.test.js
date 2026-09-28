import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/client/controller.ts'], bundle: true, format: 'esm', platform: 'browser', write: false })
const { DirectorController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=run-observation-tests.js').toString('base64')}`)

function fixture(t) {
  const calls = []
  const runs = [{ id: 'run', projectId: 'p', scheduler: 'host', status: 'running', startedAt: '2026-09-27T00:00:00Z' }]
  const jobs = [{ id: 'j', nodeId: 'n', projectId: 'p', status: 'running', updatedAt: '2026-09-27T00:00:00Z', progress: .1 }]
  const projects = [{ id: 'p', name: 'Synthetic', nodeCount: 1 }]
  const director = new DirectorController({ connection: { rpc: { call: async (_, endpoint) => {
    calls.push(endpoint)
    return { ok: true, value: structuredClone(endpoint === 'vd-runs/list' ? { runs } : endpoint === 'jobs/list' ? { jobs } : { projects }) }
  } } } })
  t.after(() => director.dispose())
  return { director, calls, runs, jobs }
}

test('simultaneous workflow observers share the background poll cadence', async t => {
  const { director, calls, runs } = fixture(t)
  const observers = [director.observeHostRuns(['run']), director.observeHostRuns(['run'])]
  await new Promise(resolve => setTimeout(resolve, 1050))
  const pollCount = calls.filter(endpoint => endpoint === 'vd-runs/list').length
  runs[0].status = 'completed'
  await director.refreshVdRuns()
  await Promise.all(observers)
  assert.equal(pollCount, 1, 'waiting for a submitted workflow must not poll again every 250ms')
})

test('unchanged polls preserve the snapshot and do not notify the canvas', async t => {
  const { director } = fixture(t)
  await director.refreshVdRuns()
  const previous = director.getSnapshot()
  let notifications = 0
  director.subscribe(() => notifications++)
  await director.refreshVdRuns()
  assert.equal(notifications, 0)
  assert.equal(director.getSnapshot(), previous)
})

test('unchanged polls keep a selected canvas stable when unsaved nodes differ from Host summaries', async t => {
  const { director } = fixture(t)
  director.snapshot = { ...director.getSnapshot(), phase: 'ready', dirty: true, project: {
    id: 'p', name: 'Synthetic', status: 'running', jobs: [], settings: {},
    graph: { nodes: ['local-a', 'local-b'].map(id => ({ id, type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', text: 'Synthetic' } })), edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  } }
  await director.refreshVdRuns()
  await director.refreshVdRuns()
  const before = director.getSnapshot()
  let notifications = 0
  director.subscribe(() => notifications++)
  await director.refreshVdRuns()
  assert.equal(notifications, 0)
  assert.equal(director.getSnapshot(), before)
  assert.equal(before.projects[0].nodeCount, 2)
})

test('drawer subscriptions share refreshes, recover from errors, and release their timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let fail = true, calls = 0
  const errors = []
  const director = new DirectorController({ connection: { rpc: { call: async (_, endpoint) => {
    if (endpoint === 'vd-runs/list') { calls++; if (fail) throw new Error('Offline') }
    return { ok: true, value: endpoint === 'vd-runs/list' ? { runs: [] } : endpoint === 'jobs/list' ? { jobs: [] } : { projects: [] } }
  } } } })
  t.after(() => director.dispose())
  const first = director.watchVdRuns(error => errors.push(String(error)))
  const second = director.watchVdRuns()
  await new Promise(setImmediate)
  assert.equal(calls, 1)
  assert.deepEqual(errors, ['Error: Offline'])
  fail = false
  t.mock.timers.tick(1400)
  await new Promise(setImmediate)
  assert.equal(calls, 2)
  first()
  t.mock.timers.tick(1400)
  await new Promise(setImmediate)
  assert.equal(calls, 3)
  second()
  t.mock.timers.tick(10000)
  await new Promise(setImmediate)
  assert.equal(calls, 3)
})

test('progress updates preserve cached preview media while completion still propagates sink status', async t => {
  const { director } = fixture(t)
  const asset = { id: 'synthetic', kind: 'video', url: '/synthetic.mp4' }
  const source = { id: 'n', type: 'director', position: { x: 0, y: 0 }, data: {
    kind: 'video-generation', title: 'Synthetic generator', status: 'running', progress: .1,
    result: { kind: 'assets', assets: [asset], providerId: 'test' }, assets: [asset], mediaKind: 'video',
  } }
  const preview = { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: {
    kind: 'preview', title: 'Cached output', status: 'idle', assets: [asset], mediaKind: 'video',
  } }
  director.snapshot = { ...director.getSnapshot(), phase: 'ready', project: {
    id: 'p', name: 'Synthetic', status: 'running', graph: { nodes: [source, preview], edges: [{ id: 'e', source: 'n', target: 'preview' }], viewport: { x: 0, y: 0, zoom: 1 } }, jobs: [], settings: {},
  } }
  director.updateSystemNode('n', { status: 'running', progress: .5 })
  assert.equal(director.getSnapshot().project.graph.nodes[1], preview)
  director.updateSystemNode('n', { status: 'completed', runCompletedAt: '2026-09-27T00:01:00Z' })
  assert.equal(director.getSnapshot().project.graph.nodes[1].data.status, 'completed')
  assert.equal(director.getSnapshot().project.graph.nodes[1].data.assets[0], asset)
})
