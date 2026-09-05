import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderRuntime } from '../src/providers.js'

function createMcpRuntime({ accepted, execute = async () => ({ value: { prompt_id: 'prompt-1' } }) }) {
  return new ProviderRuntime({
    store: {
      async assetBytes() { throw new Error('the test did not expect an asset upload') },
    },
    providers: [{
      id: 'comfyui-mcp',
      label: 'ComfyUI MCP',
      kind: 'comfyui-mcp',
      mcpTool: 'mcp__comfyui__call_tool',
    }],
    tools: { execute },
    minimaxH3LicenseAccepted: accepted,
  })
}

function h3Request(overrides = {}) {
  return {
    projectId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'h3-video',
    operation: 'video-generation',
    providerId: 'comfyui-mcp',
    modelFamily: 'minimax-h3',
    prompt: 'A locked-off cinematic test shot with synchronized room tone.',
    width: 1280,
    height: 704,
    duration: 6,
    fps: 24,
    seed: 42,
    turbo: true,
    steps: 6,
    scheduler: 'simple',
    workflow: {
      104: { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', width: 32, height: 32, length: 5 } },
      15: { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
      9: { class_type: 'BasicScheduler', inputs: { scheduler: 'simple', steps: 6 } },
    },
    bindings: [
      { nodeId: '104', input: 'prompt', from: 'prompt' },
      { nodeId: '104', input: 'width', from: 'width' },
      { nodeId: '104', input: 'height', from: 'height' },
      { nodeId: '104', input: 'length', from: 'frames' },
      { nodeId: '15', input: 'noise_seed', from: 'seed' },
      { nodeId: '9', input: 'steps', from: 'steps' },
      { nodeId: '9', input: 'scheduler', from: 'scheduler' },
    ],
    ...overrides,
  }
}

function createOpenAiImageRuntime({ fetchImpl, store, registerAsset }) {
  return new ProviderRuntime({
    store,
    registerAsset,
    fetchImpl,
    providers: [{
      id: 'openai-image',
      label: 'OpenAI compatible image',
      kind: 'openai-compatible',
      baseUrl: 'https://images.example.test/v1',
      apiKey: 'test-secret',
      imageModel: 'gpt-image-2',
    }],
    minimaxH3LicenseAccepted: false,
  })
}

function comfyRequest(overrides = {}) {
  return {
    projectId: '00000000-0000-4000-8000-000000000099',
    nodeId: 'comfy-node',
    operation: 'image-generation',
    providerId: 'comfyui',
    prompt: 'A concise transport routing test.',
    workflow: {},
    bindings: [],
    assetIds: [],
    ...overrides,
  }
}

function createUnifiedComfyRuntime({
  fetchImpl = async () => { throw new Error('unexpected REST request') },
  execute,
  registerAsset,
  store = {
    async assetBytes() { throw new Error('the test did not expect an asset upload') },
  },
  baseUrl = '127.0.0.1:8188',
  mcpBaseUrl = baseUrl,
  waitImpl,
}) {
  return new ProviderRuntime({
    store,
    registerAsset,
    fetchImpl,
    waitImpl,
    ...(execute === undefined ? {} : { tools: { execute } }),
    providers: [{
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui',
      baseUrl,
      mcpTool: 'mcp__comfyui__call_tool',
      mcpBaseUrl,
    }],
    minimaxH3LicenseAccepted: false,
  })
}

test('ComfyUI reconnects to the submitted prompt and retries interrupted output downloads', async () => {
  let submissions = 0
  let histories = 0
  let downloads = 0
  const phases = []
  const runtime = createUnifiedComfyRuntime({
    waitImpl: async () => {},
    store: { async putAsset(input) { return { id: 'recovered-asset', ...input } } },
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path === '/prompt') { submissions += 1; return Response.json({ prompt_id: 'recover-me' }) }
      if (path === '/history/recover-me') {
        histories += 1
        if (histories === 1) throw new TypeError('fetch failed')
        if (histories === 2) return new Response('', { status: 503 })
        return Response.json({ 'recover-me': { outputs: { save: { images: [{ filename: 'done.png' }] } } } })
      }
      if (path === '/view') {
        downloads += 1
        if (downloads === 1) return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')) } }))
        return new Response('finished', { headers: { 'Content-Type': 'image/png' } })
      }
      throw new Error(`unexpected path ${path}`)
    },
  })
  const result = await runtime.run(comfyRequest(), undefined, update => { phases.push(update.phase) })
  assert.equal(result.promptId, 'recover-me')
  assert.equal(result.assets.length, 1)
  assert.equal(submissions, 1)
  assert.equal(histories, 3)
  assert.equal(downloads, 2)
  assert.ok(phases.includes('reconnecting'))
})

test('Ollama retries a disconnected generation and returns the recovered text', async () => {
  let calls = 0
  const runtime = new ProviderRuntime({
    store: {}, waitImpl: async () => {},
    providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'localhost:11434', model: 'test' }],
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return Response.json({ message: { content: 'Recovered text' } })
    },
  })
  const result = await runtime.run({ providerId: 'ollama', operation: 'prompt-enhancer', prompt: 'test' })
  assert.equal(result.text, 'Recovered text')
  assert.equal(calls, 2)
})

test('ComfyUI recovers a lost submission response by its unique client identity without enqueueing twice', async t => {
  for (const location of ['queue', 'history']) await t.test(location, async () => {
    let clientId
    let submissions = 0
    const runtime = createUnifiedComfyRuntime({
      waitImpl: async () => {},
      store: { async putAsset(input) { return { id: 'output', ...input } } },
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        const prompt = [0, 'lost-response', {}, { client_id: clientId }]
        const history = { prompt, outputs: { save: { images: [{ filename: 'done.png' }] } } }
        if (path === '/prompt') {
          submissions += 1
          clientId = JSON.parse(init.body).client_id
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
        }
        if (path === '/queue') return Response.json({ queue_pending: location === 'queue' ? [prompt] : [], queue_running: [] })
        if (path === '/history') return Response.json({ 'lost-response': history })
        if (path === '/history/lost-response') return Response.json({ 'lost-response': history })
        if (path === '/view') return new Response('done', { headers: { 'Content-Type': 'image/png' } })
        throw new Error(`unexpected path ${path}`)
      },
    })
    assert.equal((await runtime.run(comfyRequest())).promptId, 'lost-response')
    assert.equal(submissions, 1)
  })
})

test('ComfyUI retries a refused connection before submission and reports waiting in the remote queue', async () => {
  let submissions = 0
  let checks = 0
  const phases = []
  const runtime = createUnifiedComfyRuntime({
    waitImpl: async () => {},
    store: { async putAsset(input) { return { id: 'queued-output', ...input } } },
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path === '/prompt') {
        submissions += 1
        if (submissions === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
        return Response.json({ prompt_id: 'remote-queued' })
      }
      if (path === '/queue') return Response.json({ queue_pending: [[1, 'remote-queued']] })
      if (path === '/history/remote-queued') {
        checks += 1
        return Response.json(checks === 1 ? {} : { 'remote-queued': { outputs: { save: { images: [{ filename: 'done.png' }] } } } })
      }
      if (path === '/view') return new Response('done', { headers: { 'Content-Type': 'image/png' } })
      throw new Error(`unexpected path ${path}`)
    },
  })
  assert.equal((await runtime.run(comfyRequest(), undefined, update => phases.push(update.phase))).assets.length, 1)
  assert.equal(submissions, 2)
  assert.equal(checks, 2)
  assert.ok(phases.includes('reconnecting'))
  assert.equal(phases.at(-1), 'queued')
})

test('provider reconnect backoff stays bounded and cancellation stops retries', async () => {
  const controller = new AbortController()
  const delays = []
  let calls = 0
  const runtime = new ProviderRuntime({
    store: {}, providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'localhost:11434' }],
    fetchImpl: async () => { calls += 1; throw new TypeError('fetch failed') },
    waitImpl: async delay => {
      delays.push(delay)
      if (delays.length === 8) controller.abort(new Error('user cancelled'))
    },
  })
  await assert.rejects(runtime.run({ providerId: 'ollama', operation: 'text-generation', prompt: 'test' }, controller.signal), /user cancelled/u)
  assert.equal(calls, 8)
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('ComfyUI execution failures and permanent provider errors are not retried', async () => {
  let waits = 0
  const runtime = createUnifiedComfyRuntime({
    waitImpl: async () => { waits += 1 },
    fetchImpl: async url => {
      if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'failed-render' })
      return Response.json({ 'failed-render': { outputs: {}, status: { completed: false, status_str: 'error',
        messages: [['execution_error', { exception_message: 'Out of VRAM' }]] } } })
    },
  })
  await assert.rejects(runtime.run(comfyRequest()), /Out of VRAM/u)
  const ollama = new ProviderRuntime({ store: {}, waitImpl: async () => { waits += 1 },
    providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'localhost:11434' }],
    fetchImpl: async () => new Response('model missing', { status: 404 }) })
  await assert.rejects(ollama.run({ providerId: 'ollama', operation: 'text-generation', prompt: 'test' }), /404/u)
  assert.equal(waits, 0)
})

test('provider catalog exposes editable connection facts but never returns API keys', () => {
  const runtime = createOpenAiImageRuntime({
    store: {},
    fetchImpl: async () => { throw new Error('not reached') },
  })
  const [provider] = runtime.publicCatalog()
  assert.equal(provider.baseUrl, 'https://images.example.test/v1')
  assert.equal(provider.imageModel, 'gpt-image-2')
  assert.equal(provider.apiKeySet, true)
  assert.equal('apiKey' in provider, false)
})

test('OpenAI-compatible audio transcription uses bounded multipart input and returns text', async () => {
  const audio = Buffer.from('fake-webm-audio')
  const requests = []
  const runtime = createOpenAiImageRuntime({
    store: {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ text: 'A clean transcription.' })
    },
  })

  const result = await runtime.transcribe('openai-image', {
    model: 'gpt-4o-mini-transcribe',
    name: 'recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    dataBase64: audio.toString('base64'),
  })

  assert.deepEqual(result, { text: 'A clean transcription.' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.test/v1/audio/transcriptions')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-secret')
  assert.equal('Content-Type' in requests[0].init.headers, false)
  assert.ok(requests[0].init.body instanceof FormData)
  assert.equal(requests[0].init.body.get('model'), 'gpt-4o-mini-transcribe')
  assert.equal(requests[0].init.body.get('response_format'), 'json')
  assert.equal(requests[0].init.body.get('file').name, 'recording.webm')
  assert.equal(requests[0].init.body.get('file').type, 'audio/webm')
  assert.deepEqual(Buffer.from(await requests[0].init.body.get('file').arrayBuffer()), audio)
})

test('audio transcription rejects non-canonical base64 before contacting the provider', async () => {
  let requested = false
  const runtime = createOpenAiImageRuntime({
    store: {},
    fetchImpl: async () => {
      requested = true
      return Response.json({ text: 'must not happen' })
    },
  })

  await assert.rejects(runtime.transcribe('openai-image', {
    model: 'gpt-4o-mini-transcribe',
    name: 'recording.webm',
    mimeType: 'audio/webm',
    dataBase64: 'YQ===',
  }), /canonical base64/u)
  assert.equal(requested, false)
})

test('unified ComfyUI accepts host:port shorthand and hides its MCP routing detail', () => {
  const runtime = createUnifiedComfyRuntime({})
  const [provider] = runtime.publicCatalog()

  assert.equal(provider.id, 'comfyui')
  assert.equal(provider.kind, 'comfyui')
  assert.equal(provider.baseUrl, 'http://127.0.0.1:8188')
  assert.equal(provider.configured, true)
  assert.equal('mcpTool' in provider, false)
  assert.equal('mcpBaseUrl' in provider, false)
})

test('Ollama model discovery reads, deduplicates, and sorts the tags API without exposing configuration secrets', async () => {
  const calls = []
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.endsWith('/api/ps')) {
        return Response.json({ models: [{ model: 'qwen3-vl:latest' }] })
      }
      return Response.json({
        models: [
          { name: 'qwen3-vl:latest', capabilities: ['vision', 'thinking', 'vision'], details: { context_length: 131_072 } },
          { model: 'deepseek-r1:8b' },
          { name: 'qwen3-vl:latest' },
          { name: '' },
        ],
      })
    },
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434', apiKey: 'not-for-the-browser',
    }],
  })

  const result = await runtime.models('ollama')

  assert.deepEqual(calls, [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434/api/ps',
  ])
  assert.deepEqual(result, {
    models: ['deepseek-r1:8b', 'qwen3-vl:latest'],
    modelInputs: [],
    modelDetails: [
      { id: 'deepseek-r1:8b', capabilities: [] },
      { id: 'qwen3-vl:latest', capabilities: ['thinking', 'vision'], contextLength: 131_072 },
    ],
    loadedModels: ['qwen3-vl:latest'],
  })
  assert.equal('apiKey' in runtime.publicCatalog()[0], false)
})

test('Ollama unload sends keep_alive zero and verifies that the model left the running set', async () => {
  const calls = []
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
      if (url.endsWith('/api/generate')) return Response.json({ done: true })
      if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'another-model:latest' }] })
      throw new Error(`unexpected request ${url}`)
    },
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434',
    }],
  })

  const result = await runtime.unloadModel('ollama', 'qwen3-vl:latest')

  assert.deepEqual(result, { model: 'qwen3-vl:latest', loaded: false })
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:11434/api/generate',
      method: 'POST',
      body: { model: 'qwen3-vl:latest', keep_alive: 0, stream: false },
    },
    { url: 'http://127.0.0.1:11434/api/ps', method: 'GET', body: undefined },
  ])
})

test('Ollama eject trigger unloads every running model and waits for confirmation', async () => {
  const calls = []
  let loaded = ['qwen3-vl:latest', 'deepseek-r1:8b']
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET' })
      if (url.endsWith('/api/tags')) return Response.json({ models: loaded.map(name => ({ name })) })
      if (url.endsWith('/api/ps')) return Response.json({ models: loaded.map(name => ({ name })) })
      if (url.endsWith('/api/generate')) {
        const body = JSON.parse(init.body)
        loaded = loaded.filter(model => model !== body.model)
        return Response.json({ done: true })
      }
      throw new Error(`unexpected request ${url}`)
    },
    providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434' }],
  })

  const result = await runtime.runTrigger('ollama-eject')

  assert.deepEqual(result.unloaded.map(row => row.model).sort(), ['deepseek-r1:8b', 'qwen3-vl:latest'])
  assert.deepEqual(loaded, [])
  assert.equal(calls.filter(call => call.url.endsWith('/api/generate')).length, 2)
})

test('ComfyUI clear trigger requests model unload and executor reset before its configurable grace wait', async () => {
  const calls = []
  const waits = []
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) })
      return Response.json({})
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds) },
    providers: [{ id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: '127.0.0.1:8188' }],
  })

  const result = await runtime.runTrigger('comfyui-clear')

  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:8188/free',
    method: 'POST',
    body: { unload_models: true, free_memory: true },
  }])
  assert.deepEqual(waits, [10_000])
  assert.equal(result.waitedMs, 10_000)

  const configured = await runtime.runTrigger('comfyui-clear', { releaseWaitSeconds: 3 })
  assert.deepEqual(waits, [10_000, 3_000])
  assert.equal(configured.waitedMs, 3_000)
})

test('skip VRAM trigger performs no provider action', async () => {
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async () => { throw new Error('skip must not contact a provider') },
    providers: [],
  })

  const result = await runtime.runTrigger('skip')

  assert.equal(result.action, 'skip')
})

test('Ollama chat sends system prompt, context length, and supported thinking controls in native fields', async () => {
  let request
  const runtime = new ProviderRuntime({
    store: { async assetBytes() { throw new Error('no assets expected') } },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/chat')
      request = JSON.parse(init.body)
      return Response.json({ message: { content: 'enhanced prompt' } })
    },
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434', model: 'qwen3-vl:latest',
    }],
  })

  const result = await runtime.run({
    projectId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'prompt',
    providerId: 'ollama',
    operation: 'prompt-enhancer',
    model: 'qwen3-vl:latest',
    prompt: 'A quiet city at dawn',
    systemPrompt: 'Return a concise cinematic prompt.',
    contextLength: 32_768,
    thinking: true,
  })

  assert.deepEqual(result, { kind: 'text', text: 'enhanced prompt', providerId: 'ollama' })
  assert.deepEqual(request, {
    model: 'qwen3-vl:latest',
    stream: false,
    messages: [
      { role: 'system', content: 'Return a concise cinematic prompt.' },
      { role: 'user', content: 'A quiet city at dawn' },
    ],
    options: { num_ctx: 32_768 },
    think: true,
  })
})

test('text workflow generation has no automatic deadline but still honors explicit cancellation', async () => {
  const delayedRuntime = new ProviderRuntime({
    store: { async assetBytes() { throw new Error('no assets expected') } },
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ message: { content: 'finished after provider deadline' } })), 35)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal.reason)
      }, { once: true })
    }),
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434',
      model: 'slow-model', timeoutMs: 5,
    }],
  })

  const result = await delayedRuntime.run({
    projectId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'prompt',
    providerId: 'ollama',
    operation: 'prompt-enhancer',
    prompt: 'Take as long as needed',
  })
  assert.equal(result.text, 'finished after provider deadline')

  const cancellation = new AbortController()
  const stuckRuntime = new ProviderRuntime({
    store: { async assetBytes() { throw new Error('no assets expected') } },
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
    providers: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434', model: 'slow-model' }],
  })
  const running = stuckRuntime.run({
    projectId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'prompt',
    providerId: 'ollama',
    operation: 'prompt-enhancer',
    prompt: 'Wait for cancellation',
  }, cancellation.signal)
  setTimeout(() => cancellation.abort(new Error('cancelled by test user')), 5)
  await assert.rejects(running, /cancelled by test user/)
})

test('ComfyUI workflow polling has no overall provider deadline', async () => {
  let historyChecks = 0
  const storedAsset = {
    id: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000001',
    kind: 'image',
    name: 'result.png',
    mimeType: 'image/png',
    size: 1,
    sha256: 'test',
    createdAt: '2026-09-04T00:00:00.000Z',
    url: '/asset/result.png',
  }
  const runtime = new ProviderRuntime({
    store: {
      async putAsset() { return storedAsset },
      async assetBytes() { throw new Error('no input assets expected') },
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'prompt-slow' })
      if (url.endsWith('/queue')) return Response.json({ queue_pending: [[0, 'prompt-slow']], queue_running: [] })
      if (url.endsWith('/history/prompt-slow')) {
        historyChecks += 1
        return historyChecks === 1
          ? Response.json({ 'prompt-slow': {} })
          : Response.json({ 'prompt-slow': { outputs: { save: { images: [{ filename: 'result.png' }] } } } })
      }
      if (url.includes('/view?')) return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
      throw new Error(`unexpected request ${url}`)
    },
    providers: [{
      id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: '127.0.0.1:8188',
      timeoutMs: 5, pollIntervalMs: 10,
    }],
  })

  const result = await runtime.run({
    projectId: storedAsset.projectId,
    nodeId: 'image',
    providerId: 'comfyui',
    operation: 'image-generation',
    workflow: {},
    bindings: [],
    expectedOutputTypes: ['image'],
  })

  assert.equal(historyChecks, 2)
  assert.deepEqual(result.assets, [storedAsset])
})

test('ComfyUI model discovery keeps every string enum target for exact workflow mapping', async () => {
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:8188/object_info')
      return Response.json({
        InvalidMetadata: null,
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [['b.safetensors', 'a.safetensors', 'a.safetensors']] } },
        },
        UNETLoader: {
          input: { required: { unet_name: [['h3.safetensors']], weight_dtype: [['default', 'fp8']] } },
        },
        DualCLIPLoader: {
          input: {
            required: { clip_name1: [['qwen-1.safetensors']] },
            optional: { clip_name2: [['qwen-2.safetensors']] },
          },
        },
        ControlNetLoader: {
          input: { required: { control_net_name: [['controlnet.safetensors']] } },
        },
        EmptyEnum: {
          input: { optional: { custom_picker: [[]] } },
        },
        LoraLoaderModelOnly: {
          input: { required: { lora_name: [['style.safetensors', 'consistent.safetensors']] } },
        },
        SaveAudioAdvanced: {
          input: {
            required: {
              format: ['COMFY_DYNAMICCOMBO_V3', {
                options: [{ key: 'flac', inputs: { required: {} } }, { key: 'mp3' }, { key: 'opus' }],
              }],
            },
          },
        },
        NonStringChoices: {
          input: { required: { steps: [[1, 2]], mixed: [['valid-looking', 2]] } },
        },
      })
    },
  })

  const result = await runtime.models('comfyui')

  assert.deepEqual(result.models, [
    'a.safetensors',
    'b.safetensors',
    'consistent.safetensors',
    'controlnet.safetensors',
    'default',
    'flac',
    'fp8',
    'h3.safetensors',
    'mp3',
    'opus',
    'qwen-1.safetensors',
    'qwen-2.safetensors',
    'style.safetensors',
  ])
  assert.deepEqual(result.modelInputs, [
    { nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name', models: ['a.safetensors', 'b.safetensors'] },
    { nodeClass: 'ControlNetLoader', input: 'control_net_name', models: ['controlnet.safetensors'] },
    { nodeClass: 'DualCLIPLoader', input: 'clip_name1', models: ['qwen-1.safetensors'] },
    { nodeClass: 'DualCLIPLoader', input: 'clip_name2', models: ['qwen-2.safetensors'] },
    { nodeClass: 'EmptyEnum', input: 'custom_picker', models: [] },
    { nodeClass: 'LoraLoaderModelOnly', input: 'lora_name', models: ['consistent.safetensors', 'style.safetensors'] },
    { nodeClass: 'SaveAudioAdvanced', input: 'format', models: ['flac', 'mp3', 'opus'] },
    { nodeClass: 'UNETLoader', input: 'unet_name', models: ['h3.safetensors'] },
    { nodeClass: 'UNETLoader', input: 'weight_dtype', models: ['default', 'fp8'] },
  ])
})

test('model discovery cancels a streaming response as soon as its byte limit is exceeded', async () => {
  let chunksSent = 0
  let cancelled = false
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        chunksSent += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61))
      },
      cancel() { cancelled = true },
    })),
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434',
    }],
  })

  await assert.rejects(runtime.models('ollama'), /Ollama model discovery response is too large/)
  assert.equal(cancelled, true)
  assert.ok(chunksSent <= 66, `stream should stop near the 4 MiB limit, received ${String(chunksSent)} chunks`)
})

test('provider HTTP errors expose only the provider label and status, never the response body', async () => {
  const secret = 'internal-upstream-secret=do-not-reflect'
  const runtime = new ProviderRuntime({
    store: {},
    fetchImpl: async () => new Response(secret, { status: 502 }),
    providers: [{
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: '127.0.0.1:11434',
    }],
  })

  await assert.rejects(runtime.models('ollama'), (error) => {
    assert.equal(error.message, 'Ollama model discovery request failed (502)')
    assert.equal(error.message.includes(secret), false)
    return true
  })
})

test('ComfyUI discovery bounds selector count, selector length, and choices per selector', async () => {
  const required = Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [
    `selector_${String(index).padStart(4, '0')}`,
    [[]],
  ]))
  const choices = Array.from({ length: 2_050 }, (_, index) => `model-${String(index).padStart(4, '0')}`)
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async () => Response.json({
      BoundedLoader: { input: { required } },
      ChoiceLoader: { input: { required: { choice: [choices] } } },
      ["N".repeat(257)]: { input: { required: { choice: [['must-not-appear']] } } },
    }),
  })

  const result = await runtime.models('comfyui')

  assert.equal(result.modelInputs.length, 1_024)
  assert.equal(result.modelInputs.some(entry => entry.nodeClass.length > 256), false)
  assert.equal(result.modelInputs.every(entry => entry.input.length <= 256), true)
  assert.equal(result.models.length, 0)

  const choicesRuntime = createUnifiedComfyRuntime({
    fetchImpl: async () => Response.json({
      ChoiceLoader: { input: { required: { choice: [[...choices, 'x'.repeat(513)]] } } },
    }),
  })
  const choicesResult = await choicesRuntime.models('comfyui')
  assert.equal(choicesResult.modelInputs[0].models.length, 2_048)
  assert.equal(choicesResult.modelInputs[0].models.every(model => model.length <= 512), true)
})

test('unified ComfyUI health requires REST and reports MCP only after a read-only probe', async () => {
  const restCalls = []
  const mcpCalls = []
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async (url) => {
      restCalls.push(url)
      return Response.json({ system: { os: 'linux' } })
    },
    execute: async (call) => {
      mcpCalls.push(call.arguments.name)
      return { value: { queue_running: [], queue_pending: [] } }
    },
  })

  const result = await runtime.check('comfyui')

  assert.equal(result.ok, true)
  assert.equal(result.transport, 'mcp')
  assert.deepEqual(restCalls, ['http://127.0.0.1:8188/system_stats'])
  assert.deepEqual(mcpCalls, ['get_queue_status'])
})

test('unified ComfyUI health fails when REST is unavailable even if MCP would work', async () => {
  let mcpCalls = 0
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async () => new Response('offline', { status: 503 }),
    execute: async () => {
      mcpCalls += 1
      return { value: { queue_running: [], queue_pending: [] } }
    },
  })

  await assert.rejects(runtime.check('comfyui'), /503/)
  assert.equal(mcpCalls, 0)
})

test('unified ComfyUI health falls back to REST when the MCP probe is unavailable', async () => {
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async () => Response.json({ system: { os: 'linux' } }),
    execute: async () => { throw new Error('MCP is not connected') },
  })

  const result = await runtime.check('comfyui')
  assert.equal(result.transport, 'rest')
})

test('unified ComfyUI does not probe or submit through MCP when its hidden endpoint differs', async () => {
  const mcpCalls = []
  const restCalls = []
  const runtime = createUnifiedComfyRuntime({
    baseUrl: '127.0.0.1:8288',
    mcpBaseUrl: 'http://127.0.0.1:8188/',
    execute: async (call) => {
      mcpCalls.push(call)
      throw new Error('mismatched MCP transport must not be called')
    },
    fetchImpl: async (url) => {
      const request = new URL(url)
      restCalls.push(request.pathname)
      if (request.pathname === '/prompt') return Response.json({ prompt_id: 'endpoint-safe-rest' })
      if (request.pathname === '/history/endpoint-safe-rest') {
        return Response.json({
          'endpoint-safe-rest': {
            outputs: { save: { images: [{ filename: 'safe.png', subfolder: '', type: 'output' }] } },
          },
        })
      }
      if (request.pathname === '/view') {
        return new Response(Buffer.from('safe'), { headers: { 'Content-Type': 'image/png' } })
      }
      throw new Error(`unexpected REST request ${url}`)
    },
    store: {
      async assetBytes() { throw new Error('the test did not expect an asset upload') },
      async putAsset(input) { return { id: 'safe-rest-output', ...input, url: '/safe-rest-output' } },
    },
  })

  const result = await runtime.run(comfyRequest())

  assert.equal(result.transport, 'rest')
  assert.deepEqual(mcpCalls, [])
  assert.deepEqual(restCalls, ['/prompt', '/history/endpoint-safe-rest', '/view'])
})

test('unified ComfyUI marks an accepted MCP enqueue without prompt_id as submission-state-unknown', async () => {
  const operations = []
  const runtime = createUnifiedComfyRuntime({
    execute: async (call) => {
      operations.push(call.arguments.name)
      if (call.arguments.name === 'get_queue_status') {
        return { value: { queue_running: [], queue_pending: [] } }
      }
      return { value: { accepted: true } }
    },
  })

  await assert.rejects(runtime.run(comfyRequest()), (error) => {
    assert.equal(error.code, 'video-director/submission-state-unknown')
    assert.equal(error.details.retryable, false)
    assert.match(error.message, /inspect the ComfyUI queue and history before retrying/i)
    return true
  })

  assert.deepEqual(operations, ['get_queue_status', 'enqueue_workflow'])
})

test('unified ComfyUI imports identifiable inline MCP final media without requiring prompt_id', async () => {
  const operations = []
  const persisted = []
  const registered = []
  const output = Buffer.from('inline-mcp-image')
  const runtime = createUnifiedComfyRuntime({
    execute: async (call) => {
      operations.push(call.arguments.name)
      if (call.arguments.name === 'get_queue_status') {
        return { value: { queue_running: [], queue_pending: [] } }
      }
      return {
        value: {
          content: [{ type: 'image', data: output.toString('base64'), mimeType: 'image/png' }],
        },
      }
    },
    store: {
      async assetBytes() { throw new Error('the test did not expect an asset upload') },
      async putAsset(input) {
        persisted.push(input)
        return { id: 'inline-mcp-output', ...input, url: '/inline-mcp-output' }
      },
    },
    registerAsset: async (asset) => { registered.push(asset) },
  })

  const result = await runtime.run(comfyRequest())

  assert.deepEqual(operations, ['get_queue_status', 'enqueue_workflow'])
  assert.equal(result.kind, 'assets')
  assert.equal(result.transport, 'mcp')
  assert.equal(result.promptId, undefined)
  assert.equal(result.assets[0].id, 'inline-mcp-output')
  assert.equal(persisted[0].kind, 'image')
  assert.equal(persisted[0].mimeType, 'image/png')
  assert.deepEqual(Buffer.from(persisted[0].dataBase64, 'base64'), output)
  assert.deepEqual(registered.map(asset => asset.id), ['inline-mcp-output'])
})

test('unified ComfyUI uses REST when the pre-enqueue MCP probe fails', async () => {
  const restCalls = []
  const runtime = createUnifiedComfyRuntime({
    execute: async () => { throw new Error('MCP is not connected') },
    fetchImpl: async (url, init) => {
      const request = new URL(url)
      restCalls.push(request.pathname)
      if (request.pathname === '/prompt') {
        assert.equal(init.method, 'POST')
        return Response.json({ prompt_id: 'rest-fallback-1' })
      }
      if (request.pathname === '/history/rest-fallback-1') {
        return Response.json({
          'rest-fallback-1': {
            outputs: {
              save: { images: [{ filename: 'fallback.png', subfolder: '', type: 'output' }] },
            },
          },
        })
      }
      if (request.pathname === '/view') {
        return new Response(Buffer.from('fallback'), { headers: { 'Content-Type': 'image/png' } })
      }
      throw new Error(`unexpected REST request ${url}`)
    },
    store: {
      async assetBytes() { throw new Error('the test did not expect an asset upload') },
      async putAsset(input) { return { id: 'rest-output', ...input, url: '/rest-output' } },
    },
  })

  const result = await runtime.run(comfyRequest())

  assert.equal(result.kind, 'assets')
  assert.equal(result.transport, 'rest')
  assert.deepEqual(restCalls, ['/prompt', '/history/rest-fallback-1', '/view'])
})

test('unified ComfyUI never retries through REST after MCP enqueue has started', async () => {
  const restCalls = []
  const operations = []
  const runtime = createUnifiedComfyRuntime({
    fetchImpl: async (url) => {
      restCalls.push(url)
      throw new Error('REST must not be reached after MCP enqueue starts')
    },
    execute: async (call) => {
      operations.push(call.arguments.name)
      if (call.arguments.name === 'get_queue_status') return { value: { queue_running: [] } }
      throw new Error('connection closed after enqueue write')
    },
  })

  await assert.rejects(runtime.run(comfyRequest()), /closed after enqueue write/)
  assert.deepEqual(operations, ['get_queue_status', 'enqueue_workflow'])
  assert.deepEqual(restCalls, [])
})

test('OpenAI-compatible image inputs use multipart edits and register the persisted output', { timeout: 2_000 }, async () => {
  const sourceBytes = Buffer.from('source-image')
  const maskBytes = Buffer.from('mask-image')
  const outputBytes = Buffer.from('edited-output')
  const persisted = []
  const registered = []
  let registrationStarted
  const started = new Promise(resolve => { registrationStarted = resolve })
  let releaseRegistration
  const registrationRelease = new Promise(resolve => { releaseRegistration = resolve })
  const requests = []
  const assets = new Map([
    ['source-asset', {
      asset: { id: 'source-asset', kind: 'image', name: 'source.png', mimeType: 'image/png' },
      data: sourceBytes,
    }],
    ['mask-asset', {
      asset: { id: 'mask-asset', kind: 'mask', name: 'mask.png', mimeType: 'image/png' },
      data: maskBytes,
    }],
  ])
  const store = {
    async assetBytes(id) {
      const value = assets.get(id)
      if (value === undefined) throw new Error(`unexpected asset ${id}`)
      return value
    },
    async putAsset(input) {
      persisted.push(input)
      return { id: 'output-asset', ...input, url: '/output-asset' }
    },
  }
  const runtime = createOpenAiImageRuntime({
    store,
    registerAsset: async asset => {
      registered.push(asset)
      registrationStarted()
      await registrationRelease
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  let settled = false
  const resultPromise = runtime.run({
    projectId: '00000000-0000-4000-8000-000000000021',
    nodeId: 'edit-image',
    operation: 'image-generation',
    providerId: 'openai-image',
    prompt: 'Replace only the overcast sky with a warm sunset.',
    width: 1024,
    height: 1024,
    mediaInputs: [{
      nodeId: 'source-node',
      kind: 'load-image',
      assetId: 'source-asset',
      maskAssetId: 'mask-asset',
      role: 'visual',
    }],
    assetIds: ['source-asset', 'mask-asset'],
  }).then((value) => {
    settled = true
    return value
  })
  await started
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeRegistration = settled
  releaseRegistration()
  const result = await resultPromise

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.test/v1/images/edits')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-secret')
  assert.equal('Content-Type' in requests[0].init.headers, false)
  assert.ok(requests[0].init.body instanceof FormData)
  assert.equal(requests[0].init.body.get('model'), 'gpt-image-2')
  assert.equal(requests[0].init.body.get('prompt'), 'Replace only the overcast sky with a warm sunset.')
  assert.equal(requests[0].init.body.get('size'), '1024x1024')
  assert.equal(requests[0].init.body.get('image').name, 'source.png')
  assert.equal(requests[0].init.body.get('image').type, 'image/png')
  assert.deepEqual(Buffer.from(await requests[0].init.body.get('image').arrayBuffer()), sourceBytes)
  assert.equal(requests[0].init.body.get('mask').name, 'mask.png')
  assert.equal(requests[0].init.body.get('mask').type, 'image/png')
  assert.deepEqual(Buffer.from(await requests[0].init.body.get('mask').arrayBuffer()), maskBytes)

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].projectId, '00000000-0000-4000-8000-000000000021')
  assert.equal(persisted[0].kind, 'image')
  assert.equal(persisted[0].mimeType, 'image/png')
  assert.deepEqual(Buffer.from(persisted[0].dataBase64, 'base64'), outputBytes)
  assert.equal(result.kind, 'assets')
  assert.equal(result.assets[0].id, 'output-asset')
  assert.equal(settledBeforeRegistration, false)
  assert.deepEqual(registered.map(asset => ({ id: asset.id, url: asset.url })), [{
    id: 'output-asset',
    url: '/output-asset',
  }])
})

test('OpenAI-compatible image generation without connected media stays on images/generations', async () => {
  const outputBytes = Buffer.from('generated-output')
  const requests = []
  const runtime = createOpenAiImageRuntime({
    store: {
      async assetBytes() { throw new Error('generation must not read assets') },
      async putAsset(input) { return { id: 'generated-asset', ...input, url: '/generated-asset' } },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await runtime.run({
    projectId: '00000000-0000-4000-8000-000000000022',
    nodeId: 'generate-image',
    operation: 'image-generation',
    providerId: 'openai-image',
    prompt: 'A clean storyboard frame.',
    width: 1024,
    height: 1024,
    mediaInputs: [],
    assetIds: [],
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.test/v1/images/generations')
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'gpt-image-2',
    prompt: 'A clean storyboard frame.',
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
  })
})

test('ComfyUI registers every persisted output before returning it', async () => {
  const lifecycle = []
  const registered = []
  let nextAsset = 0
  const runtime = new ProviderRuntime({
    store: {
      async assetBytes() { throw new Error('the test did not expect an asset upload') },
      async putAsset(input) {
        lifecycle.push('persist')
        nextAsset += 1
        return { id: `comfy-output-${String(nextAsset)}`, ...input, url: `/comfy-output-${String(nextAsset)}` }
      },
    },
    registerAsset: async asset => {
      lifecycle.push('register')
      registered.push(asset)
    },
    fetchImpl: async (url, init) => {
      const request = new URL(url)
      if (request.pathname === '/prompt') {
        assert.equal(init.method, 'POST')
        return Response.json({ prompt_id: 'comfy-prompt-1' })
      }
      if (request.pathname === '/history/comfy-prompt-1') {
        return Response.json({
          'comfy-prompt-1': {
            outputs: {
              'save-image': {
                images: [
                  { filename: 'shot-a.png', subfolder: '', type: 'output' },
                  { filename: 'shot-b.png', subfolder: '', type: 'output' },
                ],
              },
            },
          },
        })
      }
      if (request.pathname === '/view') {
        const filename = request.searchParams.get('filename')
        assert.ok(filename === 'shot-a.png' || filename === 'shot-b.png')
        return new Response(Buffer.from(filename), { headers: { 'Content-Type': 'image/png' } })
      }
      throw new Error(`unexpected ComfyUI request ${url}`)
    },
    providers: [{
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui',
      baseUrl: 'http://comfy.example.test',
    }],
    minimaxH3LicenseAccepted: false,
  })

  const result = await runtime.run({
    projectId: '00000000-0000-4000-8000-000000000023',
    nodeId: 'generate-comfy-image',
    operation: 'image-generation',
    providerId: 'comfyui',
    prompt: 'A practical-light storyboard frame.',
    workflow: {},
    bindings: [],
    assetIds: [],
  })
  lifecycle.push('return')

  assert.deepEqual(lifecycle, ['persist', 'register', 'persist', 'register', 'return'])
  assert.deepEqual(registered.map(asset => asset.id), ['comfy-output-1', 'comfy-output-2'])
  assert.deepEqual(result.assets.map(asset => asset.id), ['comfy-output-1', 'comfy-output-2'])
})

test('ComfyUI removes the optional second Qwen image node when only one reference is connected', async () => {
  let submittedWorkflow
  const runtime = new ProviderRuntime({
    store: {
      async assetBytes(id) {
        assert.equal(id, 'reference-a')
        return {
          asset: { id, name: 'reference-a.png', mimeType: 'image/png' },
          data: Buffer.from('reference-a'),
        }
      },
      async putAsset(input) { return { id: 'qwen-output', ...input, url: '/qwen-output' } },
    },
    registerAsset: async () => {},
    fetchImpl: async (url, init) => {
      const request = new URL(url)
      if (request.pathname === '/upload/image') return Response.json({ name: 'uploaded-reference-a.png' })
      if (request.pathname === '/prompt') {
        submittedWorkflow = JSON.parse(init.body).prompt
        return Response.json({ prompt_id: 'qwen-prompt' })
      }
      if (request.pathname === '/history/qwen-prompt') {
        return Response.json({ 'qwen-prompt': { outputs: { 16: { images: [{ filename: 'qwen.png', type: 'temp' }] } } } })
      }
      if (request.pathname === '/view') return new Response(Buffer.from('qwen-output'), { headers: { 'Content-Type': 'image/png' } })
      throw new Error(`unexpected ComfyUI request ${url}`)
    },
    providers: [{
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui',
      baseUrl: 'http://comfy.example.test',
    }],
  })

  await runtime.run({
    projectId: '00000000-0000-4000-8000-000000000023',
    nodeId: 'qwen-edit',
    operation: 'image-generation',
    providerId: 'comfyui',
    prompt: 'Keep the character consistent.',
    seed: 42,
    assetIds: ['reference-a'],
    mediaInputs: [{ assetId: 'reference-a', mediaKind: 'image', portId: 'reference', portIndex: 0 }],
    workflow: {
      4: { class_type: 'LoadImage', inputs: { image: '<Input_Image-1>' } },
      5: { class_type: 'LoadImage', inputs: { image: '<Input_Image-2>' } },
      1: { class_type: 'QwenEdit', inputs: { first: ['4', 0], second: ['5', 0], prompt: '<prompt_here>' } },
      16: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
    },
    bindings: [
      { nodeId: '4', input: 'image', from: 'asset', assetId: 'reference-a', portId: 'reference', portIndex: 0 },
      { nodeId: '5', input: 'image', from: 'asset', portId: 'reference', portIndex: 1, optional: true, omitNodeWhenMissing: true },
      { nodeId: '1', input: 'prompt', from: 'prompt' },
    ],
  })

  assert.equal(submittedWorkflow['4'].inputs.image, 'uploaded-reference-a.png')
  assert.equal(submittedWorkflow['1'].inputs.prompt, 'Keep the character consistent.')
  assert.equal('5' in submittedWorkflow, false)
  assert.equal('second' in submittedWorkflow['1'].inputs, false)
  assert.deepEqual(submittedWorkflow['16'].inputs.images, ['1', 0])
})

test('ComfyUI removes the complete video-reference loader chain when no R2V video is connected', async () => {
  let submittedWorkflow
  const runtime = new ProviderRuntime({
    store: {
      async assetBytes(id) {
        assert.equal(id, 'reference-image')
        return {
          asset: { id, name: 'reference-image.png', mimeType: 'image/png' },
          data: Buffer.from('reference-image'),
        }
      },
      async putAsset(input) { return { id: 'r2v-output', ...input, url: '/r2v-output' } },
    },
    registerAsset: async () => {},
    fetchImpl: async (url, init) => {
      const request = new URL(url)
      if (request.pathname === '/upload/image') return Response.json({ name: 'uploaded-reference-image.png' })
      if (request.pathname === '/prompt') {
        submittedWorkflow = JSON.parse(init.body).prompt
        return Response.json({ prompt_id: 'r2v-prune-prompt' })
      }
      if (request.pathname === '/history/r2v-prune-prompt') {
        return Response.json({ 'r2v-prune-prompt': { outputs: { 16: { images: [{ filename: 'r2v.png', type: 'temp' }] } } } })
      }
      if (request.pathname === '/view') return new Response(Buffer.from('r2v-output'), { headers: { 'Content-Type': 'image/png' } })
      throw new Error(`unexpected ComfyUI request ${url}`)
    },
    providers: [{
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui',
      baseUrl: 'http://comfy.example.test',
    }],
  })

  await runtime.run({
    projectId: '00000000-0000-4000-8000-000000000023',
    nodeId: 'r2v-prune',
    operation: 'image-generation',
    providerId: 'comfyui',
    prompt: 'Use Image 1 as the visual reference.',
    seed: 42,
    assetIds: ['reference-image'],
    mediaInputs: [{ assetId: 'reference-image', mediaKind: 'image', portId: 'reference', portIndex: 0 }],
    workflow: {
      137: { class_type: 'LoadImage', inputs: { image: '<input_image-1>' } },
      144: { class_type: 'LoadVideo', inputs: { file: '<input_video>' } },
      143: { class_type: 'GetVideoComponents', inputs: { video: ['144', 0] } },
      136: {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: {
          'ref_images.ref_image_0': ['137', 0],
          'ref_videos.ref_video_0': ['143', 0],
          'ref_video_audios.ref_video_audio_0': ['143', 1],
        },
      },
      16: { class_type: 'PreviewImage', inputs: { images: ['137', 0] } },
    },
    bindings: [
      { nodeId: '137', input: 'image', from: 'asset', assetId: 'reference-image', portId: 'reference', portIndex: 0, referenceKind: 'image' },
      {
        nodeId: '144', input: 'file', from: 'asset', portId: 'reference', portIndex: 0,
        referenceKind: 'video', optional: true, omitNodeWhenMissing: true,
        omitNodeIdsWhenMissing: ['144', '143'],
      },
    ],
  })

  assert.equal(submittedWorkflow['137'].inputs.image, 'uploaded-reference-image.png')
  assert.equal('144' in submittedWorkflow, false)
  assert.equal('143' in submittedWorkflow, false)
  assert.equal('ref_videos.ref_video_0' in submittedWorkflow['136'].inputs, false)
  assert.equal('ref_video_audios.ref_video_audio_0' in submittedWorkflow['136'].inputs, false)
  assert.deepEqual(submittedWorkflow['136'].inputs['ref_images.ref_image_0'], ['137', 0])
})

test('MiniMax H3 stays locked until its separate model license is accepted', async () => {
  let calls = 0
  const runtime = createMcpRuntime({
    accepted: false,
    execute: async () => { calls += 1; return { value: { prompt_id: 'should-not-run' } } },
  })

  await assert.rejects(runtime.run(h3Request()), (error) => {
    assert.equal(error.code, 'video-director/minimax-license-required')
    assert.match(error.message, /license/i)
    return true
  })
  assert.equal(calls, 0)
  assert.equal(runtime.publicCatalog()[0].minimaxH3Unlocked, false)
})

test('MiniMax H3 is unlocked when license acceptance is omitted', async () => {
  let calls = 0
  const runtime = createMcpRuntime({
    execute: async () => { calls += 1; return { value: { prompt_id: 'default-license' } } },
  })

  const result = await runtime.run(h3Request())

  assert.equal(result.promptId, 'default-license')
  assert.equal(calls, 1)
  assert.equal(runtime.publicCatalog()[0].minimaxH3Unlocked, true)
})

test('MiniMax H3 validates dimensions, duration, audio latent size, and Turbo controls before side effects', async () => {
  let calls = 0
  const runtime = createMcpRuntime({
    accepted: true,
    execute: async () => { calls += 1; return { value: { prompt_id: 'should-not-run' } } },
  })

  await assert.rejects(runtime.run(h3Request({ height: 720 })), /multiples of 32/i)
  await assert.rejects(runtime.run(h3Request({ duration: 15.01 })), /at most 15 seconds/i)
  await assert.rejects(runtime.run(h3Request({ operation: 'audio-generation', width: 64, height: 64 })), /32x32/i)
  await assert.rejects(runtime.run(h3Request({ steps: 9 })), /4.*8/i)
  await assert.rejects(runtime.run(h3Request({ scheduler: 'normal' })), /simple/i)

  assert.equal(calls, 0)
})

test('MiniMax H3 compiles the next 17k+5 frame count and disables MCP seed randomization', async () => {
  const calls = []
  const runtime = createMcpRuntime({
    accepted: true,
    execute: async (call) => {
      calls.push(call)
      return { value: { prompt_id: 'h3-prompt-42' } }
    },
  })

  const result = await runtime.run(h3Request({ steps: 8 }))

  assert.equal(result.kind, 'mcp-result')
  assert.equal(result.promptId, 'h3-prompt-42')
  assert.equal(result.seed, 42)
  assert.equal(result.frameCount, 158)
  assert.equal(result.actualDuration, 158 / 24)
  assert.equal(result.experimentalDuration, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'mcp__comfyui__call_tool')
  assert.equal(calls[0].arguments.name, 'enqueue_workflow')
  assert.equal(calls[0].arguments.args.disable_random_seed, true)
  assert.equal(calls[0].arguments.args.workflow['104'].inputs.length, 158)
  assert.equal(calls[0].arguments.args.workflow['104'].inputs.width, 1280)
  assert.equal(calls[0].arguments.args.workflow['104'].inputs.height, 704)
  assert.equal(calls[0].arguments.args.workflow['15'].inputs.noise_seed, 42)
  assert.equal(calls[0].arguments.args.workflow['9'].inputs.steps, 8)
  assert.equal(calls[0].arguments.args.workflow['9'].inputs.scheduler, 'simple')
})
