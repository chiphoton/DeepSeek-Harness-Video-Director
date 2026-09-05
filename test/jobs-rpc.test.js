import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { JobManager } from '../src/jobs.js'
import { VdNodeRegistry } from '../src/node-registry.js'
import { ProjectStore } from '../src/project-store.js'
import { ProviderRuntime } from '../src/providers.js'
import { createDirectorRpc } from '../src/rpc.js'
import { ComfyWorkflowStore } from '../src/workflow-store.js'

async function createStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-director-jobs-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  return store
}

function persistedJob(id, projectId, status, createdAt) {
  return {
    id,
    projectId,
    nodeId: `node-${id.slice(-1)}`,
    operation: 'video-generation',
    providerId: 'comfyui',
    status,
    phase: status,
    progress: status === 'completed' ? 1 : 0.4,
    createdAt,
    updatedAt: createdAt,
  }
}

async function projectWithNode(store, name, sessionId, nodeId) {
  const project = await store.createProject({ name, sessionId })
  return store.updateProject(project.id, {
    graph: {
      ...project.graph,
      nodes: [{ id: nodeId }],
    },
  })
}

async function waitForPersistedStatus(store, projectId, jobId, status) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const project = await store.getProject(projectId)
    const job = project.jobs.find(candidate => candidate.id === jobId)
    if (job?.status === status) return job
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`job ${jobId} was not persisted as ${status}`)
}

test('submitted vd-run snapshots persist independently of canvas saves and cannot be replaced', async t => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Submitted workflow', 'submitted-session', 'original-node')
  const rpc = createDirectorRpc({ store, providers: {}, jobs: {}, workflows: {}, registerAsset: async () => {} })
  const run = { id: '00000000-0000-4000-8000-000000000121', projectId: project.id,
    status: 'queued', mode: 'all', batchSize: 1, completedJobs: 0, totalJobs: 1,
    nodeIds: ['original-node'], startedAt: project.createdAt }
  const snapshot = { name: project.name, graph: project.graph, settings: project.settings }
  let result = await rpc('vd-runs/save', { projectId: project.id, run, snapshot })
  assert.equal(result.ok, true)
  assert.equal('snapshot' in result.value.run, false)
  await assert.rejects(store.deleteProject(project.id), error => {
    assert.equal(error.code, 'video-director/project-busy')
    assert.deepEqual(error.details.activeRunIds, [run.id])
    return true
  })
  await store.updateProject(project.id, { graph: { ...project.graph, nodes: [] } })
  snapshot.graph.nodes = [{ id: 'changed' }]
  result = await rpc('vd-runs/save', { projectId: project.id, run: { ...run, status: 'completed', completedJobs: 1 }, snapshot })
  assert.equal(result.ok, true)
  const reopened = new ProjectStore(store.root, 1024 * 1024)
  await reopened.init()
  const saved = await reopened.getVdRun(project.id, run.id)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.snapshot.graph.nodes[0].id, 'original-node')
  assert.deepEqual((await reopened.getProject(project.id)).graph.nodes, [])
  result = await rpc('vd-runs/list', { projectId: project.id })
  assert.equal(result.value.runs.length, 1)
  assert.equal('snapshot' in result.value.runs[0], false)
  result = await rpc('vd-runs/get', { projectId: project.id, runId: '../../escape' })
  assert.equal(result.ok, false)
  const foreign = await store.createProject({ name: 'Other', sessionId: 'other-session' })
  result = await rpc('vd-runs/get', { projectId: foreign.id, runId: run.id })
  assert.equal(result.ok, false)
})

test('a provider outage persists a reconnecting job and completes it with the original prompt ID', async t => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'SSH recovery', 'ssh-recovery', 'render')
  let submissions = 0
  let historyChecks = 0
  let release
  const recovered = new Promise(resolve => { release = resolve })
  let waiting
  const offline = new Promise(resolve => { waiting = resolve })
  const providers = new ProviderRuntime({
    store,
    providers: [{ id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'localhost:8188' }],
    waitImpl: async () => { waiting(); await recovered },
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path === '/prompt') { submissions += 1; return Response.json({ prompt_id: 'retained-prompt' }) }
      if (path === '/history/retained-prompt') {
        historyChecks += 1
        if (historyChecks === 1) throw new TypeError('fetch failed')
        return Response.json({ 'retained-prompt': { outputs: { save: { images: [{ filename: 'recovered.png' }] } } } })
      }
      if (path === '/view') return new Response('recovered image', { headers: { 'Content-Type': 'image/png' } })
      throw new Error(`unexpected path ${path}`)
    },
  })
  const manager = new JobManager(store, providers)
  const job = await manager.start({ projectId: project.id, nodeId: 'render', operation: 'image-generation',
    providerId: 'comfyui', workflow: {}, bindings: [], expectedOutputTypes: ['image'] })
  await offline
  try {
    const persisted = (await store.getProject(project.id)).jobs.find(row => row.id === job.id)
    assert.equal(persisted.status, 'running')
    assert.equal(persisted.phase, 'reconnecting')
    assert.equal(persisted.promptId, 'retained-prompt')
  } finally { release() }
  const completed = await waitForPersistedStatus(store, project.id, job.id, 'completed')
  assert.equal(completed.result.promptId, 'retained-prompt')
  assert.equal(completed.result.assets.length, 1)
  assert.equal(submissions, 1)
})

test('JobManager recovery never resubmits ambiguous in-flight work', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Recovery', sessionId: 'session-recovery' })
  const createdAt = new Date().toISOString()
  const queuedId = '00000000-0000-4000-8000-000000000011'
  const runningId = '00000000-0000-4000-8000-000000000012'
  const completedId = '00000000-0000-4000-8000-000000000013'
  await store.updateProject(project.id, {
    jobs: [
      persistedJob(queuedId, project.id, 'queued', createdAt),
      persistedJob(runningId, project.id, 'running', createdAt),
      persistedJob(completedId, project.id, 'completed', createdAt),
    ],
    status: 'running',
  })

  let providerRuns = 0
  const manager = new JobManager(store, {
    async run() { providerRuns += 1; throw new Error('recovery must not run providers') },
  })
  await manager.recover()

  assert.equal(providerRuns, 0)
  assert.equal((await manager.get(project.id, queuedId)).status, 'orphaned')
  assert.equal((await manager.get(project.id, runningId)).status, 'orphaned')
  assert.equal((await manager.get(project.id, completedId)).status, 'completed')
  assert.match((await manager.get(project.id, runningId)).error, /not submitted again/i)

  const recovered = await store.getProject(project.id)
  assert.equal(recovered.status, 'error')
  assert.deepEqual(recovered.jobs.map(job => job.status), ['orphaned', 'orphaned', 'completed'])
})

test('JobManager deletes terminal job records without deleting active work', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Delete jobs', sessionId: 'session-delete-jobs' })
  const createdAt = new Date().toISOString()
  const completedId = '00000000-0000-4000-8000-000000000014'
  const runningId = '00000000-0000-4000-8000-000000000015'
  await store.updateProject(project.id, {
    jobs: [
      persistedJob(completedId, project.id, 'completed', createdAt),
      persistedJob(runningId, project.id, 'running', createdAt),
    ],
    status: 'running',
  })
  const manager = new JobManager(store, { async run() { throw new Error('not reached') } })

  const deleted = await manager.delete(project.id, completedId)
  assert.equal(deleted.id, completedId)
  assert.deepEqual((await store.getProject(project.id)).jobs.map(job => job.id), [runningId])
  await assert.rejects(manager.get(project.id, completedId), { code: 'video-director/job-not-found' })
  await assert.rejects(manager.delete(project.id, runningId), { code: 'video-director/job-active' })
})

test('JobManager rejects assets owned by another Video Project', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Owner', 'session-owner', 'owner-node')
  const foreignProject = await store.createProject({ name: 'Foreign', sessionId: 'session-foreign' })
  const foreignAsset = await store.putAsset({
    projectId: foreignProject.id,
    kind: 'image',
    name: 'foreign.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('foreign-project-image').toString('base64'),
  })
  let providerRuns = 0
  const manager = new JobManager(store, {
    async run() {
      providerRuns += 1
      return { kind: 'text', text: 'must not run', providerId: 'test' }
    },
  })

  await assert.rejects(manager.start({
    projectId: project.id,
    nodeId: 'owner-node',
    operation: 'image-generation',
    providerId: 'test',
    assetIds: [foreignAsset.id],
    mediaInputs: [{ assetId: foreignAsset.id }],
  }), (error) => {
    assert.equal(error.code, 'video-director/invalid-input')
    assert.match(error.message, /does not belong to project/i)
    return true
  })

  assert.equal(providerRuns, 0)
  assert.deepEqual((await store.getProject(project.id)).jobs, [])
})

test('JobManager persists provider identity progress before the job becomes terminal', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Progress', 'session-progress', 'progress-node')
  let releaseProvider
  const providerRelease = new Promise(resolve => { releaseProvider = resolve })
  let identityReported
  const identityReport = new Promise(resolve => { identityReported = resolve })
  const manager = new JobManager(store, {
    async run(_request, _signal, progress) {
      await progress({
        phase: 'generating',
        progress: 0.42,
        promptId: 'comfy-prompt-progress',
        seed: 8675309,
        compiledWorkflowHash: '7'.repeat(64),
      })
      identityReported()
      await providerRelease
      return { kind: 'text', text: 'finished', providerId: 'test' }
    },
  })

  const job = await manager.start({
    projectId: project.id,
    nodeId: 'progress-node',
    operation: 'video-generation',
    providerId: 'test',
    workflow: { output: { class_type: 'SaveVideo', inputs: {} } },
    assetIds: [],
    mediaInputs: [],
  })

  let runningProject
  try {
    await identityReport
    runningProject = await store.getProject(project.id)
  } finally {
    releaseProvider()
  }
  const completed = await waitForPersistedStatus(store, project.id, job.id, 'completed')
  const persisted = runningProject.jobs.find(candidate => candidate.id === job.id)

  assert.deepEqual({
    projectStatus: runningProject.status,
    status: persisted?.status,
    phase: persisted?.phase,
    progress: persisted?.progress,
    promptId: persisted?.promptId,
    seed: persisted?.seed,
    compiledWorkflowHash: persisted?.compiledWorkflowHash,
    terminalAt: persisted?.completedAt,
  }, {
    projectStatus: 'running',
    status: 'running',
    phase: 'generating',
    progress: 0.42,
    promptId: 'comfy-prompt-progress',
    seed: 8675309,
    compiledWorkflowHash: '7'.repeat(64),
    terminalAt: undefined,
  })
  assert.deepEqual({
    promptId: completed.promptId,
    seed: completed.seed,
    compiledWorkflowHash: completed.compiledWorkflowHash,
  }, {
    promptId: 'comfy-prompt-progress',
    seed: 8675309,
    compiledWorkflowHash: '7'.repeat(64),
  })
})

test('cancelling the only queued job returns its Video Project to ready', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Cancel', 'session-cancel', 'cancel-node')
  const manager = new JobManager(store, {
    async run() { throw new Error('a zero-concurrency test queue must not run') },
  }, { concurrency: 0 })

  const job = await manager.start({
    projectId: project.id,
    nodeId: 'cancel-node',
    operation: 'video-generation',
    providerId: 'test',
    assetIds: [],
    mediaInputs: [],
  })
  assert.equal((await store.getProject(project.id)).status, 'running')

  const cancelled = await manager.cancel(project.id, job.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.getProject(project.id)).status, 'ready')
})

test('JobManager accepts image-edit as an exact operation', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Image edit', 'session-image-edit', 'image-edit-node')
  const manager = new JobManager(store, {
    async run() { throw new Error('a zero-concurrency test queue must not run') },
  }, { concurrency: 0 })

  const job = await manager.start({
    projectId: project.id,
    nodeId: 'image-edit-node',
    operation: 'image-edit',
    providerId: 'comfyui',
    mediaInputs: [],
  })

  assert.equal(job.operation, 'image-edit')
  assert.equal(job.status, 'queued')
})

test('JobManager rejects provider results outside the selected node output contract', async (t) => {
  const store = await createStore(t)
  const audioProject = await projectWithNode(store, 'Audio mismatch', 'session-audio-mismatch', 'audio-node')
  const audio = await store.putAsset({
    projectId: audioProject.id,
    kind: 'audio',
    name: 'unexpected.wav',
    mimeType: 'audio/wav',
    dataBase64: Buffer.from('unexpected-audio').toString('base64'),
  })
  const cases = [
    {
      project: await projectWithNode(store, 'Text mismatch', 'session-text-mismatch', 'text-node'),
      nodeId: 'text-node',
      result: { kind: 'text', text: 'not an image', providerId: 'test' },
      actual: ['text'],
    },
    {
      project: audioProject,
      nodeId: 'audio-node',
      result: { kind: 'assets', assets: [audio], providerId: 'test' },
      actual: ['audio'],
    },
    {
      project: await projectWithNode(store, 'MCP mismatch', 'session-mcp-mismatch', 'mcp-node'),
      nodeId: 'mcp-node',
      result: { kind: 'mcp-result', result: { promptId: 'remote-only' }, providerId: 'test' },
      actual: ['text'],
    },
  ]

  for (const entry of cases) {
    const manager = new JobManager(store, { async run() { return entry.result } })
    const queued = await manager.start({
      projectId: entry.project.id,
      nodeId: entry.nodeId,
      operation: 'image-generation',
      providerId: 'test',
      expectedOutputTypes: ['image'],
      assetIds: [],
      mediaInputs: [],
    })
    const failed = await waitForPersistedStatus(store, entry.project.id, queued.id, 'failed')
    assert.equal(failed.errorCode, 'video-director/output-type-unsupported')
    assert.match(failed.error, /provider output type/i)
    assert.deepEqual((await manager.get(entry.project.id, queued.id)).result, undefined)
  }

  const acceptedManager = new JobManager(store, {
    async run() {
      return {
        kind: 'assets',
        assets: [{ id: audio.id, kind: 'image', projectId: 'forged-project', url: 'https://invalid.example/forged' }],
        providerId: 'test',
      }
    },
  })
  const accepted = await acceptedManager.start({
    projectId: audioProject.id,
    nodeId: 'audio-node',
    operation: 'audio-generation',
    providerId: 'test',
    expectedOutputTypes: ['audio'],
    assetIds: [],
    mediaInputs: [],
  })
  const completed = await waitForPersistedStatus(store, audioProject.id, accepted.id, 'completed')
  assert.deepEqual(completed.result.assets, [audio])
})

test('concurrent job persistence preserves every job through revision retries', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Concurrent jobs', 'session-concurrent-jobs', 'shared-node')
  const manager = new JobManager(store, {
    async run() { throw new Error('a zero-concurrency test queue must not run') },
  }, { concurrency: 0 })
  const request = {
    projectId: project.id,
    nodeId: 'shared-node',
    operation: 'video-generation',
    providerId: 'test',
    assetIds: [],
    mediaInputs: [],
  }

  const jobs = await Promise.all([manager.start(request), manager.start(request)])
  const persisted = await store.getProject(project.id)

  assert.equal(persisted.status, 'running')
  assert.deepEqual(persisted.jobs.map(job => job.id).sort(), jobs.map(job => job.id).sort())
  assert.deepEqual(
    persisted.jobs.map(job => job.runSequence),
    [...persisted.jobs.map(job => job.runSequence)].sort((left, right) => left - right),
  )
})

test('out-of-order completion preserves creation order so reload selects the newest run', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Completion order', 'session-completion-order', 'shared-node')
  const pending = new Map()
  const manager = new JobManager(store, {
    async run(request) {
      return new Promise((resolve, reject) => { pending.set(request.prompt, { resolve, reject }) })
    },
  }, { concurrency: 2 })
  const request = prompt => ({
    projectId: project.id,
    nodeId: 'shared-node',
    operation: 'text-generation',
    providerId: 'test',
    prompt,
    assetIds: [],
    mediaInputs: [],
  })

  const older = await manager.start(request('older'))
  const newer = await manager.start(request('newer'))
  for (let attempt = 0; attempt < 100 && pending.size < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(pending.size, 2)

  pending.get('newer').resolve({ kind: 'text', text: 'newest result', providerId: 'test' })
  await waitForPersistedStatus(store, project.id, newer.id, 'completed')
  pending.get('older').reject(new Error('stale run failed late'))
  await waitForPersistedStatus(store, project.id, older.id, 'failed')

  const reloaded = await store.getProject(project.id)
  assert.deepEqual(reloaded.jobs.map(job => job.id), [older.id, newer.id])
  assert.equal(older.runSequence < newer.runSequence, true)
  const latestJobIds = new Map()
  for (const job of reloaded.jobs) latestJobIds.set(job.nodeId, job.id)
  assert.equal(latestJobIds.get('shared-node'), newer.id)
  assert.equal(reloaded.jobs.at(-1).result.text, 'newest result')
  assert.equal(reloaded.status, 'ready')
})

test('terminal jobs release execution objects and bounded cache misses read durable history', async (t) => {
  const store = await createStore(t)
  const project = await projectWithNode(store, 'Terminal cache', 'session-terminal-cache', 'cache-node')
  const manager = new JobManager(store, {
    async run(request) {
      return { kind: 'text', text: request.prompt, providerId: 'test' }
    },
  }, { terminalCacheLimit: 1 })
  const start = prompt => manager.start({
    projectId: project.id,
    nodeId: 'cache-node',
    operation: 'text-generation',
    providerId: 'test',
    prompt,
    workflow: { large: 'x'.repeat(64 * 1024) },
    assetIds: [],
    mediaInputs: [],
  })
  const waitForCompaction = async (jobId) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const cached = manager.jobs.get(jobId)
      if (cached === undefined || (!Object.hasOwn(cached, 'request') && !Object.hasOwn(cached, 'controller'))) return
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error(`job ${jobId} retained terminal execution objects`)
  }

  const first = await start('first result')
  await waitForPersistedStatus(store, project.id, first.id, 'completed')
  await waitForCompaction(first.id)
  assert.equal(Object.hasOwn(manager.jobs.get(first.id), 'request'), false)
  assert.equal(Object.hasOwn(manager.jobs.get(first.id), 'controller'), false)

  const second = await start('second result')
  await waitForPersistedStatus(store, project.id, second.id, 'completed')
  await waitForCompaction(second.id)
  assert.equal(manager.jobs.has(first.id), false)
  assert.equal(manager.jobs.has(second.id), true)

  const firstFromHistory = await manager.get(project.id, first.id)
  assert.equal(firstFromHistory.result.text, 'first result')
  assert.equal(manager.jobs.has(second.id), false)
  const secondFromHistory = await manager.get(project.id, second.id)
  assert.equal(secondFromHistory.result.text, 'second result')
  const cancelledTerminal = await manager.cancel(project.id, first.id)
  assert.equal(cancelledTerminal.status, 'completed')

  const history = (await store.getProject(project.id)).jobs
  assert.deepEqual(history.map(job => job.id), [first.id, second.id])
  assert.equal(history.some(job => Object.hasOwn(job, 'request') || Object.hasOwn(job, 'controller')), false)
})

test('JobManager snapshots requests before awaiting and gates transient nodes behind an internal option', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Immutable run', sessionId: 'session-immutable-run' })
  const graphBefore = structuredClone(project.graph)
  let providerRequest
  const manager = new JobManager(store, {
    async run(request) {
      providerRequest = request
      return { kind: 'text', text: 'snapshot complete', providerId: 'test' }
    },
  })
  const request = {
    projectId: project.id,
    nodeId: 'unsaved-node',
    operation: 'text-generation',
    providerId: 'test',
    prompt: 'latest unsaved prompt',
    workflowValues: { tone: 'quiet' },
    clientRunId: 'client-run-immutable',
    sourceRevision: project.revision,
    nodeDigest: 'a'.repeat(64),
    assetIds: [],
    mediaInputs: [],
  }

  await assert.rejects(manager.start(request), /not part of project/i)

  const started = manager.start(request, { allowTransientNode: true })
  request.prompt = 'mutated after dispatch'
  request.workflowValues.tone = 'loud'
  const queued = await started
  const completed = await waitForPersistedStatus(store, project.id, queued.id, 'completed')

  assert.equal(providerRequest.prompt, 'latest unsaved prompt')
  assert.deepEqual(providerRequest.workflowValues, { tone: 'quiet' })
  assert.deepEqual({
    clientRunId: completed.clientRunId,
    sourceRevision: completed.sourceRevision,
    nodeDigest: completed.nodeDigest,
  }, {
    clientRunId: 'client-run-immutable',
    sourceRevision: project.revision,
    nodeDigest: 'a'.repeat(64),
  })
  const persistedProject = await store.getProject(project.id)
  assert.equal(JSON.stringify(persistedProject.graph), JSON.stringify(graphBefore))
})

test('Director RPC validates payload records and UUIDs and returns stable failures', async (t) => {
  const store = await createStore(t)
  const calls = { get: 0, cancel: 0, delete: 0 }
  const rpc = createDirectorRpc({
    store,
    providers: {
      publicCatalog: () => [],
      check: async () => ({ ok: true, latencyMs: 1 }),
    },
    jobs: {
      start: async () => { throw new Error('not reached') },
      get: () => { calls.get += 1; return {} },
      cancel: async () => { calls.cancel += 1; return {} },
      delete: async () => { calls.delete += 1; return {} },
    },
    registerAsset: async () => {},
    workflows: {
      list: () => [],
      import: async () => ({}),
      remove: async () => {},
      resolve: () => { throw new Error('not reached') },
    },
    providerSettings: { updateProvider: async () => {} },
  })

  assert.deepEqual(await rpc('health', {}), {
    ok: true,
    value: { version: 3, providers: 0, workflows: 0, nodes: 0 },
  })

  for (const [endpoint, payload] of [
    ['projects/get', []],
    ['projects/get', { projectId: '../project.json' }],
    ['projects/delete', { projectId: '../project.json' }],
    ['jobs/get', { projectId: 'not-a-uuid', jobId: 'also-not-a-uuid' }],
    ['jobs/cancel', { projectId: 'not-a-uuid', jobId: 'also-not-a-uuid' }],
    ['jobs/delete', { projectId: 'not-a-uuid', jobId: 'also-not-a-uuid' }],
  ]) {
    const result = await rpc(endpoint, payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'video-director/invalid-input')
    assert.equal(typeof result.error.message, 'string')
    assert.deepEqual(result.error.details, {})
  }
  assert.deepEqual(calls, { get: 0, cancel: 0, delete: 0 })

  const doomed = await store.createProject({ name: 'RPC delete', sessionId: 'session-rpc-delete' })
  const survivor = await store.createProject({ name: 'RPC survivor', sessionId: 'session-rpc-survivor' })
  const deleted = await rpc('projects/delete', { projectId: doomed.id })
  assert.equal(deleted.ok, true)
  assert.deepEqual(deleted.value.projects.map(project => project.id), [survivor.id])
  await assert.rejects(store.getProject(doomed.id), { code: 'video-director/project-not-found' })

  const unknown = await rpc('projects/drop', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'video-director/not-found')
  assert.match(unknown.error.message, /unknown Video Director endpoint/)
})

test('Director RPC refuses to persist dangling workflow references', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Workflow reference', sessionId: 'session-workflow-reference' })
  const missingWorkflowId = '00000000-0000-4000-8000-000000000091'
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: {},
    registerAsset: async () => {},
    workflows: {
      list: () => [],
      get(workflowId) {
        const error = new Error(`workflow ${workflowId} was not found`)
        error.code = 'video-director/workflow-not-found'
        throw error
      },
    },
    providerSettings: { updateProvider: async () => {} },
  })
  const candidate = {
    ...project,
    graph: {
      ...project.graph,
      nodes: [{
        id: 'workflow-node',
        type: 'director',
        position: { x: 0, y: 0 },
        data: { kind: 'image-generation', title: 'Missing workflow', workflowId: missingWorkflowId },
      }],
    },
  }

  const result = await rpc('projects/save', {
    projectId: project.id,
    expectedRevision: project.revision,
    project: candidate,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/workflow-not-found')
  assert.equal((await store.getProject(project.id)).revision, project.revision)
  assert.equal((await store.getProject(project.id)).graph.nodes.length, 0)
})

test('Director RPC force-saves a stale local project without a second revision race', async (t) => {
  const store = await createStore(t)
  const created = await store.createProject({ name: 'Original cut', sessionId: 'session-force-save' })
  const remote = await store.updateProject(created.id, { name: 'Remote cut', settings: { remote: true } })
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: {},
    registerAsset: async () => {},
    workflows: { list: () => [], get: () => ({}) },
    providerSettings: { updateProvider: async () => {} },
  })

  const result = await rpc('projects/save', {
    projectId: created.id,
    expectedRevision: created.revision,
    force: true,
    project: { ...created, name: 'Local cut', settings: { local: true } },
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.project.revision, remote.revision + 1)
  assert.equal(result.value.project.name, 'Local cut')
  assert.deepEqual(result.value.project.settings, { local: true })
})

test('Director RPC resolves registry workflows before queueing and keeps registry model policy authoritative', async (t) => {
  const store = await createStore(t)
  let queued
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: {
      async start(request) {
        queued = request
        return { id: 'job-1' }
      },
    },
    registerAsset: async () => {},
    workflows: {
      list: () => [],
      resolve: () => ({
        workflow: { load: { class_type: 'LoadImage', inputs: { image: '' } } },
        bindings: [{ nodeId: 'load', input: 'image', from: 'asset' }],
        modelFamily: 'minimax-h3',
        workflowId: 'workflow-1',
        workflowName: 'Registry workflow',
        workflowKind: 'video-generation',
      }),
    },
    providerSettings: { updateProvider: async () => {} },
  })

  const result = await rpc('jobs/start', {
    operation: 'video-generation',
    workflowId: 'workflow-1',
    workflowValues: {},
    modelFamily: 'attempted-client-override',
    mediaInputs: [{ assetId: 'asset-1' }],
  })

  assert.equal(result.ok, true)
  assert.equal(queued.modelFamily, 'minimax-h3')
  assert.equal(queued.bindings[0].assetId, 'asset-1')
  assert.equal(queued.workflow.load.class_type, 'LoadImage')
})

test('Director RPC exposes ComfyUI choices only for registered workflow parameters and intersects every target policy', async () => {
  const rawCatalog = {
    models: ['a.safetensors', 'b.safetensors', 'hidden.safetensors', 'shared.safetensors'],
    modelInputs: [
      { nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name', models: ['a.safetensors', 'b.safetensors'] },
      { nodeClass: 'UNETLoader', input: 'unet_name', models: ['shared.safetensors', 'unet-only.safetensors'] },
      { nodeClass: 'MirrorUNETLoader', input: 'unet_name', models: ['shared.safetensors', 'mirror-only.safetensors'] },
      { nodeClass: 'EmptyModelLoader', input: 'model_name', models: [] },
      { nodeClass: 'LeftModelLoader', input: 'model_name', models: ['left-only.safetensors'] },
      { nodeClass: 'RightModelLoader', input: 'model_name', models: ['right-only.safetensors'] },
      { nodeClass: 'HiddenLoader', input: 'model_name', models: ['hidden.safetensors'] },
    ],
  }
  const rpc = createDirectorRpc({
    store: {}, jobs: {}, registerAsset: async () => {}, providerSettings: {},
    providers: {
      publicCatalog: () => [],
      models: async () => rawCatalog,
      check: async () => ({ ok: true, latencyMs: 3, ...rawCatalog }),
    },
    workflows: {
      list: () => [],
      modelParameters: () => [
        {
          workflowId: 'workflow-image', parameterId: 'loader:ckpt_name',
          choices: ['a.safetensors', 'not-installed.safetensors'],
          targets: [{ nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' }],
        },
        {
          workflowId: 'workflow-custom', parameterId: 'shared-model',
          targets: [
            { nodeClass: 'UNETLoader', input: 'unet_name' },
            { nodeClass: 'MirrorUNETLoader', input: 'unet_name' },
          ],
        },
        {
          workflowId: 'workflow-empty', parameterId: 'empty-model',
          targets: [{ nodeClass: 'EmptyModelLoader', input: 'model_name' }],
        },
        {
          workflowId: 'workflow-disjoint', parameterId: 'disjoint-model',
          targets: [
            { nodeClass: 'LeftModelLoader', input: 'model_name' },
            { nodeClass: 'RightModelLoader', input: 'model_name' },
          ],
        },
        {
          workflowId: 'workflow-policy-empty', parameterId: 'policy-model',
          choices: ['not-installed.safetensors'],
          targets: [{ nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' }],
        },
        {
          workflowId: 'workflow-schema-missing', parameterId: 'missing-model',
          targets: [{ nodeClass: 'NotInstalledLoader', input: 'model_name' }],
        },
      ],
    },
  })

  const discovered = await rpc('providers/models', { providerId: 'comfyui' })
  assert.equal(discovered.ok, true)
  assert.deepEqual(discovered.value, {
    models: ['a.safetensors', 'shared.safetensors'],
    workflowModels: [
      { workflowId: 'workflow-image', parameterId: 'loader:ckpt_name', models: ['a.safetensors'] },
      { workflowId: 'workflow-custom', parameterId: 'shared-model', models: ['shared.safetensors'] },
      { workflowId: 'workflow-empty', parameterId: 'empty-model', models: [] },
      { workflowId: 'workflow-disjoint', parameterId: 'disjoint-model', models: [] },
      { workflowId: 'workflow-policy-empty', parameterId: 'policy-model', models: [] },
    ],
  })
  assert.equal('modelInputs' in discovered.value, false)
  assert.equal(discovered.value.models.includes('hidden.safetensors'), false)
})

test('Director RPC validates and resolves typed media ports before queueing', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Typed ports', sessionId: 'session-typed-ports' })
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const pack = {
    protocol: 'video-director.node/v1',
    type: 'example.typed-image-edit',
    version: '1.0.0',
    manifest: {
      title: 'Typed image edit',
      category: 'image',
      inputs: [
        { id: 'image', label: 'Image', types: ['image'], required: true },
        { id: 'references', label: 'References', types: ['audio'], required: true, multiple: true },
      ],
      outputs: [{ id: 'image', label: 'Image', types: ['image'] }],
      fields: [],
    },
    implementation: {
      kind: 'comfyui.workflow',
      operation: 'image-edit',
      workflow: {
        image: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        audio: { class_type: 'LoadAudio', inputs: { audio: 'input.wav' } },
        save: { class_type: 'SaveImage', inputs: { images: ['image', 0] } },
      },
      bindings: [
        { target: { nodeId: 'image', input: 'image' }, source: { kind: 'port', portId: 'image' } },
        { target: { nodeId: 'audio', input: 'audio' }, source: { kind: 'port', portId: 'references', portIndex: 1 } },
      ],
      output: 'auto',
    },
  }
  const definition = await nodes.install(pack)
  await store.updateProject(project.id, {
    graph: {
      ...project.graph,
      nodes: [{
        id: 'typed-node',
        data: { nodeType: definition.type, nodeVersion: definition.version, workflowId: definition.workflowId },
      }],
    },
  })
  const image = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'input.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('typed-image').toString('base64'),
  })
  const audioOne = await store.putAsset({
    projectId: project.id,
    kind: 'audio',
    name: 'one.wav',
    mimeType: 'audio/wav',
    dataBase64: Buffer.from('typed-audio-one').toString('base64'),
  })
  const audioTwo = await store.putAsset({
    projectId: project.id,
    kind: 'audio',
    name: 'two.wav',
    mimeType: 'audio/wav',
    dataBase64: Buffer.from('typed-audio-two').toString('base64'),
  })
  const queued = []
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued.push(request); return { id: `job-${String(queued.length)}` } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })
  const start = mediaInputs => rpc('jobs/start', {
    projectId: project.id,
    nodeId: 'typed-node',
    operation: 'image-generation',
    providerId: 'comfyui',
    expectedOutputTypes: ['video'],
    mediaInputs,
  })

  let result = await start([
    { targetPortId: 'image', mediaType: 'image', assetId: image.id },
    { targetPortId: 'references', mediaType: 'audio', assetId: audioOne.id },
    { targetPortId: 'references', mediaType: 'audio', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, true)
  assert.equal(queued[0].operation, 'image-edit')
  assert.deepEqual(queued[0].expectedOutputTypes, ['image'])
  assert.deepEqual(queued[0].mediaInputs.map(input => [input.portId, input.portIndex, input.mediaKind]), [
    ['image', 0, 'image'],
    ['references', 0, 'audio'],
    ['references', 1, 'audio'],
  ])
  assert.equal(queued[0].bindings.find(binding => binding.nodeId === 'image').assetId, image.id)
  assert.equal(queued[0].bindings.find(binding => binding.nodeId === 'audio').assetId, audioTwo.id)

  result = await start([
    { assetId: image.id },
    { portId: 'references', assetId: audioOne.id },
    { portId: 'references', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-binding-invalid')
  assert.match(result.error.message, /portId.*multiple input ports/i)

  result = await start([
    { portId: 'image', assetId: audioOne.id },
    { portId: 'references', assetId: audioOne.id },
    { portId: 'references', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-type-mismatch')

  result = await start([
    { portId: 'image', assetId: image.id },
    { portId: 'image', assetId: image.id },
    { portId: 'references', assetId: audioOne.id },
    { portId: 'references', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-cardinality-invalid')

  result = await start([
    { portId: 'references', assetId: audioOne.id },
    { portId: 'references', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-required')

  const legacyPack = structuredClone(pack)
  legacyPack.type = 'example.single-port-legacy'
  legacyPack.implementation.operation = 'image-generation'
  legacyPack.manifest.inputs = [legacyPack.manifest.inputs[0]]
  legacyPack.implementation.bindings = [legacyPack.implementation.bindings[0]]
  delete legacyPack.implementation.workflow.audio
  const legacy = await nodes.install(legacyPack)
  result = await rpc('jobs/start', {
    projectId: project.id,
    nodeId: 'legacy-node',
    nodeType: legacy.type,
    nodeVersion: legacy.version,
    providerId: 'comfyui',
    mediaInputs: [{ assetId: image.id }],
  })
  assert.equal(result.ok, true)
  assert.equal(queued.at(-1).mediaInputs[0].portId, 'image')
})

test('Director RPC enforces MiniMax video mode frame counts and resolves ordered frame bindings', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Video modes', sessionId: 'session-video-modes' })
  const first = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'first.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('first-frame').toString('base64'),
  })
  const last = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'last.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('last-frame').toString('base64'),
  })
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const queued = []
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued.push(request); return { id: `video-mode-${String(queued.length)}` } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })
  const start = (videoMode, mediaInputs = []) => rpc('jobs/start', {
    projectId: project.id,
    operation: 'video-generation',
    providerId: 'comfyui',
    workflowId: 'builtin-minimax-h3-video-turbo',
    videoMode,
    workflowValues: {},
    mediaInputs,
  })

  let result = await start('last-frame-locked', [
    { portId: 'reference', mediaKind: 'image', assetId: last.id },
  ])
  assert.equal(result.ok, true)
  assert.equal('136' in queued[0].workflow, false)
  assert.equal('139' in queued[0].workflow, true)
  assert.equal(queued[0].bindings.find(binding => binding.frameRole === 'last').assetId, last.id)

  result = await start('first-to-last-frame', [
    { portId: 'reference', mediaKind: 'image', assetId: first.id },
    { portId: 'reference', mediaKind: 'image', assetId: last.id },
  ])
  assert.equal(result.ok, true)
  assert.equal(queued[1].bindings.find(binding => binding.frameRole === 'first').assetId, first.id)
  assert.equal(queued[1].bindings.find(binding => binding.frameRole === 'last').assetId, last.id)

  result = await start('text-to-video')
  assert.equal(result.ok, true)
  assert.equal('136' in queued[2].workflow, false)
  assert.equal('139' in queued[2].workflow, false)

  result = await start('first-frame-locked')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-cardinality-invalid')
  assert.match(result.error.message, /requires exactly 1 frame reference/i)

  result = await start('text-to-video', [
    { portId: 'reference', mediaKind: 'image', assetId: first.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-cardinality-invalid')
  assert.match(result.error.message, /requires exactly 0 frame references/i)
  assert.equal(queued.length, 3)
})

test('Director RPC routes mixed reference media by type and enforces the R2V slot limits', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Typed R2V references', sessionId: 'session-r2v-references' })
  const put = (kind, name, value) => store.putAsset({
    projectId: project.id,
    kind,
    name,
    mimeType: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4',
    dataBase64: Buffer.from(value).toString('base64'),
  })
  const imageOne = await put('image', 'image-one.png', 'image-one')
  const imageTwo = await put('image', 'image-two.png', 'image-two')
  const imageThree = await put('image', 'image-three.png', 'image-three')
  const audioOne = await put('audio', 'audio-one.wav', 'audio-one')
  const audioTwo = await put('audio', 'audio-two.wav', 'audio-two')
  const videoOne = await put('video', 'video-one.mp4', 'video-one')
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const queued = []
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued.push(request); return { id: `r2v-${String(queued.length)}` } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })
  const start = mediaInputs => rpc('jobs/start', {
    projectId: project.id,
    operation: 'video-generation',
    providerId: 'comfyui',
    workflowId: 'builtin-minimax-h3-reference-to-video-turbo',
    workflowValues: {},
    mediaInputs,
  })

  let result = await start([
    { portId: 'reference', mediaKind: 'audio', assetId: audioOne.id },
    { portId: 'reference', mediaKind: 'image', assetId: imageOne.id },
    { portId: 'reference', mediaKind: 'video', assetId: videoOne.id },
    { portId: 'reference', mediaKind: 'image', assetId: imageTwo.id },
    { portId: 'reference', mediaKind: 'audio', assetId: audioTwo.id },
  ])
  assert.equal(result.ok, true)
  const references = queued[0].bindings.filter(binding => binding.referenceKind !== undefined)
  assert.deepEqual(references.map(binding => [binding.nodeId, binding.referenceKind, binding.portIndex, binding.assetId]), [
    ['137', 'image', 0, imageOne.id],
    ['139', 'image', 1, imageTwo.id],
    ['145', 'audio', 0, audioOne.id],
    ['146', 'audio', 1, audioTwo.id],
    ['144', 'video', 0, videoOne.id],
  ])

  result = await start([
    { portId: 'reference', mediaKind: 'image', assetId: imageOne.id },
    { portId: 'reference', mediaKind: 'image', assetId: imageTwo.id },
    { portId: 'reference', mediaKind: 'image', assetId: imageThree.id },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/port-cardinality-invalid')
  assert.match(result.error.message, /at most 2 image/i)
  assert.equal(queued.length, 1)
})

test('Director RPC treats pinned text fields as single typed input ports with literal fallback', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Field input ports', sessionId: 'session-field-input-ports' })
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const definition = await nodes.install({
    protocol: 'video-director.node/v1',
    type: 'example.field-input-ports',
    version: '1.0.0',
    manifest: {
      title: 'Field input ports',
      category: 'image',
      inputs: [],
      outputs: [{ id: 'image', label: 'Image', types: ['image'] }],
      fields: [
        {
          id: 'prompt', label: 'Prompt', schema: { type: 'string', maxLength: 80 },
          default: 'literal prompt', placement: 'primary', control: 'textarea',
        },
        {
          id: 'style', label: 'Style', schema: { type: 'string', maxLength: 12 },
          default: 'literal', placement: 'advanced', control: 'input',
        },
        {
          id: 'count', label: 'Count', schema: { type: 'number', min: 1, max: 4, integer: true },
          default: 1, placement: 'advanced', control: 'input',
        },
      ],
    },
    implementation: {
      kind: 'comfyui.workflow',
      operation: 'image-generation',
      workflow: {
        positive: { class_type: 'CLIPTextEncode', inputs: { text: 'literal prompt' } },
        config: { class_type: 'StyleConfig', inputs: { style: 'literal', count: 1 } },
        save: { class_type: 'SaveImage', inputs: { images: ['config', 0] } },
      },
      bindings: [
        { target: { nodeId: 'positive', input: 'text' }, source: { kind: 'field', fieldId: 'prompt' } },
        { target: { nodeId: 'config', input: 'style' }, source: { kind: 'field', fieldId: 'style' } },
        { target: { nodeId: 'config', input: 'count' }, source: { kind: 'field', fieldId: 'count' } },
      ],
      output: 'auto',
    },
  })
  const image = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'not-text.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('not-a-text-input').toString('base64'),
  })
  const queued = []
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued.push(request); return { id: `job-${String(queued.length)}` } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })
  let runSequence = 0
  const start = request => {
    runSequence += 1
    return rpc('jobs/start', {
      projectId: project.id,
      nodeId: 'field-input-node',
      clientRunId: `field-input-run-${String(runSequence)}`,
      snapshot: {
        version: 1,
        sourceRevision: project.revision,
        nodeType: definition.type,
        nodeVersion: definition.version,
        nodeDigest: definition.digest,
        request: {
          providerId: 'comfyui',
          prompt: 'literal prompt',
          workflowValues: { style: 'literal', count: 1 },
          mediaInputs: [],
          ...request,
        },
      },
    })
  }

  let result = await start({
    fieldInputModes: { prompt: { mode: 'input' }, style: { mode: 'input' } },
    mediaInputs: [
      { targetPortId: 'field:prompt', mediaType: 'text', text: 'connected prompt' },
      { portId: 'field:style', mediaKind: 'text', text: 'cinematic' },
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(queued[0].prompt, 'connected prompt')
  assert.equal(queued[0].workflow.config.inputs.style, 'cinematic')
  assert.equal(queued[0].bindings.some(binding => binding.from === 'prompt'), true)
  assert.deepEqual(queued[0].mediaInputs.map(input => [input.portId, input.portIndex, input.mediaKind]), [
    ['field:prompt', 0, 'text'],
    ['field:style', 0, 'text'],
  ])

  result = await start({
    fieldInputModes: { style: { mode: 'input' } },
    workflowValues: { style: 'fallback', count: 1 },
  })
  assert.equal(result.ok, true)
  assert.equal(queued[1].workflow.config.inputs.style, 'fallback')

  const invalidCases = [
    {
      request: { fieldInputModes: { missing: { mode: 'input' } } },
      code: 'video-director/port-binding-invalid',
    },
    {
      request: { fieldInputModes: { count: { mode: 'input' } } },
      code: 'video-director/port-type-mismatch',
    },
    {
      request: {
        fieldInputModes: { style: { mode: 'input' } },
        mediaInputs: [
          { portId: 'field:style', text: 'first' },
          { portId: 'field:style', text: 'second' },
        ],
      },
      code: 'video-director/port-cardinality-invalid',
    },
    {
      request: {
        fieldInputModes: { style: { mode: 'input' } },
        mediaInputs: [{ portId: 'field:style', assetId: image.id }],
      },
      code: 'video-director/port-type-mismatch',
    },
    {
      request: {
        fieldInputModes: { style: { mode: 'input' } },
        mediaInputs: [{ portId: 'field:style', text: 'far too descriptive' }],
      },
      code: 'video-director/field-value-invalid',
    },
  ]
  for (const invalidCase of invalidCases) {
    result = await start(invalidCase.request)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, invalidCase.code)
  }
  assert.equal(queued.length, 2)
})

test('Director RPC derives generic workflow text ports from parameters and semantic prompt bindings', async (t) => {
  const store = await createStore(t)
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const workflow = await workflows.import({
    name: 'Generic text inputs',
    kind: 'image-generation',
    document: {
      positive: { class_type: 'CLIPTextEncode', inputs: { text: 'literal prompt' } },
      config: { class_type: 'StyleConfig', inputs: { caption: 'literal caption', strength: 1 } },
      save: { class_type: 'SaveImage', inputs: { images: ['config', 0] } },
    },
  })
  const captionId = workflow.parameters.find(parameter => parameter.input === 'caption').id
  let queued
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued = request; return { id: 'generic-field-job' } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })

  const result = await rpc('jobs/start', {
    operation: 'image-generation',
    providerId: 'comfyui',
    workflowId: workflow.id,
    prompt: 'literal prompt',
    workflowValues: { [captionId]: 'literal caption' },
    fieldInputModes: { prompt: { mode: 'input' }, [captionId]: { mode: 'input' } },
    mediaInputs: [
      { portId: 'field:prompt', text: 'connected semantic prompt' },
      { portId: `field:${captionId}`, text: 'connected caption' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(queued.prompt, 'connected semantic prompt')
  assert.equal(queued.workflow.config.inputs.caption, 'connected caption')
  assert.deepEqual(queued.mediaInputs.map(input => input.portId), [
    'field:prompt',
    `field:${captionId}`,
  ])
})

test('Director RPC accepts prompt text ports for a direct provider node without a workflow', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Direct provider fields', sessionId: 'direct-provider-fields' })
  const image = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'reference.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('direct-reference').toString('base64'),
  })
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  let queued
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: { async start(request) { queued = request; return { id: 'direct-field-job' } } },
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })

  const result = await rpc('jobs/start', {
    projectId: project.id,
    operation: 'image-generation',
    providerId: 'openai',
    prompt: 'literal prompt',
    fieldInputModes: { prompt: { mode: 'input' } },
    mediaInputs: [
      { portId: 'reference', mediaKind: 'image', assetId: image.id },
      { portId: 'field:prompt', mediaKind: 'text', text: 'connected prompt' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(queued.prompt, 'connected prompt')
  assert.deepEqual(queued.mediaInputs.map(input => input.portId), ['reference', 'field:prompt'])
})

test('Director RPC queues an unsaved typed node from one immutable execution snapshot', async (t) => {
  const store = await createStore(t)
  const project = await store.createProject({ name: 'Unsaved snapshot', sessionId: 'session-unsaved-snapshot' })
  const graphBefore = structuredClone(project.graph)
  const workflows = new ComfyWorkflowStore(store.root)
  await workflows.init()
  const nodes = new VdNodeRegistry(workflows)
  const definition = await nodes.install({
    protocol: 'video-director.node/v1',
    type: 'example.snapshot-image-edit',
    version: '1.0.0',
    manifest: {
      title: 'Snapshot image edit',
      description: 'Exercises immutable run snapshots.',
      category: 'image',
      inputs: [{ id: 'image', label: 'Image', types: ['image'], required: true }],
      outputs: [{ id: 'image', label: 'Image', types: ['image'] }],
      fields: [{
        id: 'strength',
        label: 'Strength',
        schema: { type: 'number', min: 0, max: 1, step: 0.05 },
        default: 0.5,
        placement: 'primary',
        control: 'slider',
      }],
    },
    implementation: {
      kind: 'comfyui.workflow',
      operation: 'image-edit',
      workflow: {
        load: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        edit: { class_type: 'SnapshotImageEdit', inputs: { image: ['load', 0], strength: 0.5 } },
        save: { class_type: 'SaveImage', inputs: { images: ['edit', 0] } },
      },
      bindings: [
        { target: { nodeId: 'load', input: 'image' }, source: { kind: 'port', portId: 'image' } },
        { target: { nodeId: 'edit', input: 'strength' }, source: { kind: 'field', fieldId: 'strength' } },
      ],
      output: 'auto',
    },
  })
  const image = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'unsaved-input.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('unsaved-snapshot-image').toString('base64'),
  })
  const manager = new JobManager(store, {
    async run() { throw new Error('a zero-concurrency test queue must not run') },
  }, { concurrency: 0 })
  const rpc = createDirectorRpc({
    store,
    providers: { publicCatalog: () => [], check: async () => ({ ok: true, latencyMs: 1 }) },
    jobs: manager,
    registerAsset: async () => {},
    workflows,
    nodes,
    providerSettings: { updateProvider: async () => {} },
  })
  const envelope = {
    projectId: project.id,
    nodeId: 'unsaved-snapshot-node',
    clientRunId: 'client-run-snapshot',
    snapshot: {
      version: 1,
      sourceRevision: project.revision,
      nodeType: definition.type,
      nodeVersion: definition.version,
      nodeDigest: definition.digest,
      request: {
        providerId: 'comfyui',
        prompt: 'use the current unsaved values',
        workflowValues: { strength: 0.75 },
        mediaInputs: [{ portId: 'image', assetId: image.id }],
        workflowRunId: '00000000-0000-4000-8000-000000000100',
        workflowRunMode: 'all',
        batchIndex: 1,
        batchSize: 3,
      },
    },
  }

  let result = await rpc('jobs/start', {
    ...envelope,
    snapshot: { ...envelope.snapshot, nodeDigest: '0'.repeat(64) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'video-director/invalid-input')
  assert.match(result.error.message, /nodeDigest does not match/i)

  result = await rpc('jobs/start', {
    ...envelope,
    snapshot: {
      ...envelope.snapshot,
      request: { ...envelope.snapshot.request, workflowValues: { strength: 2 } },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /must be at most 1/i)

  result = await rpc('jobs/start', envelope)
  assert.equal(result.ok, true)
  assert.equal(result.value.job.status, 'queued')
  assert.deepEqual({
    nodeId: result.value.job.nodeId,
    clientRunId: result.value.job.clientRunId,
    sourceRevision: result.value.job.sourceRevision,
    nodeDigest: result.value.job.nodeDigest,
    workflowRunId: result.value.job.workflowRunId,
    workflowRunMode: result.value.job.workflowRunMode,
    batchIndex: result.value.job.batchIndex,
    batchSize: result.value.job.batchSize,
  }, {
    nodeId: 'unsaved-snapshot-node',
    clientRunId: 'client-run-snapshot',
    sourceRevision: project.revision,
    nodeDigest: definition.digest,
    workflowRunId: '00000000-0000-4000-8000-000000000100',
    workflowRunMode: 'all',
    batchIndex: 1,
    batchSize: 3,
  })
  const persisted = await store.getProject(project.id)
  assert.equal(JSON.stringify(persisted.graph), JSON.stringify(graphBefore))
  assert.equal(persisted.jobs.at(-1).clientRunId, 'client-run-snapshot')
  assert.equal(persisted.jobs.at(-1).workflowRunId, '00000000-0000-4000-8000-000000000100')
})

test('Director RPC serializes node removal with project reference saves', async () => {
  const projectId = '00000000-0000-4000-8000-000000000099'
  let releaseSave
  const saveRelease = new Promise(resolve => { releaseSave = resolve })
  let saveEntered
  const saveEntry = new Promise(resolve => { saveEntered = resolve })
  let removed = false
  const store = {
    async saveProject(_projectId, project) {
      saveEntered()
      await saveRelease
      return project
    },
    async listProjects() { return [] },
  }
  const nodes = {
    list: () => [],
    get: () => ({
      type: 'example.locked-node', version: '1.0.0', workflowId: 'workflow-locked', builtIn: false,
    }),
    async remove() { removed = true },
  }
  const workflows = { list: () => [], get: () => ({}) }
  const rpc = createDirectorRpc({
    store,
    nodes,
    workflows,
    providers: { publicCatalog: () => [] },
    jobs: {},
    registerAsset: async () => {},
    providerSettings: {},
  })
  const project = {
    id: projectId,
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  }

  const save = rpc('projects/save', { projectId, expectedRevision: 1, project })
  await saveEntry
  const removeNode = rpc('nodes/remove', { type: 'example.locked-node', version: '1.0.0' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(removed, false)

  releaseSave()
  assert.equal((await save).ok, true)
  assert.equal((await removeNode).ok, true)
  assert.equal(removed, true)
})
