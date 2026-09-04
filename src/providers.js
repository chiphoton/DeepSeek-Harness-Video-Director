import { createHash, randomInt, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { CODEX_PLAN_MODELS, CodexPlanImageRuntime } from './codex-plan-provider.js'
import { DirectorInputError, record, string } from './validation.js'

const MCP_OPERATION_ALLOWLIST = new Set([
  'enqueue_workflow',
  'get_history',
  'get_queue_status',
  'get_workflow_status',
])

const EXTENSION_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
])

const MAX_DISCOVERED_MODELS = 2_048
const MAX_COMFY_MODEL_INPUTS = 1_024
const MAX_MODEL_ID_LENGTH = 512
const MAX_COMFY_SELECTOR_LENGTH = 256
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_COMFY_OBJECT_INFO_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 1024 * 1024

function cleanBaseUrl(value) {
  const raw = String(value).trim()
  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(raw) ? raw : `http://${raw}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DirectorInputError('provider baseUrl must use http or https')
  }
  return url.toString().replace(/\/$/u, '')
}

function textParts(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function dataUrl(mimeType, data) {
  return `data:${mimeType};base64,${data.toString('base64')}`
}

function outputKind(mimeType) {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  throw new Error(`unsupported generated output type ${mimeType}`)
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function uniqueStrings(values, limit = MAX_DISCOVERED_MODELS, project = value => value) {
  const unique = new Set()
  for (const row of values) {
    const value = project(row)
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized === '' || normalized.length > MAX_MODEL_ID_LENGTH) continue
    unique.add(normalized)
    if (unique.size >= limit) break
  }
  return [...unique].sort((left, right) => left.localeCompare(right))
}

function ollamaModelCatalog(values) {
  const rows = Array.isArray(values) ? values : []
  const models = uniqueStrings(rows, MAX_DISCOVERED_MODELS, row => row?.name ?? row?.model)
  const detailsByModel = new Map()
  for (const row of rows) {
    const model = typeof row?.name === 'string'
      ? row.name.trim()
      : typeof row?.model === 'string'
        ? row.model.trim()
        : ''
    if (!models.includes(model) || detailsByModel.has(model)) continue
    const capabilities = uniqueStrings(Array.isArray(row.capabilities) ? row.capabilities : [], 64)
    const contextLength = row?.details?.context_length
    detailsByModel.set(model, {
      id: model,
      capabilities,
      ...(Number.isSafeInteger(contextLength) && contextLength > 0 ? { contextLength } : {}),
    })
  }
  return {
    models,
    modelInputs: [],
    modelDetails: models.map(model => detailsByModel.get(model) ?? { id: model, capabilities: [] }),
  }
}

function ollamaLoadedModels(values) {
  return uniqueStrings(Array.isArray(values) ? values : [], MAX_DISCOVERED_MODELS, row => row?.name ?? row?.model)
}

function comfyStringChoices(schema) {
  if (!Array.isArray(schema)) return undefined
  let values
  if (Array.isArray(schema[0])) {
    values = schema[0]
  } else if (schema[0] === 'COMFY_DYNAMICCOMBO_V3'
    && typeof schema[1] === 'object'
    && schema[1] !== null
    && Array.isArray(schema[1].options)) {
    values = schema[1].options.map(option => (
      typeof option === 'object' && option !== null ? option.key : undefined
    ))
  } else {
    return undefined
  }
  const unique = new Set()
  for (const value of values) {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    if (normalized === '' || normalized.length > MAX_MODEL_ID_LENGTH) continue
    if (unique.size < MAX_DISCOVERED_MODELS) unique.add(normalized)
  }
  return [...unique].sort((left, right) => left.localeCompare(right))
}

function validComfySelector(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_COMFY_SELECTOR_LENGTH
    && !value.includes('\0')
}

function comfyModelCatalog(value) {
  const objectInfo = record(value, 'ComfyUI object_info')
  const modelInputs = []
  const allModels = new Set()
  const seenInputs = new Set()
  for (const [nodeClass, nodeValue] of Object.entries(objectInfo)) {
    if (modelInputs.length >= MAX_COMFY_MODEL_INPUTS) break
    if (!validComfySelector(nodeClass)) continue
    if (typeof nodeValue !== 'object' || nodeValue === null) continue
    const inputGroups = nodeValue.input
    if (typeof inputGroups !== 'object' || inputGroups === null || Array.isArray(inputGroups)) continue
    for (const groupName of ['required', 'optional']) {
      const group = inputGroups[groupName]
      if (typeof group !== 'object' || group === null || Array.isArray(group)) continue
      for (const [input, schema] of Object.entries(group)) {
        if (modelInputs.length >= MAX_COMFY_MODEL_INPUTS) break
        if (!validComfySelector(input)) continue
        const selectorKey = `${nodeClass}\0${input}`
        if (seenInputs.has(selectorKey)) continue
        const models = comfyStringChoices(schema)
        if (models === undefined) continue
        seenInputs.add(selectorKey)
        modelInputs.push({ nodeClass, input, models })
        for (const model of models) {
          if (allModels.size >= MAX_DISCOVERED_MODELS) break
          allModels.add(model)
        }
      }
    }
  }
  modelInputs.sort((left, right) => left.nodeClass.localeCompare(right.nodeClass) || left.input.localeCompare(right.input))
  return { models: [...allModels].sort((left, right) => left.localeCompare(right)), modelInputs }
}

function joinedSignal(signal, timeoutMs) {
  if (timeoutMs === null) return signal
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

async function request(fetchImpl, url, init, options = {}) {
  const signal = joinedSignal(
    options.signal,
    options.timeoutMs === null ? null : options.timeoutMs ?? 120_000,
  )
  const response = await fetchImpl(url, {
    ...init,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`${options.label ?? 'provider'} request failed (${String(response.status)})`)
  }
  return response
}

function abortableWait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('operation cancelled'))
      return
    }
    let timer
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new Error('operation cancelled'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function limitedResponseText(response, maxBytes, label) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`${label} response is too large`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`${label} response is too large`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

function contentType(response, filename) {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (header !== undefined && /^(?:image|audio|video)\//u.test(header)) return header
  return EXTENSION_MIME.get(extname(filename).toLowerCase()) ?? 'application/octet-stream'
}

function cloneWorkflow(value) {
  const workflow = record(value, 'workflow')
  return JSON.parse(JSON.stringify(workflow))
}

function workflowHash(workflow) {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex')
}

function omitWorkflowNode(workflow, nodeId) {
  delete workflow[nodeId]
  for (const nodeValue of Object.values(workflow)) {
    if (typeof nodeValue !== 'object' || nodeValue === null || Array.isArray(nodeValue)) continue
    const inputs = nodeValue.inputs
    if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) continue
    for (const [inputName, value] of Object.entries(inputs)) {
      if (Array.isArray(value) && String(value[0]) === nodeId) delete inputs[inputName]
    }
  }
}

function setWorkflowInput(workflow, binding, values) {
  const nodeId = string(binding.nodeId, 'binding.nodeId', { min: 1, max: 128 })
  const inputName = string(binding.input, 'binding.input', { min: 1, max: 128 })
  const node = record(workflow[nodeId], `workflow[${nodeId}]`)
  const inputs = record(node.inputs, `workflow[${nodeId}].inputs`)
  let value
  switch (binding.from) {
    case 'prompt': value = values.prompt; break
    case 'negativePrompt': value = values.negativePrompt; break
    case 'seed': value = values.seed; break
    case 'width': value = values.width; break
    case 'height': value = values.height; break
    case 'duration': value = values.duration; break
    case 'frames': value = values.frames; break
    case 'fps': value = values.fps; break
    case 'steps': value = values.steps; break
    case 'scheduler': value = values.scheduler; break
    case 'variant': value = values.variant; break
    case 'asset':
    case 'maskAsset': {
      value = values.assets.get(string(binding.assetId, 'binding.assetId', { min: 1, max: 128 }))
      if (value === undefined) throw new DirectorInputError(`binding asset ${String(binding.assetId)} was not uploaded`)
      break
    }
    case 'trimStart': value = values.mediaInput.trim?.start ?? 0; break
    case 'trimEnd': value = values.mediaInput.trim?.end; break
    case 'inputWidth': value = values.mediaInput.transform?.width; break
    case 'inputHeight': value = values.mediaInput.transform?.height; break
    case 'aspectRatio': value = values.mediaInput.transform?.aspectRatio; break
    case 'includeAudio': value = values.mediaInput.includeAudio === true; break
    case 'referenceRole': value = values.mediaInput.role ?? 'visual'; break
    case 'projectId': value = values.projectId; break
    case 'literal': value = binding.value; break
    default: throw new DirectorInputError(`unsupported binding source: ${String(binding.from)}`)
  }
  if (value === undefined) {
    throw new DirectorInputError(`binding ${nodeId}.${inputName} has no value for source ${String(binding.from)}`)
  }
  inputs[inputName] = value
}

function promptIdFrom(value) {
  if (typeof value === 'string') {
    const direct = /prompt[_ ]?id["':=\s]+([0-9a-f-]{8,})/iu.exec(value)?.[1]
    if (direct !== undefined) return direct
    try { return promptIdFrom(JSON.parse(value)) } catch { return undefined }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const row = value
  if (typeof row.prompt_id === 'string' && row.prompt_id.trim() !== '') return row.prompt_id
  if (typeof row.promptId === 'string' && row.promptId.trim() !== '') return row.promptId
  if ('structuredContent' in row) return promptIdFrom(row.structuredContent)
  if ('value' in row) return promptIdFrom(row.value)
  if (Array.isArray(row.content)) {
    for (const part of row.content) {
      const found = promptIdFrom(part?.text ?? part)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function inlineMcpMedia(value) {
  if (typeof value !== 'object' || value === null) return []
  const blocks = Array.isArray(value)
    ? value
    : Array.isArray(value.content)
      ? value.content
      : [value]
  const media = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    if ((block.type === 'image' || block.type === 'audio')
      && typeof block.data === 'string'
      && typeof block.mimeType === 'string') {
      media.push({
        dataBase64: block.data,
        mimeType: block.mimeType,
        name: typeof block.name === 'string' ? basename(block.name) : undefined,
      })
      continue
    }
    if (block.type !== 'resource' || typeof block.resource !== 'object' || block.resource === null) continue
    if (typeof block.resource.blob !== 'string' || typeof block.resource.mimeType !== 'string') continue
    const resourceName = typeof block.resource.name === 'string'
      ? block.resource.name
      : typeof block.resource.uri === 'string'
        ? block.resource.uri.split(/[?#]/u, 1)[0]
        : undefined
    media.push({
      dataBase64: block.resource.blob,
      mimeType: block.resource.mimeType,
      name: resourceName === undefined ? undefined : basename(resourceName),
    })
  }
  return media
}

function submissionStateUnknown(provider) {
  const error = new Error(`${provider.label} may have accepted the MCP enqueue request but returned neither a prompt_id nor identifiable final media. Submission state is unknown; inspect the ComfyUI queue and history before retrying.`)
  error.code = 'video-director/submission-state-unknown'
  error.details = { transport: 'mcp', retryable: false }
  return error
}

export class ProviderRuntime {
  constructor(options) {
    this.store = options.store
    this.registerAsset = options.registerAsset ?? (async () => {})
    this.fetch = options.fetchImpl ?? globalThis.fetch
    this.wait = options.waitImpl ?? abortableWait
    this.tools = options.tools
    this.providers = new Map()
    this.minimaxH3LicenseAccepted = true
    this.codexPlan = new CodexPlanImageRuntime({
      store: this.store,
      registerAsset: this.registerAsset,
      ...(options.createCodex === undefined ? {} : { createCodex: options.createCodex }),
      ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
    })
    this.configure(options.providers, options.minimaxH3LicenseAccepted)
  }

  configure(providers, minimaxH3LicenseAccepted) {
    this.providers = new Map(providers.map(provider => [provider.id, {
      timeoutMs: 120_000,
      pollIntervalMs: 1_500,
      ...provider,
      ...(provider.baseUrl === undefined || provider.baseUrl === '' ? {} : { baseUrl: cleanBaseUrl(provider.baseUrl) }),
      ...(provider.mcpBaseUrl === undefined || provider.mcpBaseUrl === '' ? {} : { mcpBaseUrl: cleanBaseUrl(provider.mcpBaseUrl) }),
    }]))
    this.minimaxH3LicenseAccepted = minimaxH3LicenseAccepted !== false
  }

  publicCatalog() {
    return [...this.providers.values()].map(provider => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: provider.model,
      imageModel: provider.imageModel,
      requiresApiKey: provider.requiresApiKey === true,
      apiKeySet: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
      capabilities: provider.kind === 'ollama'
        ? ['text', 'vision']
        : provider.kind === 'codex-plan'
          ? ['text', 'image']
        : provider.kind === 'openai-compatible'
          ? ['text', 'vision', 'image']
          : ['image', 'audio', 'video', 'workflow'],
      configured: provider.kind === 'openai-compatible'
        ? provider.requiresApiKey !== true || (typeof provider.apiKey === 'string' && provider.apiKey.length > 0)
        : provider.kind === 'ollama'
          ? typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0
        : provider.kind === 'comfyui-mcp'
          ? typeof provider.mcpTool === 'string' && provider.mcpTool.length > 0 && this.tools !== undefined
          : provider.kind === 'comfyui'
            ? typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0
            : true,
      minimaxH3Unlocked: this.minimaxH3LicenseAccepted,
      ...(provider.kind === 'codex-plan' ? { availableModels: [...CODEX_PLAN_MODELS] } : {}),
    }))
  }

  async check(providerId, signal) {
    const provider = this.#provider(providerId)
    const startedAt = Date.now()
    let catalog = { models: [], modelInputs: [] }
    let transport
    if (provider.kind === 'codex-plan') {
      catalog = { models: [...CODEX_PLAN_MODELS], modelInputs: [] }
      transport = 'codex-sdk'
    } else if (provider.kind === 'ollama' || provider.kind === 'openai-compatible') {
      catalog = await this.models(providerId, signal)
    } else if (provider.kind === 'comfyui-mcp') {
      if (this.tools === undefined) throw new Error('DSH tools service is not available for ComfyUI MCP')
      await this.#callMcp(provider, 'get_queue_status', {}, signal)
      transport = 'mcp'
      if (provider.baseUrl !== undefined) {
        await request(this.fetch, `${provider.baseUrl}/system_stats`, { headers: this.#headers(provider) }, {
          signal,
          timeoutMs: Math.min(provider.timeoutMs, 15_000),
          label: `${provider.label} REST companion`,
        })
      }
    } else if (provider.kind === 'comfyui') {
      if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires a REST endpoint`)
      await request(this.fetch, `${provider.baseUrl}/system_stats`, { headers: this.#headers(provider) }, {
        signal,
        timeoutMs: Math.min(provider.timeoutMs, 15_000),
        label: provider.label,
      })
      transport = await this.#mcpReady(provider, signal) ? 'mcp' : 'rest'
    } else if (provider.baseUrl !== undefined) {
      await request(this.fetch, `${provider.baseUrl}/system_stats`, { headers: this.#headers(provider) }, {
        signal,
        timeoutMs: Math.min(provider.timeoutMs, 15_000),
        label: provider.label,
      })
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      ...catalog,
      ...(transport === undefined ? {} : { transport }),
    }
  }

  async models(providerId, signal) {
    const provider = this.#provider(providerId)
    const timeoutMs = Math.min(provider.timeoutMs, 15_000)
    if (provider.kind === 'codex-plan') {
      return { models: [...CODEX_PLAN_MODELS], modelInputs: [] }
    }
    if (provider.kind === 'ollama') {
      if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires an Ollama endpoint`)
      const response = await request(this.fetch, `${provider.baseUrl}/api/tags`, { headers: this.#headers(provider) }, {
        signal, timeoutMs, label: `${provider.label} model discovery`,
      })
      const body = parseJsonText(
        await limitedResponseText(response, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} model discovery`),
        provider.label,
      )
      const runningResponse = await request(this.fetch, `${provider.baseUrl}/api/ps`, { headers: this.#headers(provider) }, {
        signal, timeoutMs, label: `${provider.label} running model discovery`,
      })
      const runningBody = parseJsonText(
        await limitedResponseText(runningResponse, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} running model discovery`),
        provider.label,
      )
      return { ...ollamaModelCatalog(body.models), loadedModels: ollamaLoadedModels(runningBody.models) }
    }
    if (provider.kind === 'openai-compatible') {
      if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires an API endpoint`)
      const response = await request(this.fetch, `${provider.baseUrl}/models`, { headers: this.#headers(provider) }, {
        signal, timeoutMs, label: `${provider.label} model discovery`,
      })
      const body = parseJsonText(
        await limitedResponseText(response, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} model discovery`),
        provider.label,
      )
      return {
        models: uniqueStrings(Array.isArray(body.data) ? body.data : [], MAX_DISCOVERED_MODELS, row => row?.id),
        modelInputs: [],
      }
    }
    if (provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp') {
      if (provider.baseUrl === undefined) return { models: [], modelInputs: [] }
      const response = await request(this.fetch, `${provider.baseUrl}/object_info`, { headers: this.#headers(provider) }, {
        signal, timeoutMs, label: `${provider.label} model discovery`,
      })
      const text = await limitedResponseText(
        response,
        MAX_COMFY_OBJECT_INFO_RESPONSE_BYTES,
        `${provider.label} object_info`,
      )
      return comfyModelCatalog(parseJsonText(text, `${provider.label} object_info`))
    }
    return { models: [], modelInputs: [] }
  }

  async modelStatus(providerId, model, signal) {
    const provider = this.#provider(providerId)
    if (provider.kind !== 'ollama') throw new DirectorInputError(`${provider.label} does not support model status checks`)
    if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires an Ollama endpoint`)
    const selectedModel = string(model, 'model', { min: 1, max: MAX_MODEL_ID_LENGTH })
    const response = await request(this.fetch, `${provider.baseUrl}/api/ps`, { headers: this.#headers(provider) }, {
      signal,
      timeoutMs: Math.min(provider.timeoutMs, 15_000),
      label: `${provider.label} running model discovery`,
    })
    const body = parseJsonText(
      await limitedResponseText(response, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} running model discovery`),
      provider.label,
    )
    return { model: selectedModel, loaded: ollamaLoadedModels(body.models).includes(selectedModel) }
  }

  async unloadModel(providerId, model, signal) {
    const provider = this.#provider(providerId)
    if (provider.kind !== 'ollama') throw new DirectorInputError(`${provider.label} does not support unloading models`)
    if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires an Ollama endpoint`)
    const selectedModel = string(model, 'model', { min: 1, max: MAX_MODEL_ID_LENGTH })
    const response = await request(this.fetch, `${provider.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selectedModel, keep_alive: 0, stream: false }),
    }, {
      signal,
      timeoutMs: Math.min(provider.timeoutMs, 30_000),
      label: `${provider.label} model unload`,
    })
    await limitedResponseText(response, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} model unload`)
    return this.modelStatus(providerId, selectedModel, signal)
  }

  async runTrigger(action, options = {}, signal) {
    if (action === 'skip') {
      return { action: 'skip', message: 'VRAM trigger bypassed; no action was taken.' }
    }
    if (action === 'ollama-eject') return this.#ejectOllamaModels(signal)
    if (action === 'comfyui-clear') return this.#clearComfyUi(options.releaseWaitSeconds ?? 10, signal)
    throw new DirectorInputError(`unknown VRAM trigger action: ${String(action)}`)
  }

  async #ejectOllamaModels(signal) {
    const targets = [...this.providers.values()].filter(provider => (
      provider.kind === 'ollama' && typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0
    ))
    if (targets.length === 0) throw new Error('No configured Ollama provider is available for model eject.')
    const unloaded = []
    for (const provider of targets) {
      const catalog = await this.models(provider.id, signal)
      for (const model of catalog.loadedModels ?? []) {
        const status = await this.unloadModel(provider.id, model, signal)
        if (status.loaded) throw new Error(`${provider.label} did not confirm that ${model} was unloaded.`)
        unloaded.push({ providerId: provider.id, model })
      }
    }
    return {
      action: 'ollama-eject',
      unloaded,
      message: unloaded.length === 0
        ? 'Ollama already has no loaded models.'
        : `Ollama confirmed ${String(unloaded.length)} model${unloaded.length === 1 ? '' : 's'} unloaded.`,
    }
  }

  async #clearComfyUi(releaseWaitSeconds, signal) {
    const byEndpoint = new Map()
    for (const provider of this.providers.values()) {
      if ((provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp')
        && typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0) {
        byEndpoint.set(provider.baseUrl, provider)
      }
    }
    const targets = [...byEndpoint.values()]
    if (targets.length === 0) throw new Error('No configured ComfyUI REST endpoint is available for model unload.')
    for (const provider of targets) {
      const response = await request(this.fetch, `${provider.baseUrl}/free`, {
        method: 'POST',
        headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      }, {
        signal,
        timeoutMs: Math.min(provider.timeoutMs, 30_000),
        label: `${provider.label} model unload and cache clear`,
      })
      await limitedResponseText(response, MAX_MODEL_DISCOVERY_RESPONSE_BYTES, `${provider.label} model unload and cache clear`)
    }
    // ComfyUI's /free route acknowledges the request after setting executor
    // flags; it does not expose a completion token. Give the executor loop a
    // user-configured, bounded grace period before downstream work can start.
    const waitedMs = releaseWaitSeconds * 1_000
    await this.wait(waitedMs, signal)
    return {
      action: 'comfyui-clear',
      endpoints: targets.map(provider => provider.baseUrl),
      waitedMs,
      message: `ComfyUI accepted model unload and executor-cache cleanup; waited ${String(releaseWaitSeconds)} seconds.`,
    }
  }

  async transcribe(providerId, inputValue, signal) {
    const provider = this.#provider(providerId)
    if (provider.kind !== 'openai-compatible') {
      throw new DirectorInputError(`${provider.label} does not support OpenAI-compatible audio transcription`)
    }
    if (provider.baseUrl === undefined) throw new Error(`${provider.label} requires an API endpoint`)
    if (provider.requiresApiKey === true && (typeof provider.apiKey !== 'string' || provider.apiKey.length === 0)) {
      throw new DirectorInputError(`${provider.label} requires an API key for audio transcription`)
    }
    const input = record(inputValue, 'audio transcription')
    const model = string(input.model, 'audio transcription model', { min: 1, max: MAX_MODEL_ID_LENGTH })
    const name = string(input.name, 'audio file name', { min: 1, max: 512 })
    const mimeType = string(input.mimeType, 'audio MIME type', { min: 1, max: 128 }).split(';', 1)[0].trim().toLowerCase()
    if (!mimeType.startsWith('audio/') && mimeType !== 'video/mp4' && mimeType !== 'video/webm') {
      throw new DirectorInputError('audio transcription requires an audio file')
    }
    const encoded = string(input.dataBase64, 'audio data', {
      min: 1,
      max: Math.ceil(MAX_TRANSCRIPTION_AUDIO_BYTES / 3) * 4,
      trim: false,
    })
    const data = Buffer.from(encoded, 'base64')
    if (data.length === 0 || data.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw new DirectorInputError('audio transcription file must be between 1 byte and 25 MiB')
    }
    if (data.toString('base64') !== encoded) {
      throw new DirectorInputError('audio transcription data must be canonical base64')
    }
    const form = new FormData()
    form.set('file', new Blob([data], { type: mimeType }), name)
    form.set('model', model)
    form.set('response_format', 'json')
    const response = await request(this.fetch, `${provider.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: this.#headers(provider),
      body: form,
    }, { signal, timeoutMs: provider.timeoutMs, label: `${provider.label} audio transcription` })
    const body = parseJsonText(
      await limitedResponseText(response, MAX_TRANSCRIPTION_RESPONSE_BYTES, `${provider.label} audio transcription`),
      `${provider.label} audio transcription`,
    )
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') throw new Error(`${provider.label} returned no transcription text`)
    return { text }
  }

  async run(input, signal, progress = () => {}) {
    const requestValue = record(input, 'workflow request')
    if (requestValue.modelFamily === 'minimax-h3' && !this.minimaxH3LicenseAccepted) {
      const error = new Error('MiniMax H3 is locked because minimaxH3LicenseAccepted is disabled; review the model license and AUP before enabling it')
      error.code = 'video-director/minimax-license-required'
      throw error
    }
    if (requestValue.modelFamily === 'minimax-h3') {
      const width = Number(requestValue.width ?? 1280)
      const height = Number(requestValue.height ?? 704)
      const duration = Number(requestValue.duration ?? 6)
      const fps = Number(requestValue.fps ?? 24)
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width % 32 !== 0 || height % 32 !== 0) {
        throw new DirectorInputError('MiniMax H3 width and height must be positive multiples of 32')
      }
      if (requestValue.operation === 'audio-generation' && (width !== 32 || height !== 32)) {
        throw new DirectorInputError('MiniMax H3 audio-only workflows must use the disposable 32x32 latent')
      }
      if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
        throw new DirectorInputError('MiniMax H3 duration must be greater than 0 and at most 15 seconds')
      }
      if (fps !== 24) throw new DirectorInputError('MiniMax H3 workflows run at 24 fps')
      const variant = requestValue.variant ?? (requestValue.turbo === true ? 'turbo' : 'standard')
      if (variant !== 'standard' && variant !== 'turbo') {
        throw new DirectorInputError('MiniMax H3 variant must be standard or turbo')
      }
      if (variant === 'turbo') {
        const steps = Number(requestValue.steps ?? 6)
        if (!Number.isSafeInteger(steps) || steps < 4 || steps > 8) {
          throw new DirectorInputError('MiniMax H3 Turbo steps must be an integer from 4 to 8')
        }
        if ((requestValue.scheduler ?? 'simple') !== 'simple') {
          throw new DirectorInputError('MiniMax H3 Turbo requires the simple scheduler')
        }
        requestValue.steps = steps
        requestValue.scheduler = 'simple'
      }
      const requestedFrames = Math.max(1, Math.round(duration * 24))
      const frameCount = Math.max(5, Math.ceil((requestedFrames - 5) / 17) * 17 + 5)
      requestValue.frameCount = frameCount
      requestValue.actualDuration = frameCount / 24
      requestValue.experimentalDuration = duration < 5
    }
    const provider = this.#provider(string(requestValue.providerId, 'providerId', { min: 1, max: 128 }))
    if ((requestValue.operation === 'prompt-enhancer' || requestValue.operation === 'text-generation') && provider.kind === 'codex-plan') {
      return this.codexPlan.runText(provider, requestValue, signal, progress)
    }
    if (requestValue.operation === 'prompt-enhancer' || requestValue.operation === 'text-generation') {
      return this.#text(provider, requestValue, signal)
    }
    if (requestValue.operation === 'image-generation' && provider.kind === 'openai-compatible') {
      return this.#openAiImage(provider, requestValue, signal)
    }
    if (requestValue.operation === 'image-generation' && provider.kind === 'codex-plan') {
      return this.codexPlan.run(provider, requestValue, signal, progress)
    }
    if (provider.kind === 'comfyui') {
      if (await this.#mcpReady(provider, signal)) {
        // The read-only probe is the only safe fallback point. Once MCP enqueue
        // starts, an ambiguous failure may still have submitted the workflow,
        // so it must propagate instead of being retried through REST.
        return this.#comfyMcp(provider, requestValue, signal, progress)
      }
      return this.#comfy(provider, requestValue, signal, progress)
    }
    if (provider.kind === 'comfyui-mcp') {
      return this.#comfyMcp(provider, requestValue, signal, progress)
    }
    throw new DirectorInputError(`${provider.label} cannot run ${String(requestValue.operation)}`)
  }

  async #text(provider, input, signal) {
    const prompt = string(input.prompt ?? '', 'prompt', { min: 1, max: 100_000 })
    const defaultInstruction = input.operation === 'prompt-enhancer'
      ? 'Expand the production prompt with concrete subject, action, camera, lighting, sound, timing, and negative constraints. Preserve the user intent. Return only the enhanced prompt.'
      : 'Follow the user request and return useful production text.'
    const systemPrompt = typeof input.systemPrompt === 'string' && input.systemPrompt.trim() !== ''
      ? string(input.systemPrompt, 'system prompt', { min: 1, max: 100_000 })
      : defaultInstruction
    let contextLength
    if (input.contextLength !== undefined) {
      if (!Number.isSafeInteger(input.contextLength) || input.contextLength < 1 || input.contextLength > 4_194_304) {
        throw new DirectorInputError('context length must be a positive safe integer no greater than 4194304')
      }
      contextLength = input.contextLength
    }
    if (input.thinking !== undefined && typeof input.thinking !== 'boolean') {
      throw new DirectorInputError('thinking must be a boolean')
    }
    const context = typeof input.context === 'string' && input.context.trim() !== ''
      ? `\n\nConnected-node context:\n${input.context}`
      : ''
    const imageParts = []
    for (const assetId of Array.isArray(input.assetIds) ? input.assetIds : []) {
      const { asset, data } = await this.store.assetBytes(assetId)
      if (asset.kind !== 'image' && asset.kind !== 'sketch' && asset.kind !== 'mask') continue
      imageParts.push({ asset, data })
    }
    if (provider.kind === 'ollama') {
      const response = await request(this.fetch, `${provider.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model ?? provider.model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `${prompt}${context}`,
              ...(imageParts.length === 0 ? {} : { images: imageParts.map(row => row.data.toString('base64')) }),
            },
          ],
          ...(contextLength === undefined ? {} : { options: { num_ctx: contextLength } }),
          ...(input.thinking === undefined ? {} : { think: input.thinking }),
        }),
      }, { signal, timeoutMs: null, label: provider.label })
      const body = parseJsonText(await response.text(), provider.label)
      const text = body?.message?.content
      if (typeof text !== 'string' || text.trim() === '') throw new Error(`${provider.label} returned no text`)
      return { kind: 'text', text: text.trim(), providerId: provider.id }
    }
    if (provider.kind !== 'openai-compatible') {
      throw new DirectorInputError(`${provider.label} does not support text generation`)
    }
    const content = [
      { type: 'text', text: `${systemPrompt}\n\n${prompt}${context}` },
      ...imageParts.map(({ asset, data }) => ({
        type: 'image_url',
        image_url: { url: dataUrl(asset.mimeType, data) },
      })),
    ]
    const response = await request(this.fetch, `${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model ?? provider.model,
        messages: [{ role: 'user', content }],
      }),
    }, { signal, timeoutMs: null, label: provider.label })
    const body = parseJsonText(await response.text(), provider.label)
    const message = body?.choices?.[0]?.message?.content
    const text = typeof message === 'string' ? message : textParts(message)
    if (text.trim() === '') throw new Error(`${provider.label} returned no text`)
    return { kind: 'text', text: text.trim(), providerId: provider.id }
  }

  async #openAiImage(provider, input, signal) {
    const prompt = string(input.prompt ?? '', 'prompt', { min: 1, max: 100_000 })
    const model = string(input.model ?? provider.imageModel, 'image model', { min: 1, max: 256 })
    const mediaInputs = Array.isArray(input.mediaInputs) ? input.mediaInputs.filter(row => row !== null && typeof row === 'object') : []
    const sourceId = mediaInputs.map(row => row.assetId).find(id => typeof id === 'string')
    const maskId = mediaInputs.map(row => row.maskAssetId).find(id => typeof id === 'string')
    let response
    if (sourceId !== undefined) {
      const source = await this.store.assetBytes(sourceId)
      if (source.asset.kind !== 'image' && source.asset.kind !== 'sketch') {
        throw new DirectorInputError('OpenAI-compatible image edits require an image or sketch input')
      }
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', prompt)
      form.set('image', new Blob([source.data], { type: source.asset.mimeType }), source.asset.name)
      form.set('n', '1')
      form.set('size', String(input.size ?? `${String(input.width ?? 1024)}x${String(input.height ?? 1024)}`))
      form.set('response_format', 'b64_json')
      if (input.quality !== undefined) form.set('quality', String(input.quality))
      if (maskId !== undefined) {
        const mask = await this.store.assetBytes(maskId)
        if (mask.asset.kind !== 'mask' || mask.asset.mimeType !== 'image/png') {
          throw new DirectorInputError('OpenAI-compatible image edit masks must be PNG mask assets')
        }
        form.set('mask', new Blob([mask.data], { type: mask.asset.mimeType }), mask.asset.name)
      }
      response = await request(this.fetch, `${provider.baseUrl}/images/edits`, {
        method: 'POST',
        headers: this.#headers(provider),
        body: form,
      }, { signal, timeoutMs: null, label: provider.label })
    } else {
      response = await request(this.fetch, `${provider.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size: input.size ?? `${String(input.width ?? 1024)}x${String(input.height ?? 1024)}`,
          ...(input.quality === undefined ? {} : { quality: input.quality }),
          response_format: 'b64_json',
        }),
      }, { signal, timeoutMs: null, label: provider.label })
    }
    const body = parseJsonText(await response.text(), provider.label)
    const output = body?.data?.[0]
    let bytes
    let mimeType = 'image/png'
    if (typeof output?.b64_json === 'string') {
      bytes = Buffer.from(output.b64_json, 'base64')
    } else if (typeof output?.url === 'string') {
      const downloaded = await request(this.fetch, output.url, {}, {
        signal,
        timeoutMs: null,
        label: `${provider.label} image download`,
      })
      mimeType = contentType(downloaded, new URL(output.url).pathname)
      bytes = Buffer.from(await downloaded.arrayBuffer())
    } else {
      throw new Error(`${provider.label} returned no image`)
    }
    const asset = await this.store.putAsset({
      projectId: input.projectId,
      kind: 'image',
      name: `generated-${Date.now()}.${MIME_EXTENSIONS_FOR_NAME(mimeType)}`,
      mimeType,
      dataBase64: bytes.toString('base64'),
    })
    await this.registerAsset(asset)
    return { kind: 'assets', assets: [asset], providerId: provider.id }
  }

  async #comfy(provider, input, signal, progress) {
    const seed = Number.isSafeInteger(input.seed) ? input.seed : randomInt(0, 2_147_483_647)
    progress({ phase: 'uploading', progress: 0.05 })
    const uploaded = await this.#uploadComfyInputs(provider, input.assetIds, signal)
    const workflow = this.#compileWorkflow(input, seed, uploaded)
    progress({ phase: 'queued', progress: 0.12 })
    const response = await request(this.fetch, `${provider.baseUrl}/prompt`, {
      method: 'POST',
      headers: { ...this.#headers(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: `dsh-video-director-${randomUUID()}` }),
    }, { signal, timeoutMs: null, label: provider.label })
    const queued = parseJsonText(await response.text(), provider.label)
    const promptId = promptIdFrom(queued)
    if (promptId === undefined) throw new Error(`${provider.label} returned no prompt_id`)
    await progress({
      phase: 'running', progress: 0.15, promptId, seed,
      compiledWorkflowHash: workflowHash(workflow),
    })
    const history = await this.#waitForHistory(provider, promptId, signal, progress)
    const assets = await this.#collectComfyOutputs(provider, input.projectId, promptId, history, signal)
    return {
      kind: 'assets', assets, providerId: provider.id, promptId, seed,
      transport: 'rest',
      actualDuration: input.actualDuration,
      frameCount: input.frameCount,
      experimentalDuration: input.experimentalDuration,
    }
  }

  async #comfyMcp(provider, input, signal, progress) {
    if (this.tools === undefined) throw new Error('DSH tools service is not available for ComfyUI MCP')
    const seed = Number.isSafeInteger(input.seed) ? input.seed : randomInt(0, 2_147_483_647)
    const uploaded = provider.baseUrl === undefined
      ? new Map()
      : await this.#uploadComfyInputs(provider, input.assetIds, signal)
    const workflow = this.#compileWorkflow(input, seed, uploaded)
    progress({ phase: 'queued', progress: 0.1 })
    const result = await this.#callMcp(provider, 'enqueue_workflow', {
      workflow,
      disable_random_seed: true,
    }, signal)
    const promptId = promptIdFrom(result)
    const compiledWorkflowHash = workflowHash(workflow)
    const directAssets = await this.#importMcpFinalAssets(provider, input.projectId, result)
    if (directAssets.length > 0) {
      await progress({
        phase: 'completed', progress: 0.99,
        ...(promptId === undefined ? {} : { promptId }), seed, compiledWorkflowHash,
      })
      return {
        kind: 'assets', assets: directAssets, providerId: provider.id, promptId, seed,
        transport: 'mcp',
        actualDuration: input.actualDuration,
        frameCount: input.frameCount,
        experimentalDuration: input.experimentalDuration,
      }
    }
    if (promptId === undefined) {
      await progress({
        phase: 'submission-state-unknown', progress: 0.15, seed, compiledWorkflowHash,
      })
      throw submissionStateUnknown(provider)
    }
    await progress({
      phase: 'running', progress: 0.15, promptId, seed, compiledWorkflowHash,
    })
    if (provider.baseUrl === undefined) {
      return {
        kind: 'mcp-result', result, providerId: provider.id, promptId, seed,
        transport: 'mcp',
        actualDuration: input.actualDuration,
        frameCount: input.frameCount,
        experimentalDuration: input.experimentalDuration,
      }
    }
    // comfyui-mcp completion messages are not a DSH transport. Poll the exact
    // prompt history and use the REST response to recover video and SaveAudio outputs.
    const history = await this.#waitForHistory(provider, promptId, signal, progress)
    const assets = await this.#collectComfyOutputs(provider, input.projectId, promptId, history, signal)
    return {
      kind: 'assets', assets, providerId: provider.id, promptId, seed, mcp: true,
      transport: 'mcp',
      actualDuration: input.actualDuration,
      frameCount: input.frameCount,
      experimentalDuration: input.experimentalDuration,
    }
  }

  async #importMcpFinalAssets(provider, projectId, result) {
    const media = inlineMcpMedia(result)
    const assets = []
    for (const [index, item] of media.entries()) {
      let kind
      try {
        kind = outputKind(item.mimeType)
      } catch {
        continue
      }
      const asset = await this.store.putAsset({
        projectId,
        kind,
        name: item.name || `mcp-output-${String(index + 1)}.${MIME_EXTENSIONS_FOR_NAME(item.mimeType)}`,
        mimeType: item.mimeType,
        dataBase64: item.dataBase64,
      })
      await this.registerAsset(asset)
      assets.push(asset)
    }
    return assets
  }

  async #callMcp(provider, operation, args, signal) {
    if (!MCP_OPERATION_ALLOWLIST.has(operation)) {
      throw new Error(`ComfyUI MCP operation ${operation} is not allowed by Video Director`)
    }
    const outcome = await this.tools.execute({
      signal,
      callId: `video-director-${randomUUID()}`,
      name: provider.mcpTool,
      arguments: provider.mcpTool.endsWith('__call_tool')
        ? { name: operation, args }
        : args,
    })
    if (outcome?.isError === true) {
      const message = outcome?.error?.message ?? textParts(outcome?.content) ?? 'ComfyUI MCP call failed'
      throw new Error(message)
    }
    return outcome?.value ?? outcome
  }

  async #mcpReady(provider, signal) {
    if (this.tools === undefined
      || typeof provider.mcpTool !== 'string'
      || provider.mcpTool.length === 0
      || typeof provider.baseUrl !== 'string'
      || typeof provider.mcpBaseUrl !== 'string'
      || provider.baseUrl !== provider.mcpBaseUrl) {
      return false
    }
    try {
      await this.#callMcp(provider, 'get_queue_status', {}, signal)
      return true
    } catch (error) {
      if (signal?.aborted === true || error?.name === 'AbortError') throw error
      return false
    }
  }

  #compileWorkflow(input, seed, uploaded) {
    const workflow = cloneWorkflow(input.workflow)
    const values = {
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : '',
      seed,
      width: input.width ?? 1280,
      height: input.height ?? 704,
      duration: input.duration ?? 6,
      frames: input.frameCount,
      fps: input.fps ?? 24,
      steps: input.steps,
      scheduler: input.scheduler,
      variant: input.variant,
      assets: uploaded,
      mediaInput: {},
      projectId: input.projectId,
    }
    if (!Array.isArray(input.bindings)) throw new DirectorInputError('bindings must be an array')
    for (const bindingValue of input.bindings) {
      const binding = record(bindingValue, 'binding')
      const mediaIndex = binding.mediaIndex === undefined ? 0 : Number(binding.mediaIndex)
      if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 0) {
        throw new DirectorInputError('binding.mediaIndex must be a non-negative integer')
      }
      values.mediaInput = Array.isArray(input.mediaInputs) && input.mediaInputs[mediaIndex] !== undefined
        ? record(input.mediaInputs[mediaIndex], `mediaInputs[${String(mediaIndex)}]`)
        : {}
      if ((binding.from === 'asset' || binding.from === 'maskAsset')
        && binding.optional === true
        && binding.assetId === undefined) {
        if (binding.omitNodeWhenMissing === true) {
          const omittedNodeIds = Array.isArray(binding.omitNodeIdsWhenMissing)
            ? binding.omitNodeIdsWhenMissing
            : [binding.nodeId]
          for (const omittedNodeId of omittedNodeIds) omitWorkflowNode(workflow, String(omittedNodeId))
        }
        else {
          const node = workflow[String(binding.nodeId)]
          if (typeof node?.inputs === 'object' && node.inputs !== null) delete node.inputs[String(binding.input)]
        }
        continue
      }
      setWorkflowInput(workflow, binding, values)
    }
    return workflow
  }

  async #uploadComfyInputs(provider, assetIds, signal) {
    const uploaded = new Map()
    for (const assetId of Array.isArray(assetIds) ? assetIds : []) {
      const { asset, data } = await this.store.assetBytes(assetId)
      const form = new FormData()
      form.set('image', new Blob([data], { type: asset.mimeType }), asset.name)
      form.set('overwrite', 'false')
      const response = await request(this.fetch, `${provider.baseUrl}/upload/image`, {
        method: 'POST',
        headers: this.#headers(provider),
        body: form,
      }, { signal, timeoutMs: null, label: `${provider.label} upload` })
      const body = parseJsonText(await response.text(), `${provider.label} upload`)
      const name = body?.name
      if (typeof name !== 'string') throw new Error(`${provider.label} upload returned no name`)
      uploaded.set(assetId, body?.subfolder ? `${body.subfolder}/${name}` : name)
    }
    return uploaded
  }

  async #waitForHistory(provider, promptId, signal, progress) {
    let attempt = 0
    while (true) {
      if (signal?.aborted === true) throw signal.reason ?? new Error('workflow cancelled')
      const response = await request(this.fetch, `${provider.baseUrl}/history/${encodeURIComponent(promptId)}`, {
        headers: this.#headers(provider),
      }, {
        signal,
        timeoutMs: null,
        label: `${provider.label} history`,
      })
      const body = parseJsonText(await response.text(), `${provider.label} history`)
      const history = body?.[promptId] ?? body
      if (history?.outputs !== undefined) return history
      attempt += 1
      progress({ phase: 'running', progress: Math.min(0.9, 0.15 + attempt * 0.025) })
      await new Promise((resolve, reject) => {
        let timer
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        const onAbort = () => {
          clearTimeout(timer)
          cleanup()
          reject(signal?.reason ?? new Error('workflow cancelled'))
        }
        timer = setTimeout(() => {
          cleanup()
          resolve()
        }, provider.pollIntervalMs)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  async #collectComfyOutputs(provider, projectId, promptId, history, signal) {
    const descriptors = []
    for (const output of Object.values(history.outputs ?? {})) {
      if (typeof output !== 'object' || output === null) continue
      for (const field of ['images', 'videos', 'gifs', 'audio']) {
        const rows = output[field]
        if (!Array.isArray(rows)) continue
        for (const row of rows) {
          if (typeof row?.filename !== 'string') continue
          descriptors.push({
            filename: row.filename,
            subfolder: typeof row.subfolder === 'string' ? row.subfolder : '',
            type: typeof row.type === 'string' ? row.type : 'output',
          })
        }
      }
    }
    const assets = []
    for (const descriptor of descriptors) {
      const query = new URLSearchParams({
        filename: descriptor.filename,
        subfolder: descriptor.subfolder,
        type: descriptor.type,
      })
      const response = await request(this.fetch, `${provider.baseUrl}/view?${query.toString()}`, {
        headers: this.#headers(provider),
      }, {
        signal,
        timeoutMs: null,
        label: `${provider.label} output`,
      })
      const mimeType = contentType(response, descriptor.filename)
      if (mimeType === 'application/octet-stream') continue
      const data = Buffer.from(await response.arrayBuffer())
      const asset = await this.store.putAsset({
        projectId,
        kind: outputKind(mimeType),
        name: basename(descriptor.filename),
        mimeType,
        dataBase64: data.toString('base64'),
      })
      await this.registerAsset(asset)
      assets.push(asset)
    }
    if (assets.length === 0) {
      throw new Error(`ComfyUI workflow ${promptId} completed without supported image, audio, or video outputs`)
    }
    return assets
  }

  #provider(providerId) {
    const provider = this.providers.get(providerId)
    if (provider === undefined) throw new DirectorInputError(`unknown provider: ${providerId}`)
    return provider
  }

  #headers(provider) {
    return typeof provider.apiKey === 'string' && provider.apiKey.length > 0
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {}
  }
}

function MIME_EXTENSIONS_FOR_NAME(mimeType) {
  for (const [extension, candidate] of EXTENSION_MIME) {
    if (candidate === mimeType) return extension.slice(1)
  }
  return 'bin'
}
