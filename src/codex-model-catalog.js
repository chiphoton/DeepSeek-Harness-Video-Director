import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { actionableCodexError, assertCodexRuntimeAccess } from './codex-environment.js'
import { codexExecutable } from './codex-executable.js'
import { DirectorInputError } from './validation.js'

/** Read the signed-in CLI's catalog without creating a thread or generating content. */
export async function fetchCodexModels({ signal, executable = codexExecutable(), spawnProcess = spawn, checkAccess = assertCodexRuntimeAccess, timeoutMs = 20_000 } = {}) {
  checkAccess()
  signal?.throwIfAborted()
  const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let sequence = 0
  let received = 0
  let stderr = ''
  let failure
  const rejectPending = error => { failure ??= error; for (const request of pending.values()) request.reject(failure); pending.clear() }
  const abort = () => { rejectPending(signal?.reason ?? new Error('Codex model discovery cancelled.')); child.kill() }
  const timer = setTimeout(() => { rejectPending(new Error('Codex model discovery timed out. Check Codex sign-in and try Refresh models.')); child.kill() }, timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length) })
  child.stdout.on('data', chunk => {
    received += chunk.length
    if (received > 8 * 1024 * 1024) { rejectPending(new Error('Codex model catalog exceeded the response limit.')); child.kill() }
  })
  child.on('error', error => rejectPending(error))
  child.stdin.on('error', error => rejectPending(error))
  child.on('exit', () => {
    const accessError = actionableCodexError(new Error(stderr))
    rejectPending(accessError.code === 'video-director/codex-runtime-permission' ? accessError : new Error('Codex stopped before returning its model catalog. Check the local runtime and sign-in.'))
  })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(`Codex model discovery: ${message.error.message}`))
    else request.resolve(message.result)
  })
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = ++sequence
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
  try {
    await request('initialize', { clientInfo: { name: 'dsh_video_director', title: 'Video Director', version: '0.1.2' } })
    send({ method: 'initialized', params: {} })
    const models = []
    const cursors = new Set()
    let cursor
    do {
      signal?.throwIfAborted()
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(page?.data)) throw new Error('Codex returned an invalid model catalog.')
      models.push(...page.data)
      cursor = page.nextCursor
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || models.length > 1000)) throw new Error('Codex returned invalid model catalog pagination.')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return models
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    lines.close()
    child.stdin.end()
    child.kill()
    const forceStop = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 1000)
    forceStop.unref()
    child.once('exit', () => clearTimeout(forceStop))
  }
}

function normalizeModels(rows) {
  if (!Array.isArray(rows)) throw new Error('Codex returned an invalid model catalog.')
  const models = new Map()
  for (const row of rows) {
    if (!row || row.hidden === true) continue
    const id = row.model ?? row.id
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\x00-\x1f]/u.test(id)) throw new Error('Codex returned an invalid model identifier.')
    if (typeof row.defaultReasoningEffort !== 'string' || !row.defaultReasoningEffort) throw new Error(`Codex did not report a default reasoning effort for ${id}.`)
    const tiers = Array.isArray(row.serviceTiers) ? row.serviceTiers.map(tier => tier?.id) : Array.isArray(row.additionalSpeedTiers) ? row.additionalSpeedTiers : []
    models.set(id, {
      id,
      displayName: typeof row.displayName === 'string' ? row.displayName : id,
      defaultReasoningEffort: row.defaultReasoningEffort,
      inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities.filter(value => typeof value === 'string') : ['text', 'image'],
      fastServiceTier: tiers.includes('priority') ? 'priority' : tiers.includes('fast') ? 'fast' : null,
      isDefault: row.isDefault === true,
    })
  }
  return [...models.values()]
}

/** Shared by workflow generation, chat, and model pickers. Never invents fallback models. */
export class CodexModelCatalog {
  constructor({ cachePath, fetchModels = fetchCodexModels, now = Date.now } = {}) {
    this.cachePath = cachePath
    this.fetchModels = fetchModels
    this.now = now
    this.models = []
    this.fetchedAt = null
    this.source = 'unavailable'
    this.error = null
    this.pending = null
    this.lastAttemptAt = null
    this.controller = new AbortController()
  }

  async init() {
    if (!this.cachePath) return
    try {
      const cache = JSON.parse(await readFile(this.cachePath, 'utf8'))
      if (cache.version !== 1 || !Array.isArray(cache.models) || !Number.isFinite(cache.fetchedAt)) throw new Error('Invalid cache')
      this.models = normalizeModels(cache.models.map(model => ({ ...model, serviceTiers: model.fastServiceTier ? [{ id: model.fastServiceTier }] : [] })))
      this.fetchedAt = cache.fetchedAt
      this.source = 'cache'
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Saved Codex catalog could not be read. Refresh models to reload it.' }
  }

  snapshot() {
    const defaultModel = this.models.find(model => model.isDefault)?.id ?? this.models[0]?.id
    return {
      models: this.models.map(model => model.id),
      codexModels: structuredClone(this.models),
      defaultModel,
      codexCatalog: { source: this.source, fetchedAt: this.fetchedAt, error: this.error },
    }
  }

  async refresh({ force = false } = {}) {
    if (!force && this.source === 'live' && this.now() - this.fetchedAt < 5 * 60_000) return this.snapshot()
    if (!force && this.source === 'cache' && this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < 30_000) return this.snapshot()
    if (this.pending) return this.pending
    this.lastAttemptAt = this.now()
    this.pending = (async () => {
      try {
        const models = normalizeModels(await this.fetchModels({ signal: this.controller.signal }))
        const fetchedAt = this.now()
        this.models = models
        this.fetchedAt = fetchedAt
        this.source = 'live'
        this.error = null
        if (this.cachePath) {
          try {
            await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 })
            await writeFile(`${this.cachePath}.tmp`, JSON.stringify({ version: 1, fetchedAt, models }) + '\n', { mode: 0o600 })
            await rename(`${this.cachePath}.tmp`, this.cachePath)
          } catch { this.error = 'The live model list loaded, but its offline cache could not be saved.' }
        }
      } catch (error) {
        this.error = actionableCodexError(error).message
        this.source = this.fetchedAt === null ? 'unavailable' : 'cache'
        if (this.source === 'unavailable') throw error
      }
      return this.snapshot()
    })()
    try { return await this.pending } finally { this.pending = null }
  }

  async resolve(modelId, { fastMode = false, imageInput = false } = {}) {
    await this.refresh()
    const id = modelId || this.snapshot().defaultModel
    const model = this.models.find(model => model.id === id)
    if (!model) throw new DirectorInputError(id ? `Codex model ${id} is no longer available. Refresh models and select an available model.` : 'No Codex models are available. Check Codex sign-in and refresh models.')
    if (imageInput && !model.inputModalities.includes('image')) throw new DirectorInputError(`Codex model ${id} does not support image references. Select a model with image input.`)
    return { model: model.id, reasoningEffort: model.defaultReasoningEffort, serviceTier: fastMode === true && model.fastServiceTier ? model.fastServiceTier : 'default' }
  }

  async close() {
    this.controller.abort()
    await this.pending?.catch(() => {})
  }
}
