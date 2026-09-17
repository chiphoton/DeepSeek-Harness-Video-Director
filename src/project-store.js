import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { readVideoProperties } from './video-properties.js'
import {
  DirectorInputError,
  jsonValue,
  oneOf,
  record,
  string,
  uuid,
} from './validation.js'

const PROJECT_SCHEMA_VERSION = 1
const PROJECT_STATUSES = ['draft', 'running', 'ready', 'error']
const ASSET_KINDS = ['image', 'audio', 'video', 'sketch', 'mask']
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/mp4', 'm4a'],
  ['audio/webm', 'webm'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
])

function assertMimeForKind(kind, mimeType) {
  const family = mimeType.split('/', 1)[0]
  const accepted = kind === 'sketch' || kind === 'mask' ? family === 'image' : family === kind
  if (!accepted || !MIME_EXTENSIONS.has(mimeType)) {
    throw new DirectorInputError(`unsupported ${kind} MIME type: ${mimeType}`)
  }
}

function emptyGraph() {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.draft?.name ?? project.name,
    unsaved: project.hasSavedVersion === false || project.draft !== undefined,
    hasSavedVersion: project.hasSavedVersion !== false,
    sessionId: project.sessionId,
    status: project.status,
    revision: project.revision,
    nodeCount: (project.draft?.graph ?? project.graph).nodes.length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function normalizedProject(value, expectedId) {
  const input = record(value, 'project')
  const id = uuid(input.id, 'project.id')
  if (expectedId !== undefined && id !== expectedId) {
    throw new DirectorInputError('project.id does not match the requested project')
  }
  const graph = record(input.graph, 'project.graph')
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 2_000) {
    throw new DirectorInputError('project.graph.nodes must be an array with at most 2000 nodes')
  }
  if (!Array.isArray(graph.edges) || graph.edges.length > 5_000) {
    throw new DirectorInputError('project.graph.edges must be an array with at most 5000 edges')
  }
  const viewport = record(graph.viewport ?? { x: 0, y: 0, zoom: 1 }, 'project.graph.viewport')
  const normalized = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    revision: Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    id,
    name: string(input.name, 'project.name', { min: 1, max: 120 }),
    sessionId: string(input.sessionId, 'project.sessionId', { min: 1, max: 256 }),
    status: oneOf(input.status ?? 'draft', 'project.status', PROJECT_STATUSES),
    graph: {
      nodes: jsonValue(graph.nodes, 'project.graph.nodes'),
      edges: jsonValue(graph.edges, 'project.graph.edges'),
      viewport: {
        x: typeof viewport.x === 'number' && Number.isFinite(viewport.x) ? viewport.x : 0,
        y: typeof viewport.y === 'number' && Number.isFinite(viewport.y) ? viewport.y : 0,
        zoom: typeof viewport.zoom === 'number' && viewport.zoom > 0 && viewport.zoom <= 8 ? viewport.zoom : 1,
      },
    },
    settings: jsonValue(input.settings ?? {}, 'project.settings', 512 * 1024),
    jobs: Array.isArray(input.jobs)
      ? jsonValue(input.jobs.slice(-100), 'project.jobs', 2 * 1024 * 1024)
      : [],
    createdAt: string(input.createdAt, 'project.createdAt', { min: 20, max: 40 }),
    updatedAt: string(input.updatedAt, 'project.updatedAt', { min: 20, max: 40 }),
  }
  if (input.hasSavedVersion === false) normalized.hasSavedVersion = false
  if (input.draft !== undefined) {
    const draft = record(input.draft, 'project.draft')
    const validated = normalizedProject({ ...normalized, ...draft, id, draft: undefined }, id)
    normalized.draft = { name: validated.name, graph: validated.graph, settings: validated.settings }
  }
  return jsonValue(normalized, 'project')
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export class ProjectStore {
  constructor(dataDir, maxAssetBytes) {
    this.root = resolve(dataDir)
    this.projectsDir = join(this.root, 'projects')
    this.assetsDir = join(this.root, 'assets')
    this.assetsIndexPath = join(this.assetsDir, 'index.json')
    this.maxAssetBytes = maxAssetBytes
    this.assets = new Map()
    this.projectWriteTails = new Map()
    this.assetWriteTail = Promise.resolve()
    this.orderWriteTail = Promise.resolve()
  }

  async init() {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true }),
      mkdir(this.assetsDir, { recursive: true }),
    ])
    const rows = await readJson(this.assetsIndexPath, [])
    if (!Array.isArray(rows)) throw new Error('video-director asset index must be an array')
    for (const row of rows) {
      const metadata = this.#parseAssetMetadata(row)
      this.assets.set(metadata.id, metadata)
    }
  }

  async listProjects() {
    const entries = await readdir(this.projectsDir, { withFileTypes: true })
    const summaries = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const project = await this.getProject(entry.name)
        summaries.push(projectSummary(project))
      } catch (error) {
        if (error instanceof DirectorInputError) continue
        throw error
      }
    }
    return this.#withOrderWrite(async () => {
      const path = join(this.root, 'project-order.json')
      const order = await readJson(path, [])
      const ranks = new Map(order.map((id, index) => [id, index]))
      summaries.sort((left, right) => (ranks.get(left.id) ?? -1) - (ranks.get(right.id) ?? -1)
        || right.updatedAt.localeCompare(left.updatedAt))
      const ids = summaries.map(project => project.id)
      if (JSON.stringify(ids) !== JSON.stringify(order)) await this.#atomicJson(path, ids)
      return summaries
    })
  }

  async reorderProjects(projectIds) {
    if (!Array.isArray(projectIds) || new Set(projectIds).size !== projectIds.length) throw new DirectorInputError('projectIds must contain unique project IDs')
    const ids = projectIds.map(id => uuid(id, 'projectId'))
    const projects = await this.listProjects()
    if (ids.some(id => !projects.some(project => project.id === id))) throw new DirectorInputError('Cannot reorder an unknown project')
    const order = [...ids, ...projects.map(project => project.id).filter(id => !ids.includes(id))]
    await this.#withOrderWrite(() => this.#atomicJson(join(this.root, 'project-order.json'), order))
    return this.listProjects()
  }

  async galleryProjects(signal) {
    const projects = []
    for (const summary of await this.listProjects()) {
      signal?.throwIfAborted()
      let saved
      try { saved = await this.getProject(summary.id) }
      catch (error) {
        // A workflow can be deleted between listing it and reading its resources.
        if (error.code === 'video-director/project-not-found') continue
        throw error
      }
      const project = { ...saved, ...saved.draft }
      projects.push({
        id: project.id,
        name: project.name,
        graph: { nodes: project.graph.nodes.map(node => {
          const data = node.data ?? {}
          const fields = ['kind', 'title', 'asset', 'assets', 'text', 'maskAsset', 'runCompletedAt']
          return { id: node.id, data: {
            ...Object.fromEntries(fields.filter(field => data[field] !== undefined).map(field => [field, data[field]])),
            ...(data.sketchDocument?.base ? { sketchDocument: { base: data.sketchDocument.base } } : {}),
          } }
        }) },
        jobs: project.jobs.map(job => ({ nodeId: job.nodeId, operation: job.operation, createdAt: job.createdAt, completedAt: job.completedAt, result: job.result })),
      })
    }
    return projects
  }

  async createProject({ name, sessionId, unsaved = false }) {
    const now = new Date().toISOString()
    const project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      revision: 1,
      id: randomUUID(),
      name: string(name, 'name', { min: 1, max: 120 }),
      sessionId: string(sessionId, 'sessionId', { min: 1, max: 256 }),
      status: 'draft',
      graph: emptyGraph(),
      settings: {
        defaultTextProvider: 'ollama',
        defaultImageProvider: 'openai',
        defaultVideoProvider: 'comfyui',
      },
      jobs: [],
      createdAt: now,
      updatedAt: now,
      ...(unsaved ? { hasSavedVersion: false } : {}),
    }
    await this.#writeProject(project)
    await this.listProjects()
    return project
  }

  async getProject(projectId) {
    const id = uuid(projectId, 'projectId')
    const path = join(this.projectsDir, id, 'project.json')
    const raw = await readJson(path, undefined)
    if (raw === undefined) {
      const error = new Error(`project ${id} was not found`)
      error.code = 'video-director/project-not-found'
      throw error
    }
    return normalizedProject(raw, id)
  }

  async saveProject(projectId, value, expectedRevision, { commit = false } = {}) {
    const id = uuid(projectId, 'projectId')
    return this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      return this.#saveProjectFromCurrent(id, commit ? { ...value, jobs: current.jobs } : value, expectedRevision, current, { commit })
    })
  }

  /** A draft is durable without changing the explicitly saved workflow or its revision. */
  async cacheDraft(projectId, draft) {
    const id = uuid(projectId, 'projectId')
    return this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      const project = normalizedProject({ ...current, draft: draft === null ? undefined : record(draft, 'draft') }, id)
      await this.#writeProject(project)
      return projectSummary(project)
    })
  }

  async discardDraft(projectId) {
    const id = uuid(projectId, 'projectId')
    const project = await this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      const activeRuns = await this.listVdRuns(id)
      if (current.jobs.some(job => job.status === 'queued' || job.status === 'running')
        || activeRuns.some(run => run.status === 'queued' || run.status === 'running')) {
        throw Object.assign(new Error('Wait for tasks to finish or cancel them before discarding changes.'), { code: 'video-director/project-busy' })
      }
      if (current.hasSavedVersion === false) return null
      const { draft: _draft, ...saved } = current
      await this.#writeProject(saved)
      return saved
    })
    if (project === null) await this.deleteProject(id, { onlyUnsaved: true })
    return { project, projects: await this.listProjects() }
  }

  // Keep submitted graphs outside project.json: polling job summaries should
  // not transfer many copies of a potentially large canvas.
  async saveVdRun(projectId, value, snapshot) {
    const id = uuid(projectId, 'projectId')
    const run = record(jsonValue(value, 'vd-run', 256 * 1024), 'vd-run')
    const runId = uuid(run.id, 'vd-run.id')
    if (run.projectId !== id) throw new DirectorInputError('vd-run projectId does not match')
    oneOf(run.status, 'vd-run.status', ['queued', 'running', 'completed', 'failed', 'cancelled'])
    oneOf(run.mode, 'vd-run.mode', ['all', 'selected', 'from-selection', 'dependencies'])
    for (const field of ['batchSize', 'completedJobs', 'totalJobs']) {
      if (!Number.isSafeInteger(run[field]) || run[field] < 0) throw new DirectorInputError(`invalid vd-run ${field}`)
    }
    if (run.batchSize < 1 || run.batchSize > 20 || run.completedJobs > run.totalJobs) throw new DirectorInputError('invalid vd-run counts')
    if (!Array.isArray(run.nodeIds) || run.nodeIds.length > 2000
      || run.nodeIds.some(nodeId => typeof nodeId !== 'string')) throw new DirectorInputError('invalid vd-run nodeIds')
    string(run.startedAt, 'vd-run.startedAt', { min: 20, max: 40 })
    const submitted = snapshot === undefined ? undefined : jsonValue(snapshot, 'vd-run snapshot', 32 * 1024 * 1024)
    return this.#withProjectWrite(id, async () => {
      const project = await this.getProject(id)
      const directory = join(this.projectsDir, id, 'runs')
      const path = join(directory, `${runId}.json`)
      const snapshotPath = join(directory, `${runId}.snapshot.json`)
      const previous = await readJson(path, undefined)
      if (previous === undefined && submitted === undefined) throw new DirectorInputError('a new vd-run requires a snapshot')
      // Submission contents are write-once, including on a retried RPC.
      await mkdir(directory, { recursive: true })
      if (previous === undefined) {
        const validated = normalizedProject({ ...project, ...record(submitted, 'snapshot'), jobs: [] }, id)
        await this.#atomicJson(snapshotPath, { name: validated.name, graph: validated.graph, settings: validated.settings })
      }
      const { snapshot: _ignored, ...summary } = run
      await this.#atomicJson(path, summary)
      return summary
    })
  }

  async getVdRun(projectId, runId) {
    const id = uuid(projectId, 'projectId')
    await this.getProject(id)
    const run = await readJson(join(this.projectsDir, id, 'runs', `${uuid(runId, 'runId')}.json`), undefined)
    if (run === undefined) throw new DirectorInputError(`vd-run ${runId} was not found`)
    const snapshot = await readJson(join(this.projectsDir, id, 'runs', `${runId}.snapshot.json`), undefined)
    if (snapshot === undefined) throw new DirectorInputError(`vd-run ${runId} has no saved snapshot`)
    return { ...run, snapshot }
  }

  async listVdRuns(projectId) {
    const id = uuid(projectId, 'projectId')
    await this.getProject(id)
    const directory = join(this.projectsDir, id, 'runs')
    let files
    try { files = await readdir(directory) } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const runs = []
    for (const file of files.filter(name => name.endsWith('.json') && !name.endsWith('.snapshot.json'))) {
      const summary = await readJson(join(directory, file))
      runs.push(summary)
    }
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  async forceSaveProject(projectId, value) {
    const id = uuid(projectId, 'projectId')
    return this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      return this.#saveProjectFromCurrent(id, {
        ...current,
        name: value?.name,
        graph: value?.graph,
        settings: value?.settings,
        draft: undefined,
        hasSavedVersion: true,
      }, current.revision, current, { commit: true })
    })
  }

  async updateProject(projectId, update) {
    const id = uuid(projectId, 'projectId')
    return this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      return this.#saveProjectFromCurrent(id, { ...current, ...update }, current.revision, current)
    })
  }

  async replaceProjectSession(projectId, sessionId) {
    const id = uuid(projectId, 'projectId')
    const nextSessionId = string(sessionId, 'sessionId', { min: 1, max: 256 })
    return this.#withProjectWrite(id, async () => {
      const current = await this.getProject(id)
      return this.#saveProjectFromCurrent(
        id,
        { ...current, sessionId: nextSessionId },
        current.revision,
        current,
        { preserveSession: false },
      )
    })
  }

  async deleteProject(projectId, { onlyUnsaved = false } = {}) {
    const id = uuid(projectId, 'projectId')
    return this.#withProjectWrite(id, async () => {
      const project = await this.getProject(id)
      if (onlyUnsaved && project.hasSavedVersion !== false) {
        throw Object.assign(new Error('This workflow was saved while discarding. Retry to restore its saved version.'), { code: 'video-director/revision-conflict' })
      }
      const activeJobs = project.jobs.filter(job => job?.status === 'queued' || job?.status === 'running')
      const activeRuns = (await this.listVdRuns(id)).filter(run => run.status === 'queued' || run.status === 'running')
      if (activeJobs.length > 0 || activeRuns.length > 0) {
        const error = new Error(`project ${id} has active jobs and cannot be deleted`)
        error.code = 'video-director/project-busy'
        error.details = {
          projectId: id,
          activeJobIds: activeJobs.map(job => job.id),
          ...(activeRuns.length === 0 ? {} : { activeRunIds: activeRuns.map(run => run.id) }),
        }
        throw error
      }

      // Moving the exact UUID directory first makes the project unavailable as
      // one atomic filesystem operation. If the asset index update fails, the
      // directory is restored before the error is returned.
      const directory = join(this.projectsDir, id)
      const tombstone = join(this.projectsDir, `.deleting-${id}-${randomUUID()}`)
      try {
        await rename(directory, tombstone)
      } catch (cause) {
        const error = new Error(`project ${id} could not be staged for deletion`)
        error.code = 'video-director/project-delete-failed'
        error.details = { projectId: id, phase: 'project' }
        error.cause = cause
        throw error
      }

      let ownedAssets
      try {
        ownedAssets = await this.#withAssetWrite(async () => {
          const owned = [...this.assets.values()].filter(asset => asset.projectId === id)
          const remaining = new Map(
            [...this.assets.entries()].filter(([, asset]) => asset.projectId !== id),
          )
          await this.#writeAssetIndex(remaining)
          this.assets = remaining
          return owned
        })
      } catch (cause) {
        try {
          await rename(tombstone, directory)
        } catch (rollbackCause) {
          const error = new Error(`project ${id} deletion failed and its directory could not be restored`)
          error.code = 'video-director/project-delete-failed'
          error.details = { projectId: id, phase: 'rollback' }
          error.cause = new AggregateError([cause, rollbackCause])
          throw error
        }
        const error = new Error(`project ${id} asset index could not be updated for deletion`)
        error.code = 'video-director/project-delete-failed'
        error.details = { projectId: id, phase: 'asset-index' }
        error.cause = cause
        throw error
      }

      try {
        await Promise.all([
          rm(tombstone, { recursive: true, force: true }),
          ...ownedAssets.map(asset => rm(join(this.assetsDir, asset.filename), { force: true })),
        ])
      } catch (cause) {
        const error = new Error(`project ${id} was deleted but filesystem cleanup did not finish`)
        error.code = 'video-director/project-delete-cleanup-failed'
        error.details = { projectId: id, phase: 'cleanup' }
        error.cause = cause
        throw error
      }

      return { projectId: id, deletedAssetCount: ownedAssets.length }
    })
  }

  async #saveProjectFromCurrent(id, value, expectedRevision, current, { preserveSession = true, commit = false } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      const error = new Error(`project ${id} changed from revision ${String(expectedRevision)} to ${String(current.revision)}`)
      error.code = 'video-director/revision-conflict'
      error.details = { expectedRevision, currentRevision: current.revision }
      throw error
    }
    const candidate = normalizedProject({
      ...value,
      id,
      revision: current.revision + 1,
      sessionId: preserveSession ? current.sessionId : value.sessionId,
      draft: commit ? undefined : current.draft,
      hasSavedVersion: commit ? true : current.hasSavedVersion,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    }, id)
    await this.#writeProject(candidate)
    return candidate
  }

  async putAsset(input) {
    const projectId = uuid(input.projectId, 'projectId')
    return this.#withProjectWrite(projectId, async () => {
      await this.getProject(projectId)
      const kind = oneOf(input.kind, 'kind', ASSET_KINDS)
      const mimeType = string(input.mimeType, 'mimeType', { min: 3, max: 128 }).toLowerCase()
      assertMimeForKind(kind, mimeType)
      const name = string(input.name, 'name', { min: 1, max: 240 })
      const encoded = string(input.dataBase64, 'dataBase64', {
        trim: false,
        min: 1,
        max: Math.ceil(this.maxAssetBytes * 4 / 3) + 8,
      })
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
        throw new DirectorInputError('dataBase64 is not canonical base64')
      }
      const data = Buffer.from(encoded, 'base64')
      if (data.byteLength === 0 || data.byteLength > this.maxAssetBytes) {
        throw new DirectorInputError(`asset size must be between 1 and ${String(this.maxAssetBytes)} bytes`)
      }
      if (data.toString('base64') !== encoded) {
        throw new DirectorInputError('dataBase64 is not canonical base64')
      }
      const id = randomUUID()
      const extension = MIME_EXTENSIONS.get(mimeType)
      const filename = `${id}.${extension}`
      await writeFile(join(this.assetsDir, filename), data, { flag: 'wx' })
      const metadata = {
        id,
        projectId,
        kind,
        name,
        mimeType,
        filename,
        size: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
        createdAt: new Date().toISOString(),
        url: `/api/video-director/assets/${id}`,
      }
      await this.#withAssetWrite(async () => {
        const assets = new Map(this.assets)
        assets.set(id, metadata)
        await this.#writeAssetIndex(assets)
        this.assets = assets
      })
      return metadata
    })
  }

  asset(assetId) {
    const id = uuid(assetId, 'assetId')
    const asset = this.assets.get(id)
    if (asset === undefined) {
      const error = new Error(`asset ${id} was not found`)
      error.code = 'video-director/asset-not-found'
      throw error
    }
    return asset
  }

  listAssets() {
    return [...this.assets.values()]
  }

  async videoProperties(assetId, signal) {
    const asset = this.asset(assetId)
    if (asset.kind !== 'video') throw new DirectorInputError('Video properties require a video asset')
    return readVideoProperties(join(this.assetsDir, asset.filename), asset.mimeType, { signal })
  }

  async assetBytes(assetId) {
    const asset = this.asset(assetId)
    return {
      asset,
      data: await readFile(join(this.assetsDir, asset.filename)),
    }
  }

  async assetResponse(assetId, request) {
    const asset = this.asset(assetId)
    const filePath = join(this.assetsDir, asset.filename)
    const info = await stat(filePath)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Type': asset.mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    })
    const range = request.headers.get('range')
    if (range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
      if (match === null || (match[1] === '' && match[2] === '')) {
        return new Response('invalid range', { status: 416, headers: { 'Content-Range': `bytes */${String(info.size)}` } })
      }
      let start
      let end
      if (match[1] === '') {
        const suffixLength = Number(match[2])
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${String(info.size)}` } })
        }
        start = Math.max(0, info.size - suffixLength)
        end = info.size - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? info.size - 1 : Number(match[2])
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= info.size) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${String(info.size)}` },
        })
      }
      headers.set('Content-Length', String(end - start + 1))
      headers.set('Content-Range', `bytes ${String(start)}-${String(end)}/${String(info.size)}`)
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
      const stream = Readable.toWeb(createReadStream(filePath, { start, end }))
      return new Response(stream, { status: 206, headers })
    }
    headers.set('Content-Length', String(info.size))
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(createReadStream(filePath)), { status: 200, headers })
  }

  async #writeProject(project) {
    const directory = join(this.projectsDir, project.id)
    await mkdir(directory, { recursive: true })
    await this.#atomicJson(join(directory, 'project.json'), project)
  }

  async #withProjectWrite(projectId, operation) {
    const prior = this.projectWriteTails.get(projectId) ?? Promise.resolve()
    const result = prior.catch(() => {}).then(operation)
    const tail = result.then(() => {}, () => {})
    this.projectWriteTails.set(projectId, tail)
    try {
      return await result
    } finally {
      if (this.projectWriteTails.get(projectId) === tail) this.projectWriteTails.delete(projectId)
    }
  }

  async #writeAssetIndex(assets = this.assets) {
    await this.#atomicJson(this.assetsIndexPath, [...assets.values()])
  }

  #withAssetWrite(operation) {
    const result = this.assetWriteTail.then(operation)
    this.assetWriteTail = result.then(() => undefined, () => undefined)
    return result
  }

  #withOrderWrite(operation) {
    const result = this.orderWriteTail.then(operation)
    this.orderWriteTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #atomicJson(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await rename(temp, path)
  }

  #parseAssetMetadata(value) {
    const input = record(value, 'asset metadata')
    const id = uuid(input.id, 'asset.id')
    const projectId = uuid(input.projectId, 'asset.projectId')
    const kind = oneOf(input.kind, 'asset.kind', ASSET_KINDS)
    const mimeType = string(input.mimeType, 'asset.mimeType', { min: 3, max: 128 })
    assertMimeForKind(kind, mimeType)
    const extension = MIME_EXTENSIONS.get(mimeType)
    const filename = `${id}.${extension}`
    if (input.filename !== filename) throw new Error(`asset ${id} filename does not match its metadata`)
    return {
      id,
      projectId,
      kind,
      name: string(input.name, 'asset.name', { min: 1, max: 240 }),
      mimeType,
      filename,
      size: Number(input.size),
      sha256: string(input.sha256, 'asset.sha256', { min: 64, max: 64 }),
      createdAt: string(input.createdAt, 'asset.createdAt', { min: 20, max: 40 }),
      url: `/api/video-director/assets/${id}`,
    }
  }
}
