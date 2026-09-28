// All network calls are intercepted. Never falls through to a real provider.
export function providerConnectionsFixture() {
  const loaded = new Set(['studio-vision:27b'])
  const modelInventory = {
    checkpoints: ['studio-checkpoint.safetensors'],
    diffusion_models: ['studio-image.safetensors', 'studio-video.safetensors'],
    loras: ['studio-lora.safetensors'],
    vae: ['studio-vae.safetensors'],
  }
  const calls = []
  const providers = [
    { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'http://api.test/v1', apiKey: 'synthetic-key' },
    { id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan' },
    { id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'http://comfy.test:8188' },
    { id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://ollama.test:11434' },
  ]
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input)
    if (!url.hostname.endsWith('.test')) throw new Error('QA fixture blocks real provider access')
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url: url.href, method: options.method ?? 'GET', body })
    if (url.pathname === '/api/tags') return Response.json({ models: ['studio-text:8b', 'studio-vision:27b'].map(name => ({ name })) })
    if (url.pathname === '/api/ps') return Response.json({ models: [...loaded].map(name => ({ name })) })
    if (url.pathname === '/api/generate' && body?.keep_alive === 0) { loaded.delete(body.model); return Response.json({ done: true }) }
    if (url.pathname === '/system_stats' || url.pathname === '/free') return Response.json({})
    if (url.pathname.startsWith('/models/')) {
      const models = modelInventory[url.pathname.slice('/models/'.length)]
      return models ? Response.json(models) : new Response(null, { status: 404 })
    }
    if (url.pathname === '/object_info') return Response.json({
      KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['beta', 'normal']] } } },
      UNETLoader: { input: { required: { unet_name: [['studio-video.safetensors', 'studio-image.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['studio-text-encoder.safetensors']] } } },
      DualCLIPLoader: { input: { required: { clip_name1: [['studio-text-encoder.safetensors']], clip_name2: [['studio-text-encoder.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['studio-vae.safetensors']] } } },
      LoraLoaderModelOnly: { input: { required: { lora_name: [['studio-lora.safetensors']] } } },
    })
    if (url.pathname === '/v1/models') return Response.json({ data: ['studio-chat', 'studio-image'].map(id => ({ id })) })
    throw new Error(`Unsupported QA request: ${url.pathname}`)
  }
  return { providers, fetchImpl, calls, modelInventory }
}
