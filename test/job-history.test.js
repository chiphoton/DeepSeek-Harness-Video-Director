import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'
import { ProjectStore } from '../src/project-store.js'
import { createDirectorRpc } from '../src/rpc.js'
import { compareJobHistory, groupJobHistory, pageJobHistory } from '../src/job-history.js'

const bundle = await build({ entryPoints: ['src/client/controller.ts'], bundle: true, format: 'esm', platform: 'browser', write: false })
const { DirectorController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=job-history-tests.js').toString('base64')}`)

function memoryFixture(t, count = 27) {
  const rows = Array.from({ length: count }, (_, i) => {
    const time = new Date(Date.UTC(2026, 8, 28, 0, 0, count - i)).toISOString()
    const run = { id: `run-${i}`, projectId: i % 2 ? 'b' : 'a', status: 'completed', startedAt: time, completedAt: time }
    return { id: run.id, projectId: run.projectId, run, submitted: time, jobs: [] }
  })
  const calls = []
  let fail = false, gate = null
  const create = () => {
    const director = new DirectorController({ connection: { rpc: { call: async (_, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'jobs/history') {
        if (gate) await gate
        if (fail) throw new Error('Offline')
        return { ok: true, value: structuredClone(pageJobHistory(rows.filter(row => !payload.projectId || row.projectId === payload.projectId), payload)) }
      }
      return { ok: true, value: structuredClone(endpoint === 'vd-runs/list'
        ? { runs: rows.map(row => row.run).filter(run => payload.observe.ids.includes(run.id) || run.status === 'running') }
        : endpoint === 'jobs/list' ? { jobs: [] } : { projects: [{ id: 'a' }, { id: 'b' }] }) }
    } } } })
    t.after(() => director.dispose())
    return director
  }
  return { rows, calls, create, setFail: value => { fail = value }, setGate: value => { gate = value } }
}

test('pages fetch ten, persist across drawer lifetimes and filters, and start fresh in a new controller', async t => {
  const f = memoryFixture(t), director = f.create()
  await director.jobHistory.loadMore()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 10)
  await Promise.all([director.jobHistory.loadMore(), director.jobHistory.loadMore(), director.jobHistory.loadMore()])
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 20)
  assert.equal(f.calls.length, 2, 'concurrent bottom events share one page request')
  const release = director.jobHistory.watch('')
  release()
  director.jobHistory.watch('')()
  assert.equal(f.calls.length, 2, 'reopening reuses the same memory object')
  await director.jobHistory.loadMore('b')
  assert.equal(director.getSnapshot().jobHistory.b.groups.length, 10)
  assert.ok(director.getSnapshot().jobHistory.b.groups.every(row => row.projectId === 'b'))
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 20)
  await director.jobHistory.loadMore()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 27)
  assert.equal(director.getSnapshot().jobHistory[''].nextCursor, null)
  const calls = f.calls.length
  await director.jobHistory.loadMore()
  assert.equal(f.calls.length, calls, 'no requests after exhaustion')
  const second = f.create()
  await second.jobHistory.loadMore()
  assert.equal(second.getSnapshot().jobHistory[''].groups.length, 10)
})

test('failed pages retain their records and cursor, retry once, and ignore results after disposal', async t => {
  const f = memoryFixture(t), director = f.create()
  await director.jobHistory.loadMore()
  const previous = director.getSnapshot().jobHistory['']
  f.setFail(true)
  await assert.rejects(director.jobHistory.loadMore(), /Offline/)
  assert.equal(director.getSnapshot().jobHistory[''].groups, previous.groups)
  assert.equal(director.getSnapshot().jobHistory[''].nextCursor, previous.nextCursor)
  f.setFail(false)
  await director.jobHistory.loadMore()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 20)
  let release
  f.setGate(new Promise(resolve => { release = resolve }))
  const pending = director.jobHistory.loadMore()
  let changed = 0
  director.subscribe(() => changed++)
  director.dispose()
  release()
  await pending
  assert.equal(changed, 0)
  assert.deepEqual(director.jobHistory.groups(), [])
})

test('new submissions fill the gap above cached pages while older paging survives deletes and tied dates', async t => {
  const f = memoryFixture(t), director = f.create()
  await director.jobHistory.loadMore()
  const release = director.jobHistory.watch('')
  t.after(release)
  const oldIds = f.rows.map(row => row.id)
  const time = '2026-09-29T00:00:00.000Z'
  f.rows.push(...Array.from({ length: 23 }, (_, i) => ({ id: `new-${i}`, projectId: 'a', submitted: time, jobs: [],
    run: { id: `new-${i}`, projectId: 'a', status: 'completed', startedAt: time, completedAt: time } })))
  f.rows.sort(compareJobHistory)
  await director.jobHistory.refreshWatched()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 33, 'all newly arrived pages are retained without a gap')
  f.rows.splice(f.rows.findIndex(row => row.id === oldIds[3]), 1)
  director.jobHistory.remove(oldIds[3])
  await director.jobHistory.loadMore()
  const loaded = director.getSnapshot().jobHistory[''].groups
  assert.equal(loaded.length, 42)
  assert.equal(new Set(loaded.map(row => row.id)).size, 42)
  for (const id of oldIds.slice(10, 20)) assert.ok(loaded.some(row => row.id === id))
  assert.ok(f.calls.filter(call => call.endpoint === 'jobs/history').every(call => call.payload.limit === 10))
})

test('shared observation updates loaded cards and does not fetch unrequested history', async t => {
  const f = memoryFixture(t), director = f.create()
  f.rows[0].run.status = 'running'
  await director.jobHistory.loadMore()
  await director.refreshVdRuns()
  assert.equal(director.getSnapshot().workflowRuns.length, 10)
  const first = director.getSnapshot().jobHistory[''].groups[0]
  f.rows[0].run.status = 'completed'
  await director.refreshVdRuns()
  assert.equal(director.getSnapshot().jobHistory[''].groups[0].run.status, 'completed')
  assert.notEqual(director.getSnapshot().jobHistory[''].groups[0], first)
  const stable = director.getSnapshot()
  await director.refreshVdRuns()
  assert.equal(director.getSnapshot(), stable)
  f.rows[0].run.hidden = true
  await director.refreshVdRuns()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 9)
})

test('a new record sharing the newest timestamp is admitted without loading older pages', async t => {
  const f = memoryFixture(t), director = f.create()
  await director.jobHistory.loadMore()
  const stop = director.jobHistory.watch('')
  t.after(stop)
  f.rows.push({ ...structuredClone(f.rows[0]), id: 'q', run: { ...f.rows[0].run, id: 'q' } })
  f.rows.sort(compareJobHistory)
  await director.jobHistory.refreshWatched()
  assert.equal(director.getSnapshot().jobHistory[''].groups.length, 11)
  assert.ok(director.getSnapshot().jobHistory[''].groups.some(row => row.id === 'q'))
  assert.equal(f.calls.length, 2)
  const snapshot = director.getSnapshot()
  await director.jobHistory.refreshWatched()
  assert.equal(director.getSnapshot(), snapshot, 'unchanged head checks preserve cached rows')
})

test('empty history polling preserves the snapshot and history failures do not block workflow completion', async t => {
  const f = memoryFixture(t, 0), director = f.create()
  await director.jobHistory.loadMore()
  const unwatch = director.jobHistory.watch('')
  t.after(unwatch)
  await director.refreshVdRuns()
  const snapshot = director.getSnapshot()
  await director.refreshVdRuns()
  assert.equal(director.getSnapshot(), snapshot)
  const time = '2026-09-28T00:00:00Z'
  f.rows.push({ id: 'active', projectId: 'a', submitted: time, jobs: [], run: { id: 'active', projectId: 'a', status: 'running', startedAt: time } })
  await director.refreshVdRuns()
  f.setFail(true)
  const waiting = director.observeHostRuns(['active'])
  f.rows[0].run.status = 'completed'
  await director.refreshVdRuns()
  await waiting
  assert.equal(director.getSnapshot().jobHistory[''].error, 'Offline')
})

test('Host pages globally, groups child receipts, filters before limiting, and scopes observer payloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vd-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  const projects = await Promise.all(['A', 'B'].map(name => store.createProject({ name, sessionId: name })))
  const runs = []
  for (let i = 0; i < 25; i++) {
    const project = projects[i % 2], date = new Date(Date.UTC(2026, 8, 28, 0, 0, i)).toISOString()
    runs.push(await store.saveVdRun(project.id, { id: randomUUID(), projectId: project.id, status: i === 0 ? 'running' : 'completed', mode: 'all',
      batchSize: 1, totalJobs: 1, completedJobs: i === 0 ? 0 : 1, nodeIds: [], startedAt: date, completedAt: date,
      previewResult: { kind: 'text', text: 'synthetic', providerId: 'test' }, ...(i === 24 ? { hidden: true } : {}) }, project))
  }
  const rpc = createDirectorRpc({ store, jobs: {}, providers: {}, workflows: {}, registerAsset: async () => {} })
  const call = async (endpoint, input = {}) => {
    const result = await rpc(endpoint, input)
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }
  const first = await call('jobs/history')
  assert.equal(first.groups.length, 10)
  assert.deepEqual(first.groups.map(group => group.id), runs.slice(14, 24).reverse().map(run => run.id))
  const second = await call('jobs/history', { before: first.nextCursor })
  assert.deepEqual(second.groups.map(group => group.id), runs.slice(4, 14).reverse().map(run => run.id))
  const last = await call('jobs/history', { before: second.nextCursor })
  assert.equal(last.groups.length, 4)
  assert.equal(last.nextCursor, null)
  const filtered = await call('jobs/history', { projectId: projects[1].id })
  assert.equal(filtered.groups.length, 10)
  assert.ok(filtered.groups.every(group => group.projectId === projects[1].id))
  assert.deepEqual((await call('vd-runs/list', { observe: { ids: [runs[8].id] } })).runs.map(run => run.id).sort(), [runs[0].id, runs[8].id].sort())
  assert.equal((await call('vd-runs/list')).runs.length, 25, 'unscoped RPC remains compatible')
  for (const limit of [0, 11, 1.5, '10']) assert.equal((await rpc('jobs/history', { limit })).ok, false)
  assert.equal((await rpc('jobs/history', { before: { id: '../../etc' } })).ok, false)
  const controller = new DirectorController({ connection: { rpc: { call: (_, endpoint, input) => rpc(endpoint, input) } } })
  t.after(() => controller.dispose())
  await controller.jobHistory.loadMore()
  assert.equal(controller.getSnapshot().workflowRuns.length, 0)
  assert.deepEqual(await controller.getVdRunJobs(runs[23].id), [], 'actions resolve a paged run even before observation or canvas selection')
  await controller.deleteVdRun(runs[23].id)
  assert.ok(!controller.getSnapshot().jobHistory[''].groups.some(group => group.id === runs[23].id))
  const parent = { ...runs[0], id: 'parent', kind: 'batch' }, child = { ...runs[1], id: 'child', batchRunId: 'parent' }
  const grouped = groupJobHistory([parent, child, { ...runs[2], hidden: true }], [
    { id: 'receipt', projectId: child.projectId, workflowRunId: child.id, createdAt: child.startedAt },
    { id: 'hidden-receipt', projectId: runs[2].projectId, workflowRunId: runs[2].id },
    { id: 'legacy', projectId: parent.projectId, createdAt: parent.startedAt },
  ])
  assert.deepEqual(grouped.map(row => row.id), ['child', 'job:legacy'])
  assert.equal(grouped[0].jobs.length, 1)
})
