import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import { JobManager } from '../src/jobs.js'
import { ProjectStore } from '../src/project-store.js'
import { ProviderRuntime } from '../src/providers.js'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-cancellation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  const project = await store.createProject({ name: 'Cancellation', sessionId: 'cancellation-test' })
  await store.updateProject(project.id, { graph: { ...project.graph, nodes: [{ id: 'render' }] } })
  return { store, project }
}

async function terminalJob(manager, projectId, jobId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await manager.get(projectId, jobId)
    if (!['queued', 'running'].includes(job.status) && manager.running === 0) return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('job did not finish cancellation')
}

for (const [state, transport] of [['running', 'rest'], ['pending', 'rest'], ['running', 'mcp']]) {
  test(`cancelling a vd-job stops its ${state} ComfyUI prompt over ${transport} without touching other jobs`, async t => {
    const { store, project } = await setup(t)
    const promptId = '00000000-0000-4000-8000-000000000001'
    let remoteState = state
    const cancellations = []
    let observed
    const monitoring = new Promise(resolve => { observed = resolve })
    const runtime = new ProviderRuntime({
      store,
      providers: [{ id: 'comfyui', label: 'ComfyUI', kind: transport === 'mcp' ? 'comfyui-mcp' : 'comfyui',
        mcpTool: 'mcp__comfyui__call_tool', baseUrl: 'localhost:8188', pollIntervalMs: 1 }],
      tools: { execute: async () => ({ prompt_id: promptId }) },
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        if (path === '/prompt') return Response.json({ prompt_id: promptId })
        if (path === `/api/jobs/${promptId}/cancel`) {
          assert.equal(init.method, 'POST')
          assert.notEqual(init.signal?.aborted, true, 'remote cancellation needs a fresh signal')
          cancellations.push(promptId)
          remoteState = 'cancelled'
          return Response.json({ cancelled: true })
        }
        if (path === '/queue') return Response.json({
          queue_running: [[0, 'someone-elses-job'], ...(remoteState === 'running' ? [[1, promptId]] : [])],
          queue_pending: remoteState === 'pending' ? [[1, promptId]] : [],
        })
        if (path === `/history/${promptId}`) { observed(); return Response.json({}) }
        throw new Error(`unexpected provider request ${init.method ?? 'GET'} ${path}`)
      },
    })
    const manager = new JobManager(store, runtime)
    const job = await manager.start({ projectId: project.id, nodeId: 'render', providerId: 'comfyui',
      operation: 'image-generation', workflow: {}, bindings: [] })
    await monitoring
    await manager.cancel(project.id, job.id)
    assert.equal((await terminalJob(manager, project.id, job.id)).status, 'cancelled')
    assert.equal(remoteState, 'cancelled', 'the remote prompt must stop before the local job becomes cancelled')
    assert.deepEqual(cancellations, [promptId])
  })
}

const comfyProvider = { id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'localhost:8188', pollIntervalMs: 1 }
const comfyInput = { providerId: 'comfyui', operation: 'image-generation', workflow: {}, bindings: [] }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('ComfyUI cancellation survives a tunnel outage and waits for execution to stop', async t => {
  const { store, project } = await setup(t)
  const monitoring = deferred()
  const retry = deferred()
  const retrying = deferred()
  const stopping = deferred()
  const stopped = deferred()
  let cancels = 0
  let remoteRunning = true
  const runtime = new ProviderRuntime({ store, providers: [comfyProvider],
    waitImpl: async ms => {
      if (ms === 1_000) { retrying.resolve(); await retry.promise }
      else if (cancels > 0) { stopping.resolve(); await stopped.promise }
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/prompt') return Response.json({ prompt_id: 'ours' })
      if (path === '/history/ours') { monitoring.resolve(); return Response.json({}) }
      if (path === '/api/jobs/ours/cancel') {
        assert.equal(init.signal.aborted, false)
        if (++cancels === 1) throw new TypeError('fetch failed')
        return Response.json({ cancelled: true })
      }
      if (path === '/queue') return Response.json({ queue_running: remoteRunning ? [[0, 'ours']] : [[1, 'next-job']], queue_pending: [] })
      throw new Error(`unexpected request ${path}`)
    },
  })
  const manager = new JobManager(store, runtime)
  const job = await manager.start({ ...comfyInput, projectId: project.id, nodeId: 'render' })
  await monitoring.promise
  await manager.cancel(project.id, job.id)
  await retrying.promise
  assert.equal((await manager.get(project.id, job.id)).phase, 'cancelling-reconnecting')
  retry.resolve()
  await stopping.promise
  assert.equal((await manager.get(project.id, job.id)).status, 'running', 'acknowledging an interrupt is not proof the node stopped')
  await manager.cancel(project.id, job.id)
  remoteRunning = false
  stopped.resolve()
  assert.equal((await terminalJob(manager, project.id, job.id)).status, 'cancelled')
  assert.equal(cancels, 2, 'repeat Cancel does not spawn another cleanup operation')
})

for (const transport of ['rest', 'mcp']) {
  test(`cancellation during ${transport} enqueue waits for the receipt and cancels the returned prompt`, async () => {
    const controller = new AbortController()
    const enqueuing = deferred()
    const receipt = deferred()
    const cancelled = []
    let submissionSignal
    const submit = async signal => {
      submissionSignal = signal
      enqueuing.resolve()
      await receipt.promise
      return { prompt_id: 'late-receipt' }
    }
    const runtime = new ProviderRuntime({ store: {}, providers: [{ ...comfyProvider,
      kind: transport === 'mcp' ? 'comfyui-mcp' : 'comfyui', mcpTool: 'mcp__comfyui__call_tool' }],
      tools: { execute: async call => submit(call.signal) },
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        if (path === '/prompt') return Response.json(await submit(init.signal))
        if (path === '/api/jobs/late-receipt/cancel') {
          cancelled.push(path)
          return Response.json({ cancelled: true })
        }
        if (path === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        throw new Error(`unexpected request ${path}`)
      },
    })
    const outcome = assert.rejects(runtime.run(comfyInput, controller.signal), /user cancelled/u)
    await enqueuing.promise
    controller.abort(new Error('user cancelled'))
    assert.equal(submissionSignal.aborted, false, 'retain the bounded enqueue receipt after Cancel')
    receipt.resolve()
    await outcome
    assert.equal(cancelled.length, 1)
  })
}

test('cancellation recovers a lost submission receipt by client ID without enqueueing twice', async () => {
  const controller = new AbortController()
  let clientId
  let enqueues = 0
  let cancelled = false
  const runtime = new ProviderRuntime({ store: {}, providers: [comfyProvider],
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/prompt') {
        enqueues += 1
        clientId = JSON.parse(init.body).client_id
        controller.abort(new Error('user cancelled'))
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      }
      assert.equal(init.signal.aborted, false)
      if (path === '/queue') return Response.json({ queue_running: [[0, 'unrelated', {}, { client_id: 'unrelated' }]],
        queue_pending: cancelled ? [] : [[1, 'recovered', {}, { client_id: clientId }]] })
      if (path === '/api/jobs/recovered/cancel') { cancelled = true; return Response.json({ cancelled: true }) }
      throw new Error(`unexpected request ${path}`)
    },
  })
  await assert.rejects(runtime.run(comfyInput, controller.signal), /user cancelled/u)
  assert.equal(enqueues, 1)
  assert.equal(cancelled, true)
})

test('cancelling before execution never submits a ComfyUI workflow', async () => {
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  const runtime = new ProviderRuntime({ store: {}, providers: [comfyProvider],
    fetchImpl: async () => assert.fail('no remote work should be submitted'),
  })
  await assert.rejects(runtime.run(comfyInput, controller.signal), /user cancelled/u)
})

for (const running of [false, true]) {
  test(`legacy ComfyUI cancellation deletes only its queued prompt and ${running ? 'reports unsupported running cancellation' : 'confirms removal'}`, async () => {
    const controller = new AbortController()
    const deletions = []
    const runtime = new ProviderRuntime({ store: {}, providers: [comfyProvider],
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        if (path === '/prompt') return Response.json({ prompt_id: 'ours' })
        if (path === '/history/ours') { controller.abort(new Error('user cancelled')); return Response.json({}) }
        if (path === '/api/jobs/ours/cancel') return new Response('', { status: 404 })
        if (path === '/queue' && init.method === 'POST') {
          deletions.push(JSON.parse(init.body))
          return new Response('')
        }
        if (path === '/queue') return Response.json({ queue_running: [[0, running ? 'ours' : 'unrelated']], queue_pending: [[1, 'unrelated-pending']] })
        throw new Error(`must never globally interrupt or clear other jobs: ${path}`)
      },
    })
    await assert.rejects(runtime.run(comfyInput, controller.signal), error => {
      if (running) assert.equal(error.code, 'video-director/remote-cancel-failed')
      else assert.match(error.message, /user cancelled/u)
      return true
    })
    assert.deepEqual(deletions, [{ delete: ['ours'] }])
  })
}

test('a rejected remote cancellation is a failed job, not a falsely cancelled job', async t => {
  const { store, project } = await setup(t)
  const monitoring = deferred()
  const runtime = new ProviderRuntime({ store, providers: [comfyProvider],
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path === '/prompt') return Response.json({ prompt_id: 'ours' })
      if (path === '/history/ours') { monitoring.resolve(); return Response.json({}) }
      if (path === '/api/jobs/ours/cancel') return new Response('', { status: 403 })
      if (path === '/queue') return Response.json({ queue_running: [[0, 'ours']], queue_pending: [] })
      throw new Error(`unexpected request ${path}`)
    },
  })
  const manager = new JobManager(store, runtime)
  const job = await manager.start({ ...comfyInput, projectId: project.id, nodeId: 'render' })
  await monitoring.promise
  await manager.cancel(project.id, job.id)
  const terminal = await terminalJob(manager, project.id, job.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCode, 'video-director/remote-cancel-failed')
  assert.match(terminal.error, /Could not confirm ComfyUI cancellation for ours/u)
})

for (const headersReceived of [false, true]) {
  test(`cancelling Ollama closes its HTTP request ${headersReceived ? 'during the response body' : 'before response headers'} without retrying or unloading other models`, { timeout: 5_000 }, async t => {
    const { store, project } = await setup(t)
    const receiving = deferred()
    const disconnected = deferred()
    const requests = []
    const server = createServer(async (req, res) => {
      requests.push(req.url)
      for await (const _chunk of req) { /* consume the JSON request */ }
      res.on('close', () => disconnected.resolve())
      if (headersReceived) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"message":{"content":"partial')
      }
      receiving.resolve()
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const runtime = new ProviderRuntime({ store, providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama',
      baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test' }],
      waitImpl: async () => assert.fail('a cancelled generation must never retry'),
    })
    const manager = new JobManager(store, runtime)
    const job = await manager.start({ projectId: project.id, nodeId: 'render', providerId: 'ollama', operation: 'text-generation', prompt: 'test' })
    await receiving.promise
    await manager.cancel(project.id, job.id)
    await disconnected.promise
    assert.equal((await terminalJob(manager, project.id, job.id)).status, 'cancelled')
    assert.deepEqual(requests, ['/api/chat'])
  })
}

test('a provider response arriving after Cancel cannot complete the local job', async t => {
  const { store, project } = await setup(t)
  const executing = deferred()
  const result = deferred()
  const manager = new JobManager(store, { run: async () => { executing.resolve(); return result.promise } })
  const job = await manager.start({ projectId: project.id, nodeId: 'render', providerId: 'test', operation: 'text-generation', prompt: 'test' })
  await executing.promise
  await manager.cancel(project.id, job.id)
  result.resolve({ kind: 'text', text: 'late response', providerId: 'test' })
  assert.equal((await terminalJob(manager, project.id, job.id)).status, 'cancelled')
})
