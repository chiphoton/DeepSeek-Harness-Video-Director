import { createHash, randomUUID } from 'node:crypto'
import { DirectorInputError, jsonValue, record, string, uuid } from './validation.js'

const OPERATIONS = new Set([
  'prompt-enhancer',
  'text-generation',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
])
const OUTPUT_TYPES = new Set(['text', 'image', 'audio', 'video', 'sketch', 'mask'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned'])
const PERSISTED_JOB_LIMIT = 100
const DEFAULT_TERMINAL_CACHE_LIMIT = 256
// Registry workflows can contain up to 20 MiB before the Host adds resolved
// bindings and run metadata. Keep the immutable manager clone bounded without
// rejecting a workflow that the registry already accepted.
const MAX_JOB_REQUEST_BYTES = 32 * 1024 * 1024

function sourceRevision(value) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DirectorInputError('sourceRevision must be a positive safe integer')
  }
  return value
}

function normalizeExpectedOutputTypes(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > OUTPUT_TYPES.size) {
    throw new DirectorInputError('expectedOutputTypes must be an array of supported output types')
  }
  const normalized = value.map((entry, index) => string(entry, `expectedOutputTypes[${String(index)}]`, { min: 1, max: 16 }))
  for (const type of normalized) {
    if (!OUTPUT_TYPES.has(type)) throw new DirectorInputError(`unsupported expected output type: ${type}`)
  }
  return [...new Set(normalized)]
}

function outputTypeFailure(expected, actual, message) {
  const error = new Error(message)
  error.code = 'video-director/output-type-unsupported'
  error.details = { expectedOutputTypes: expected, actualOutputTypes: actual }
  throw error
}

function validateProviderResult(store, projectId, expected, result) {
  if (expected === undefined) return result
  if (result === null || typeof result !== 'object') {
    outputTypeFailure(expected, [], 'provider returned no typed output')
  }
  let actual
  let canonicalResult = result
  if (result.kind === 'text') {
    if (typeof result.text !== 'string') {
      outputTypeFailure(expected, [], 'provider returned a text result without text')
    }
    actual = ['text']
  } else if (result.kind === 'mcp-result') {
    // An opaque MCP completion has no imported media. The Host exposes its
    // JSON payload as text, so it cannot satisfy an image/audio/video port.
    if (!Object.hasOwn(result, 'result') || result.result === undefined) {
      outputTypeFailure(expected, [], 'provider returned an empty MCP result')
    }
    actual = ['text']
  } else if (result.kind === 'assets') {
    if (!Array.isArray(result.assets) || result.assets.length === 0) {
      outputTypeFailure(expected, [], 'provider returned an empty asset result')
    }
    const assets = result.assets.map((candidate) => {
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.id !== 'string') {
        outputTypeFailure(expected, [], 'provider returned an asset without a stored asset id')
      }
      let asset
      try {
        asset = store.asset(candidate.id)
      } catch {
        outputTypeFailure(expected, [], `provider returned unknown asset ${candidate.id}`)
      }
      if (asset.projectId !== projectId) {
        outputTypeFailure(expected, [asset.kind], `provider returned asset ${asset.id} from another Video Project`)
      }
      return asset
    })
    actual = assets.map(asset => asset.kind)
    canonicalResult = { ...result, assets }
  } else {
    outputTypeFailure(expected, [], `provider returned unsupported result kind ${String(result.kind)}`)
  }
  const uniqueActual = [...new Set(actual)]
  const unsupported = uniqueActual.filter(type => !expected.includes(type))
  if (unsupported.length > 0) {
    outputTypeFailure(
      expected,
      uniqueActual,
      `provider output type ${unsupported.join(', ')} is not declared by the selected node`,
    )
  }
  return canonicalResult
}

function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicJob(job) {
  const { controller: _controller, request: _request, ...safe } = job
  return JSON.parse(JSON.stringify(safe))
}

function jobNotFound(projectId, jobId) {
  const error = new Error(`job ${jobId} was not found in project ${projectId}`)
  error.code = 'video-director/job-not-found'
  return error
}

function replaceJobInCreationOrder(jobs, safe) {
  const index = jobs.findIndex(candidate => candidate.id === safe.id)
  const replaced = index < 0
    ? [...jobs, safe]
    : jobs.map((candidate, candidateIndex) => candidateIndex === index ? safe : candidate)
  return replaced.sort((left, right) => {
    const leftSequence = Number.isSafeInteger(left.runSequence) ? left.runSequence : undefined
    const rightSequence = Number.isSafeInteger(right.runSequence) ? right.runSequence : undefined
    if (leftSequence === undefined && rightSequence === undefined) return 0
    if (leftSequence === undefined) return -1
    if (rightSequence === undefined) return 1
    return leftSequence - rightSequence
  })
}

function prunePersistedJobs(jobs) {
  if (jobs.length <= PERSISTED_JOB_LIMIT) return jobs
  // Active work must survive a Host restart, even if a busy project has more
  // than 100 runs. Use the remaining budget for the newest terminal history
  // while retaining the original creation order of every kept entry.
  const active = jobs.filter(job => !TERMINAL_STATUSES.has(job.status))
  const terminalBudget = Math.max(0, PERSISTED_JOB_LIMIT - active.length)
  const terminalIds = new Set((terminalBudget === 0
    ? []
    : jobs.filter(job => TERMINAL_STATUSES.has(job.status)).slice(-terminalBudget))
    .map(job => job.id))
  return jobs.filter(job => !TERMINAL_STATUSES.has(job.status) || terminalIds.has(job.id))
}

export class JobManager {
  constructor(store, providers, options = {}) {
    this.store = store
    this.providers = providers
    this.concurrency = options.concurrency ?? 2
    this.jobs = new Map()
    this.terminalJobs = new Map()
    this.queue = []
    this.running = 0
    this.nextRunSequence = 0
    this.terminalCacheLimit = options.terminalCacheLimit ?? DEFAULT_TERMINAL_CACHE_LIMIT
    if (!Number.isSafeInteger(this.terminalCacheLimit) || this.terminalCacheLimit < 0) {
      throw new TypeError('terminalCacheLimit must be a non-negative safe integer')
    }
  }

  async recover() {
    for (const summary of await this.store.listProjects()) {
      const project = await this.store.getProject(summary.id)
      let changed = false
      const jobs = project.jobs.map((job) => {
        if (job.status !== 'queued' && job.status !== 'running') return job
        changed = true
        return {
          ...job,
          status: 'orphaned',
          phase: 'restart-required',
          error: 'The Harness process stopped before this run reached a terminal state. The run was not submitted again.',
          updatedAt: new Date().toISOString(),
        }
      })
      if (changed) await this.store.updateProject(project.id, { jobs, status: 'error' })
      for (const job of jobs) {
        if (Number.isSafeInteger(job.runSequence)) {
          this.nextRunSequence = Math.max(this.nextRunSequence, job.runSequence)
        }
        this.#rememberTerminal({ ...job })
      }
    }
  }

  async start(value, options = {}) {
    // Clone before the first await. A caller may keep editing its in-memory
    // canvas immediately after dispatch; those mutations must never alter the
    // provider request that this job eventually receives.
    const rawRequest = record(jsonValue(value, 'job request', MAX_JOB_REQUEST_BYTES), 'job request')
    const projectId = uuid(rawRequest.projectId, 'projectId')
    const project = await this.store.getProject(projectId)
    const nodeId = string(rawRequest.nodeId, 'nodeId', { min: 1, max: 256 })
    if (options.allowTransientNode !== true && !project.graph.nodes.some(node => node?.id === nodeId)) {
      throw new DirectorInputError(`node ${nodeId} is not part of project ${projectId}`)
    }
    const operation = string(rawRequest.operation, 'operation', { min: 1, max: 128 })
    if (!OPERATIONS.has(operation)) throw new DirectorInputError(`unsupported job operation: ${operation}`)
    const expectedOutputTypes = normalizeExpectedOutputTypes(rawRequest.expectedOutputTypes)
    const mediaInputs = Array.isArray(rawRequest.mediaInputs)
      ? rawRequest.mediaInputs.slice(0, 32).map((value, index) => record(value, `mediaInputs[${String(index)}]`))
      : []
    const candidateIds = [
      ...(Array.isArray(rawRequest.assetIds) ? rawRequest.assetIds : []),
      ...mediaInputs.flatMap(input => [input.assetId, input.maskAssetId]),
    ].filter(value => value !== undefined)
    if (candidateIds.length > 64) throw new DirectorInputError('a job may reference at most 32 source assets and 32 masks')
    const assetIds = [...new Set(candidateIds.map((value, index) => uuid(value, `assetIds[${String(index)}]`)))]
    for (const assetId of assetIds) {
      const asset = this.store.asset(assetId)
      if (asset.projectId !== projectId) {
        throw new DirectorInputError(`asset ${assetId} does not belong to project ${projectId}`)
      }
    }
    const request = {
      ...rawRequest,
      projectId,
      nodeId,
      operation,
      assetIds,
      mediaInputs,
      ...(expectedOutputTypes === undefined ? {} : { expectedOutputTypes }),
    }
    const clientRunId = request.clientRunId === undefined
      ? undefined
      : string(request.clientRunId, 'clientRunId', { min: 1, max: 128 })
    // Historical wire names: workflowRunId groups a vd-run; clientRunId correlates
    // one vd-node request. A later promptId update identifies the ComfyUI submission.
    const workflowRunId = request.workflowRunId === undefined
      ? undefined
      : string(request.workflowRunId, 'workflowRunId', { min: 1, max: 128 })
    const workflowRunMode = request.workflowRunMode === undefined
      ? undefined
      : string(request.workflowRunMode, 'workflowRunMode', { min: 3, max: 32 })
    if (workflowRunMode !== undefined && !['all', 'selected', 'from-selection', 'dependencies'].includes(workflowRunMode)) {
      throw new DirectorInputError(`unsupported workflowRunMode: ${workflowRunMode}`)
    }
    const batchIndex = request.batchIndex
    const batchSize = request.batchSize
    if (batchIndex !== undefined && (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= 20)) {
      throw new DirectorInputError('batchIndex must be an integer from 0 to 19')
    }
    if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20)) {
      throw new DirectorInputError('batchSize must be an integer from 1 to 20')
    }
    if ((batchIndex !== undefined || batchSize !== undefined || workflowRunMode !== undefined) && workflowRunId === undefined) {
      throw new DirectorInputError('vd-run metadata requires workflowRunId')
    }
    if (batchIndex !== undefined && batchSize !== undefined && batchIndex >= batchSize) {
      throw new DirectorInputError('batchIndex must be less than batchSize')
    }
    const runSourceRevision = sourceRevision(request.sourceRevision)
    const nodeDigest = request.nodeDigest === undefined
      ? undefined
      : string(request.nodeDigest, 'nodeDigest', { min: 16, max: 128 })
    const projectRunSequence = project.jobs.reduce((maximum, candidate) => (
      Number.isSafeInteger(candidate.runSequence) ? Math.max(maximum, candidate.runSequence) : maximum
    ), 0)
    this.nextRunSequence = Math.max(this.nextRunSequence, projectRunSequence) + 1
    const runSequence = this.nextRunSequence
    const now = new Date().toISOString()
    const id = randomUUID()
    const job = {
      id,
      projectId,
      nodeId,
      runSequence,
      operation,
      providerId: string(request.providerId, 'providerId', { min: 1, max: 128 }),
      modelFamily: typeof request.modelFamily === 'string' ? request.modelFamily : undefined,
      inputHash: contentHash(request),
      templateHash: request.workflow === undefined ? undefined : contentHash(request.workflow),
      assetIds,
      ...(clientRunId === undefined ? {} : { clientRunId }),
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
      ...(workflowRunMode === undefined ? {} : { workflowRunMode }),
      ...(batchIndex === undefined ? {} : { batchIndex }),
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(runSourceRevision === undefined ? {} : { sourceRevision: runSourceRevision }),
      ...(nodeDigest === undefined ? {} : { nodeDigest }),
      status: 'queued',
      phase: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      request,
      controller: new AbortController(),
    }
    this.jobs.set(id, job)
    await this.#persistJob(project, job)
    this.queue.push(job)
    this.#drain()
    return publicJob(job)
  }

  async get(projectId, jobId) {
    const job = this.jobs.get(jobId)
    if (job !== undefined && job.projectId === projectId) {
      this.#touchTerminal(job)
      return publicJob(job)
    }
    const persisted = await this.#persistedJob(projectId, jobId)
    if (TERMINAL_STATUSES.has(persisted.status)) this.#rememberTerminal({ ...persisted })
    return publicJob(persisted)
  }

  async cancel(projectId, jobId) {
    let job = this.jobs.get(jobId)
    if (job === undefined || job.projectId !== projectId) {
      const persisted = await this.#persistedJob(projectId, jobId)
      if (TERMINAL_STATUSES.has(persisted.status)) {
        this.#rememberTerminal({ ...persisted })
        return publicJob(persisted)
      }
      throw jobNotFound(projectId, jobId)
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      this.#touchTerminal(job)
      return publicJob(job)
    }
    job.controller?.abort(new Error('Cancelled by the Video Director user'))
    if (job.status === 'queued') {
      const index = this.queue.indexOf(job)
      if (index >= 0) this.queue.splice(index, 1)
      await this.#settle(job, 'cancelled', { error: 'Cancelled before execution started.' })
    } else {
      await this.#progress(job, { phase: 'cancelling' })
    }
    return publicJob(job)
  }

  async delete(projectId, jobId) {
    const cached = this.jobs.get(jobId)
    if (cached !== undefined && cached.projectId === projectId && !TERMINAL_STATUSES.has(cached.status)) {
      const error = new DirectorInputError(`job ${jobId} is still ${cached.status}; cancel it before deleting the record`)
      error.code = 'video-director/job-active'
      throw error
    }
    let current = await this.store.getProject(projectId)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const persisted = current.jobs.find(candidate => candidate.id === jobId)
      if (persisted === undefined) throw jobNotFound(projectId, jobId)
      if (!TERMINAL_STATUSES.has(persisted.status)) {
        const error = new DirectorInputError(`job ${jobId} is still ${persisted.status}; cancel it before deleting the record`)
        error.code = 'video-director/job-active'
        throw error
      }
      const remaining = current.jobs.filter(candidate => candidate.id !== jobId)
      const latest = remaining.at(-1)
      const status = remaining.some(candidate => candidate.status === 'queued' || candidate.status === 'running')
        ? 'running'
        : latest?.status === 'failed' || latest?.status === 'orphaned'
          ? 'error'
          : 'ready'
      try {
        await this.store.saveProject(current.id, { ...current, jobs: remaining, status }, current.revision)
        this.jobs.delete(jobId)
        this.terminalJobs.delete(jobId)
        return publicJob(persisted)
      } catch (error) {
        if (error?.code !== 'video-director/revision-conflict' || attempt === 3) throw error
        current = await this.store.getProject(projectId)
      }
    }
  }

  #drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (job === undefined || job.status !== 'queued') continue
      this.running += 1
      void this.#run(job).finally(() => {
        this.running -= 1
        this.#drain()
      })
    }
  }

  async #run(job) {
    job.status = 'running'
    job.phase = 'starting'
    job.updatedAt = new Date().toISOString()
    job.startedAt = job.updatedAt
    await this.#persistCurrent(job)
    try {
      const providerResult = await this.providers.run(
        job.request,
        job.controller.signal,
        update => this.#progress(job, update),
      )
      job.controller.signal.throwIfAborted()
      const result = validateProviderResult(
        this.store,
        job.projectId,
        job.request.expectedOutputTypes,
        providerResult,
      )
      await this.#settle(job, 'completed', { result, progress: 1, phase: 'completed' })
    } catch (error) {
      const cancelled = job.controller.signal.aborted && error?.code !== 'video-director/remote-cancel-failed'
      await this.#settle(job, cancelled ? 'cancelled' : 'failed', {
        phase: cancelled ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        errorCode: error?.code,
      })
    }
  }

  async #progress(job, update) {
    if (job.status !== 'running') return
    let persistIdentity = false
    if (typeof update.promptId === 'string' && update.promptId !== '' && update.promptId !== job.promptId) {
      job.promptId = update.promptId
      persistIdentity = true
    }
    if (Number.isSafeInteger(update.seed) && update.seed !== job.seed) {
      job.seed = update.seed
      persistIdentity = true
    }
    if (typeof update.compiledWorkflowHash === 'string' && update.compiledWorkflowHash !== job.compiledWorkflowHash) {
      job.compiledWorkflowHash = update.compiledWorkflowHash
      persistIdentity = true
    }
    const phase = job.controller?.signal.aborted && !update.phase?.startsWith('cancelling')
      ? 'cancelling'
      : update.phase
    if (typeof phase === 'string' && phase !== job.phase) {
      job.phase = phase
      persistIdentity = true
    }
    if (typeof update.progress === 'number' && Number.isFinite(update.progress)) {
      job.progress = Math.max(job.progress, Math.min(0.99, update.progress))
    }
    job.updatedAt = new Date().toISOString()
    if (persistIdentity) await this.#persistCurrent(job)
  }

  async #settle(job, status, fields) {
    Object.assign(job, fields, {
      status,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })
    await this.#persistCurrent(job)
    this.#rememberTerminal(job)
  }

  async #persistedJob(projectId, jobId) {
    const project = await this.store.getProject(projectId)
    const job = project.jobs.find(candidate => candidate.id === jobId)
    if (job === undefined) throw jobNotFound(projectId, jobId)
    return job
  }

  #touchTerminal(job) {
    if (!TERMINAL_STATUSES.has(job.status) || !this.terminalJobs.has(job.id)) return
    this.terminalJobs.delete(job.id)
    this.terminalJobs.set(job.id, true)
  }

  #rememberTerminal(job) {
    // The provider request can contain a multi-megabyte ComfyUI graph, and the
    // AbortController retains its listener graph. Neither is useful once the
    // terminal summary has been durably persisted.
    delete job.request
    delete job.controller
    this.jobs.set(job.id, job)
    this.terminalJobs.delete(job.id)
    this.terminalJobs.set(job.id, true)
    while (this.terminalJobs.size > this.terminalCacheLimit) {
      const oldest = this.terminalJobs.keys().next().value
      if (oldest === undefined) break
      this.terminalJobs.delete(oldest)
      const cached = this.jobs.get(oldest)
      if (cached !== undefined && TERMINAL_STATUSES.has(cached.status)) this.jobs.delete(oldest)
    }
  }

  async #persistCurrent(job) {
    const project = await this.store.getProject(job.projectId)
    await this.#persistJob(project, job)
  }

  async #persistJob(project, job) {
    let current = project
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const safe = publicJob(job)
      const jobs = prunePersistedJobs(replaceJobInCreationOrder(current.jobs, safe))
      const latest = jobs.at(-1) ?? safe
      const projectStatus = jobs.some(candidate => candidate.status === 'queued' || candidate.status === 'running')
        ? 'running'
        : latest.status === 'failed' || latest.status === 'orphaned'
          ? 'error'
          : 'ready'
      try {
        return await this.store.saveProject(current.id, {
          ...current,
          jobs,
          status: projectStatus,
        }, current.revision)
      } catch (error) {
        if (error?.code !== 'video-director/revision-conflict' || attempt === 3) throw error
        current = await this.store.getProject(current.id)
      }
    }
  }
}
