import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { groupJobHistory, pageJobHistory } from '../src/job-history.js'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
    import React, { act, useSyncExternalStore } from 'react'; import { createRoot } from 'react-dom/client';
    export { DirectorController } from './controller';
    import { JobDrawer } from './JobDrawer'; export { act }; export { jobDate, elapsedTime } from './JobDrawer'; export { artifactZip } from './job-artifacts'; export { setLanguage } from './i18n';
    import { groupJobHistory } from '../job-history.js';
    export function mountLive(director) {
      const root = createRoot(document.getElementById('root'));
      function Live() { const snapshot = useSyncExternalStore(director.subscribe, director.getSnapshot); return <JobDrawer snapshot={snapshot} director={director} onClose={() => {}} />; }
      root.render(<Live />); return root;
    }
    export function mount(snapshot, director) {
      const root = createRoot(document.getElementById('root'));
      const runtime = {watchJobHistory: (_, onError) => { void director.refreshVdRuns().catch(onError); return () => {}; }, ...director};
      root.renderSnapshot = next => {
        const groups = groupJobHistory(next.workflowRuns, next.jobs ?? next.project?.jobs ?? []);
        const jobHistory = Object.fromEntries(['', ...next.projects.map(p => p.id)].map(filter => [filter, {groups: groups.filter(g => !filter || g.projectId === filter), initialized: true, loading: false, nextCursor: null}]));
        root.render(<JobDrawer snapshot={{jobHistory, ...next}} director={runtime} onClose={() => {}} />);
      };
      root.renderSnapshot(snapshot);
      return root;
    }
  ` }, bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false,
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
})
const compiled = { exports: {} }
const require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(id => id.endsWith('.css') ? {} : require(id), compiled, compiled.exports)
const ui = compiled.exports

test('scrolling adds ten cards, retries failed pages, and reopens the drawer from controller memory', async t => {
  const runs = Array.from({ length: 24 }, (_, i) => ({ id: `r-${i}`, projectId: 'a', status: 'completed',
    startedAt: '2026-09-27T07:00:00Z', executionStartedAt: '2026-09-27T08:00:00Z', completedAt: '2026-09-27T08:01:02Z' }))
  const groups = groupJobHistory(runs, [])
  let fail = false, pageCalls = 0
  const director = new ui.DirectorController({ connection: { rpc: { call: async (_, endpoint, payload) => {
    if (endpoint === 'jobs/history') {
      pageCalls++
      if (fail && payload.before) throw new Error('Page unavailable')
      return { ok: true, value: pageJobHistory(groups, payload) }
    }
    return { ok: true, value: endpoint === 'vd-runs/list' ? { runs: runs.filter(run => payload.observe.ids.includes(run.id)) }
      : endpoint === 'jobs/list' ? { jobs: [] } : { projects: [{ id: 'a', name: 'Synthetic' }] } }
  } } } })
  let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mountLive(director) })
  t.after(() => { ui.act(() => root.unmount()); director.dispose() })
  const cards = () => document.querySelectorAll('.vd-job-card')
  assert.equal(cards().length, 10)
  assert.match(document.querySelector('.vd-job-card-time').textContent, /\(1 min 2 s\)$/)
  const list = document.querySelector('.vd-job-list')
  Object.defineProperties(list, { clientHeight: { value: 400 }, scrollHeight: { value: 1000 } })
  fail = true
  await ui.act(async () => { list.scrollTop = 600; list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
  assert.equal(cards().length, 10)
  assert.match(document.querySelector('.vd-job-pagination').textContent, /Page unavailable/)
  fail = false
  await ui.act(async () => document.querySelector('.vd-job-pagination button').click())
  assert.equal(cards().length, 20)
  const calls = pageCalls
  await ui.act(async () => { root.unmount(); root = ui.mountLive(director) })
  assert.equal(cards().length, 20)
  assert.ok(pageCalls - calls <= 1, 'reopening may check for new records but does not fetch old pages')
  await ui.act(async () => document.querySelector('.vd-job-pagination button').click())
  assert.equal(cards().length, 24)
  assert.equal(document.querySelector('.vd-job-pagination button'), null)
})

test('Jobs defaults to all workflows, filters remote runs, and keeps their action identities', async t => {
  const calls = []
  const projects = [{ id: 'a', name: 'Workflow A' }, { id: 'b', name: 'Workflow B' }]
  const jobs = projects.map(project => ({ id: `job-${project.id}`, projectId: project.id,
    nodeId: 'shared-node', workflowRunId: `run-${project.id}`, providerId: 'test', status: 'running',
    phase: 'rendering', progress: 0.5, createdAt: '2026-09-27T00:00:00Z' }))
  const snapshot = { projects, project: { ...projects[0], jobs: [jobs[0]], graph: { nodes: [] } }, jobs,
    workflowRuns: projects.map(project => ({ id: `run-${project.id}`, projectId: project.id, status: 'running',
      mode: 'all', batchSize: 1, completedJobs: 0, totalJobs: 1, startedAt: '2026-09-27T00:00:00Z' })),
  }
  const director = Object.fromEntries(['refreshVdRuns', 'openVdWorkflow', 'cancelVdRun']
    .map(method => [method, async (...args) => { calls.push([method, ...args]) }]))
  let root
  await ui.act(async () => { ui.setLanguage('en'); root = ui.mount(snapshot, director) })
  t.after(() => ui.act(() => root.unmount()))
  assert.equal(document.querySelectorAll('.vd-job-card').length, 2)
  assert.match(document.querySelector('.vd-job-list').textContent, /Workflow A/)
  assert.match(document.querySelector('.vd-job-list').textContent, /Workflow B/)
  assert.deepEqual(calls, [['refreshVdRuns']])
  const filter = document.querySelector('[aria-label="Filter by workflow"]')
  ui.act(() => { filter.value = 'b'; filter.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  assert.equal(document.querySelectorAll('.vd-job-card').length, 1)
  assert.doesNotMatch(document.querySelector('.vd-job-list').textContent, /Workflow A/)
  await ui.act(async () => document.querySelector('.vd-job-more').click())
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(button => button.textContent),
    ['Cancel Job', 'Download artifacts', 'Download Workflow', 'Open Workflow', 'Delete from Job List', 'Inspect Property'])
  const item = text => [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === text)
  assert.equal(item('Delete from Job List').disabled, true)
  assert.equal(item('Download artifacts').disabled, true)
  await ui.act(async () => item('Open Workflow').click())
  assert.equal(document.querySelector('[role="menu"]'), null)
  await ui.act(async () => document.querySelector('.vd-job-more').click())
  await ui.act(async () => item('Inspect Property').click())
  await ui.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel run').click())
  assert.deepEqual(calls.filter(call => call[0] !== 'refreshVdRuns'), [['openVdWorkflow', 'run-b'], ['cancelVdRun', 'run-b']])
  await ui.act(async () => document.querySelector('[aria-label="Close properties"]').click())
})

test('compact cards use virtual paths, status icons and state-specific timestamps; menus dismiss outside', async t => {
  const states = ['completed', 'running', 'failed', 'cancelled', 'orphaned', 'queued']
  const date = '2026-09-27T08:12:34'
  const snapshot = { projects: [{ id: 'a', name: 'A very long workflow name' }],
    projectFolders: { folders: [{ id: 'scenes', name: 'Scenes', parentId: null }, { id: 'drafts', name: 'Drafts', parentId: 'scenes' }], projectParents: { a: 'drafts' } },
    workflowRuns: [], jobs: states.map((status, i) => ({ id: 'job-' + i, projectId: 'a', nodeId: 'n', providerId: 'test',
      status, phase: status, progress: 0, createdAt: date, updatedAt: date, completedAt: date, startedAt: date })) }
  let root
  await ui.act(async () => { root = ui.mount(snapshot, { refreshVdRuns: async () => {} }) })
  t.after(() => ui.act(() => root.unmount()))
  assert.equal(document.querySelectorAll('.vd-job-card').length, 6)
  assert.equal(document.querySelector('.vd-job-card-content strong').title, '/Scenes/Drafts/A very long workflow name')
  assert.equal(document.querySelectorAll('.vd-run-status-icon.is-stopped').length, 3)
  for (const value of ['completed at 20260927-08:12:34', 'canceled at 20260927-08:12:34', 'queued at 20260927-08:12:34', 'running of ']) assert.ok(document.querySelector('.vd-job-list').textContent.includes(value))
  assert.match(document.querySelector('.vd-job-card.is-completed .vd-job-card-time').textContent, /completed at 20260927-08:12:34 \(0 min 0 s\)$/)
  assert.equal(document.querySelectorAll('.vd-job-summary, .vd-job-rows').length, 0)
  await ui.act(async () => document.querySelector('.vd-job-more').click())
  assert.ok(document.querySelector('[role="menu"]'))
  await ui.act(async () => document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
  assert.equal(document.querySelector('[role="menu"]'), null)
})

test('running duration refreshes every second and formats hours without resetting minutes', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-27T08:00:59Z').getTime() })
  const snapshot = { projects: [{ id: 'a', name: 'Workflow' }], jobs: [], workflowRuns: [{ id: 'r', projectId: 'a', status: 'running', startedAt: '2026-09-27T07:00:00Z', executionStartedAt: '2026-09-27T08:00:00Z' }] }
  let root
  await ui.act(async () => { root = ui.mount(snapshot, { refreshVdRuns: async () => {} }) })
  t.after(() => ui.act(() => root.unmount()))
  assert.match(document.querySelector('.vd-job-card-time').textContent, /running of 0 min 59 s/)
  await ui.act(async () => { t.mock.timers.tick(1000) })
  assert.match(document.querySelector('.vd-job-card-time').textContent, /running of 1 min 0 s/)
  assert.equal(ui.elapsedTime('2026-09-27T08:00:00Z', Date.parse('2026-09-27T09:02:03Z')), '1 h 2 min 3 s')
  assert.equal(ui.jobDate('2026-09-27T08:12:34'), '20260927-08:12:34')
})

test('deleting a run hides its child jobs without removing other runs', async t => {
  const snapshot = { projects: [{ id: 'a', name: 'Workflow' }], workflowRuns: [
    { id: 'hidden', projectId: 'a', status: 'completed', startedAt: '2026-09-27T08:00:00Z', hidden: true },
    { id: 'visible', projectId: 'a', status: 'queued', startedAt: '2026-09-27T09:00:00Z' }],
    jobs: [{ id: 'j', workflowRunId: 'hidden', projectId: 'a', createdAt: '2026-09-27T08:00:00Z', status: 'completed' }] }
  let root
  await ui.act(async () => { root = ui.mount(snapshot, { refreshVdRuns: async () => {} }) })
  t.after(() => ui.act(() => root.unmount()))
  assert.equal(document.querySelectorAll('.vd-job-card').length, 1)
  assert.ok(document.querySelector('.vd-job-card.is-queued'))
})

test('artifact ZIP preserves original provider names and duplicate names in separate paths', async () => {
  const bytes = new Uint8Array(await ui.artifactZip([{ name: '01/provider音频.flac', bytes: new Uint8Array([1,2,3]) },
    { name: '02/provider音频.flac', bytes: new Uint8Array([4,5]) }]).arrayBuffer())
  const view = new DataView(bytes.buffer)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint16(6, true), 0x800)
  assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + view.getUint16(26, true))), '01/provider音频.flac')
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50)
  assert.equal(view.getUint16(bytes.length - 12, true), 2)
})

test('Cancel Job targets an offscreen workflow or legacy job and disables terminal/pending cancellation', async t => {
  const calls = []
  const snapshot = { projects: [{ id: 'p', name: 'Synthetic' }], jobs: [], workflowRuns: [
    { id: 'r', projectId: 'p', status: 'running', startedAt: '2026-09-27T08:00:00Z' },
  ] }
  let root
  await ui.act(async () => { root = ui.mount(snapshot, { refreshVdRuns: async () => {},
    cancelVdRun: async id => calls.push(['run', id]), cancelJob: async id => calls.push(['job', id]) }) })
  t.after(() => ui.act(() => root.unmount()))
  const open = () => ui.act(async () => document.querySelector('.vd-job-more').click())
  const action = () => document.querySelector('[role="menuitem"]')
  await open()
  assert.equal(action().textContent, 'Cancel Job')
  assert.equal(action().disabled, false)
  await ui.act(async () => action().click())
  assert.deepEqual(calls, [['run', 'r']])
  for (const run of [{ ...snapshot.workflowRuns[0], cancelRequested: true }, { ...snapshot.workflowRuns[0], status: 'completed' }]) {
    await ui.act(async () => root.renderSnapshot({ ...snapshot, workflowRuns: [run] }))
    await open()
    assert.equal(action().disabled, true)
    await ui.act(async () => document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
  }
  await ui.act(async () => root.renderSnapshot({ ...snapshot, workflowRuns: [], jobs: [{ id: 'legacy', projectId: 'p', createdAt: '2026-09-27T08:00:00Z', status: 'queued' }] }))
  await open()
  await ui.act(async () => action().click())
  assert.deepEqual(calls.at(-1), ['job', 'legacy'])
})

test('inspector elapsed time follows Submitted, excludes queue wait, ticks live and stops at completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-09-27T08:00:59Z') })
  const run = { id: 'r', projectId: 'p', status: 'running', startedAt: '2026-09-27T07:00:00Z',
    queuedAt: '2026-09-27T07:00:00Z', executionStartedAt: '2026-09-27T08:00:00Z' }
  const snapshot = { projects: [{ id: 'p', name: 'Synthetic' }], jobs: [], workflowRuns: [run] }
  let root
  await ui.act(async () => { root = ui.mount(snapshot, { refreshVdRuns: async () => {} }) })
  t.after(() => ui.act(() => root.unmount()))
  await ui.act(async () => document.querySelector('.vd-job-more').click())
  await ui.act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === 'Inspect Property').click())
  const elapsed = () => [...document.querySelectorAll('dt')].find(el => el.textContent === 'Elapsed Time')
  assert.equal(elapsed().previousElementSibling.previousElementSibling.textContent, 'Submitted')
  assert.equal(elapsed().nextElementSibling.textContent, '0 min 59 s')
  await ui.act(async () => t.mock.timers.tick(1000))
  assert.equal(elapsed().nextElementSibling.textContent, '1 min 0 s')
  await ui.act(async () => root.renderSnapshot({ ...snapshot, workflowRuns: [{ ...run, status: 'completed', completedAt: '2026-09-27T08:01:12Z' }] }))
  await ui.act(async () => t.mock.timers.tick(10000))
  assert.equal(elapsed().nextElementSibling.textContent, '1 min 12 s')
  await ui.act(async () => root.renderSnapshot({ ...snapshot, workflowRuns: [{ ...run, status: 'cancelled', executionStartedAt: undefined, completedAt: '2026-09-27T07:01:00Z' }] }))
  assert.equal(elapsed().nextElementSibling.textContent, '0 min 0 s')
})
