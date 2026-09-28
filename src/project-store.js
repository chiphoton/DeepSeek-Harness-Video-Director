import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { MAX_BATCH_CASES, validateBatchCase, caseIdentity } from './batch-cases.js'
import { readVideoProperties } from './video-properties.js'
import { ProjectFolders } from './project-folders.js'
import { allocateAssetFile, ensureAssetDirectories, isLegacyAsset, migrateAssetLayout, validAssetFilename } from './asset-layout.js'
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
  if (input.mediaLibrary !== undefined && (!Array.isArray(input.mediaLibrary) || input.mediaLibrary.length > 5000)) {
    throw new DirectorInputError('project.mediaLibrary must contain at most 5000 assets')
  }
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
    ...(input.mediaLibrary === undefined ? {} : { mediaLibrary: jsonValue(input.mediaLibrary, 'project.mediaLibrary', 2 * 1024 * 1024) }),
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
    normalized.draft = { name: validated.name, graph: validated.graph, settings: validated.settings, ...(validated.mediaLibrary === undefined ? {} : { mediaLibrary: validated.mediaLibrary }) }
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
    this.folders = new ProjectFolders(this.root)
  }

  async init() {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true }),
      mkdir(this.assetsDir, { recursive: true }),
    ])
    const rows = await readJson(this.assetsIndexPath, [])
    if (!Array.isArray(rows)) throw new Error('video-director asset index must be an array')
    const parsed = rows.map(row => this.#parseAssetMetadata(row))
    await ensureAssetDirectories(this.assetsDir)
    const migrated = await migrateAssetLayout(this.root, parsed, MIME_EXTENSIONS, { originalIndex: rows })
    this.assetMigration = migrated.report
    for (const metadata of migrated.assets) {
      this.assets.set(metadata.id, metadata)
    }
    await this.folders.init()
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
        if (error instanceof DirectorInputError || error.code === 'video-director/project-not-found') continue
        throw error
      }
    }
    return this.folders.sort(summaries)
  }

  async reorderProjects(projectIds) {
    if (!Array.isArray(projectIds) || new Set(projectIds).size !== projectIds.length) throw new DirectorInputError('projectIds must contain unique project IDs')
    const ids = projectIds.map(id => uuid(id, 'projectId'))
    const projects = await this.listProjects()
    if (ids.some(id => !projects.some(project => project.id === id))) throw new DirectorInputError('Cannot reorder an unknown project')
    const order = [...ids, ...projects.map(project => project.id).filter(id => !ids.includes(id))]
    await this.folders.change({ action: 'reorder', projectIds: order, expectedRevision: this.folders.snapshot().revision }, projects)
    return this.listProjects()
  }

  async organizeProjects(input) {
    const projects = await this.listProjects()
    const result = await this.folders.change(input, projects, async (ids, commit) => {
      const lock = index => index === ids.length
        ? this.#deleteProjectsLocked(ids, { commit })
        : this.#withProjectWrite(ids[index], () => lock(index + 1))
      ids.sort()
      if (ids.length) await lock(0)
      else await commit()
    })
    return { ...result, projects: await this.listProjects() }
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
        mediaLibrary: project.mediaLibrary ?? [],
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

  async createProject({ name, sessionId, unsaved = false, parentId, expectedFolderRevision }) {
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
    if (parentId === undefined) await this.#writeProject(project)
    else {
      const projects = [...await this.listProjects(), projectSummary(project)]
      await this.folders.change({ action: 'move', kind: 'project', id: project.id, parentId, expectedRevision: expectedFolderRevision }, projects, async (_ids, commit) => {
        await this.#withProjectWrite(project.id, async () => {
          try { await this.#writeProject(project); await commit() }
          catch (error) { await rm(join(this.projectsDir, project.id), { recursive: true, force: true }); throw error }
        })
      })
    }
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
    return this.#refreshAssetRefs(normalizedProject(raw, id))
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
    if (run.batchSize < 1 || run.batchSize > (run.kind === 'batch' ? MAX_BATCH_CASES : 20) || run.completedJobs > run.totalJobs) throw new DirectorInputError('invalid vd-run counts')
    if (run.kind !== undefined) {
      oneOf(run.kind, 'vd-run.kind', ['batch'])
      string(run.batchInputNodeId, 'batchInputNodeId', { min: 1, max: 256 })
      if (!Number.isSafeInteger(run.startIndex) || !Number.isSafeInteger(run.endIndex) || run.startIndex < 1 || run.endIndex > MAX_BATCH_CASES || run.endIndex - run.startIndex + 1 !== run.batchSize) throw new DirectorInputError('invalid batch range')
    }
    if (run.batchRunId !== undefined) uuid(run.batchRunId, 'batchRunId')
    if (run.caseId !== undefined) uuid(run.caseId, 'caseId')
    if (run.caseIndex !== undefined && (!Number.isSafeInteger(run.caseIndex) || run.caseIndex < 1 || run.caseIndex > MAX_BATCH_CASES)) throw new DirectorInputError('invalid caseIndex')
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
      if (previous !== undefined && ['kind', 'batchRunId', 'caseId', 'caseIndex', 'batchInputNodeId', 'startIndex', 'endIndex'].some(key => previous[key] !== run[key])) throw new DirectorInputError('vd-run identity is immutable')
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
    return this.#refreshAssetRefs({ ...run, snapshot })
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

  async saveVdRunJob(projectId, runId, value) {
    const id = uuid(projectId, 'projectId'), run = uuid(runId, 'runId')
    const job = record(jsonValue(value, 'run job', 16 * 1024 * 1024), 'run job')
    const jobId = uuid(job.id, 'jobId')
    if (job.projectId !== id || job.workflowRunId !== run) throw new DirectorInputError('Job does not belong to this run.')
    delete job.request; delete job.controller
    return this.#withProjectWrite(id, async () => {
      await this.getVdRun(id, run)
      const directory = join(this.projectsDir, id, 'runs', run, 'jobs')
      await mkdir(directory, { recursive: true })
      await this.#atomicJson(join(directory, `${jobId}.json`), job)
    })
  }

  async listVdRunJobs(projectId, runId) {
    const id = uuid(projectId, 'projectId'), run = uuid(runId, 'runId')
    await this.getVdRun(id, run)
    const project = await this.getProject(id)
    const records = new Map()
    const directory = join(this.projectsDir, id, 'runs', run, 'jobs')
    const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const job = await readJson(join(directory, file))
      records.set(job.id, this.#refreshAssetRefs(job))
    }
    for (const job of project.jobs.filter(job => job.workflowRunId === run)) records.set(job.id, job)
    return [...records.values()].sort((a, b) => (a.runSequence ?? 0) - (b.runSequence ?? 0))
  }

  async initializeBatchCases(projectId, runId, values) {
    const id = uuid(projectId, 'projectId'); const batchRunId = uuid(runId, 'runId')
    return this.#withProjectWrite(id, async () => {
      const run = await this.getVdRun(id, batchRunId)
      if (run.kind !== 'batch' || !Array.isArray(values) || values.length !== run.batchSize || values.length > MAX_BATCH_CASES) throw new DirectorInputError('invalid batch manifest')
      const rows = values.map(value => validateBatchCase(value, id, batchRunId, assetId => this.asset(assetId)))
      if (new Set(rows.map(row => row.caseId)).size !== rows.length || rows.some((row, index) => row.caseIndex !== run.startIndex + index || row.status !== 'pending' || row.attempt !== 0 || row.jobs.length || row.artifacts.length)) throw new DirectorInputError('invalid initial case sequence')
      const directory = join(this.projectsDir, id, 'runs', batchRunId)
      const path = join(directory, 'manifest.json')
      const previous = await readJson(path, undefined)
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(rows)) throw new DirectorInputError('batch manifest is immutable')
        return previous
      }
      await mkdir(directory, { recursive: true })
      await this.#atomicJson(path, rows)
      return rows
    })
  }

  async listBatchCases(projectId, runId) {
    const id = uuid(projectId, 'projectId'); const batchRunId = uuid(runId, 'runId')
    const run = await this.getVdRun(id, batchRunId)
    if (run.kind !== 'batch') throw new DirectorInputError('run is not a batch')
    const directory = join(this.projectsDir, id, 'runs', batchRunId)
    const manifest = await readJson(join(directory, 'manifest.json'), [])
    // Limit concurrent filesystem reads for large manifests.
    const rows = []
    for (let offset = 0; offset < manifest.length; offset += 32) {
      rows.push(...await Promise.all(manifest.slice(offset, offset + 32).map(row => readJson(join(directory, `${row.caseIndex}.json`), row))))
    }
    return rows
  }

  async saveBatchCase(projectId, runId, value) {
    const id = uuid(projectId, 'projectId'); const batchRunId = uuid(runId, 'runId')
    return this.#withProjectWrite(id, async () => {
      await this.getProject(id)
      const row = validateBatchCase(value, id, batchRunId, assetId => this.asset(assetId))
      const directory = join(this.projectsDir, id, 'runs', batchRunId)
      const manifest = await readJson(join(directory, 'manifest.json'), [])
      const initial = manifest.find(item => item.caseIndex === row.caseIndex)
      if (!initial || caseIdentity(initial) !== caseIdentity(row)) throw new DirectorInputError('case identity, inputs and seeds are immutable')
      const path = join(directory, `${row.caseIndex}.json`)
      const previous = await readJson(path, initial)
      if (row.attempt < previous.attempt || row.attempt > previous.attempt + 1) throw new DirectorInputError('invalid case attempt sequence')
      if (previous.status === 'completed' && JSON.stringify(previous) !== JSON.stringify(row)) throw new DirectorInputError('completed batch cases are immutable')
      if (row.attempt === previous.attempt && row.workflowRunId !== previous.workflowRunId) throw new DirectorInputError('case attempt identity is immutable')
      if (row.attempt > previous.attempt && (previous.status === 'running' || previous.uncertain === true || row.status !== 'running' || row.workflowRunId === undefined)) throw new DirectorInputError('an uncertain running case cannot be retried')
      if (row.attempt > previous.attempt && previous.attempt > 0) {
        // Keep failed attempt receipts as well as the latest visible row.
        await this.#atomicJson(join(directory, `${row.caseIndex}.attempt-${previous.attempt}.json`), previous)
      }
      await this.#atomicJson(path, row)
      return row
    })
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
    const result = await this.#withProjectWrite(id, () => this.#deleteProjectsLocked([id], { onlyUnsaved }))
    return { projectId: id, deletedAssetCount: result.deletedAssetCount }
  }

  // Call with every affected project lock held. Folder deletion checks the
  // entire subtree before staging any files, and commits its virtual index
  // together with asset ownership. Regular moves never enter this path.
  async #deleteProjectsLocked(ids, { onlyUnsaved = false, commit = async () => {} } = {}) {
    for (const id of ids) {
      const project = await this.getProject(id)
      if (onlyUnsaved && project.hasSavedVersion !== false) {
        throw Object.assign(new Error('This workflow was saved while discarding. Retry to restore its saved version.'), { code: 'video-director/revision-conflict' })
      }
      const activeJobs = project.jobs.filter(job => job?.status === 'queued' || job?.status === 'running')
      const activeRuns = (await this.listVdRuns(id)).filter(run => run.status === 'queued' || run.status === 'running')
      if (activeJobs.length || activeRuns.length) throw Object.assign(new Error('A workflow in this selection has active jobs and cannot be deleted.'), {
        code: 'video-director/project-busy', details: { projectId: id, activeJobIds: activeJobs.map(job => job.id), ...(activeRuns.length ? { activeRunIds: activeRuns.map(run => run.id) } : {}) },
      })
    }
    const staged = []
    let ownedAssets = []
    let cleanupError
    try {
      for (const id of ids) {
        const directory = join(this.projectsDir, id)
        const tombstone = join(this.projectsDir, `.deleting-${id}-${randomUUID()}`)
        await rename(directory, tombstone)
        staged.push({ directory, tombstone })
      }
      await this.#withAssetWrite(async () => {
        const previous = this.assets
        const owners = new Set(ids)
        ownedAssets = [...previous.values()].filter(asset => owners.has(asset.projectId))
        const remaining = new Map([...previous.entries()].filter(([, asset]) => !owners.has(asset.projectId)))
        await this.#writeAssetIndex(remaining)
        try { await commit() } catch (error) { await this.#writeAssetIndex(previous); throw error }
        this.assets = remaining
        const referenced = new Set([...remaining.values()].map(asset => asset.filename))
        const filenames = new Set(ownedAssets.map(asset => asset.filename).filter(filename => !referenced.has(filename)))
        try { await Promise.all([...filenames].map(filename => rm(join(this.assetsDir, filename), { force: true }))) }
        catch (cause) { cleanupError = cause }
      })
    } catch (cause) {
      const restored = await Promise.allSettled(staged.map(({ tombstone, directory }) => rename(tombstone, directory)))
      const failed = restored.some(result => result.status === 'rejected')
      throw Object.assign(new Error(failed ? 'Workflow deletion failed and its directories could not be restored.' : 'Workflow deletion could not be committed; original workflows were restored.'), {
        code: 'video-director/project-delete-failed', details: { phase: failed ? 'rollback' : 'commit' }, cause,
      })
    }
    try {
      await Promise.all(staged.map(({ tombstone }) => rm(tombstone, { recursive: true, force: true })))
      if (cleanupError) throw cleanupError
    } catch (cause) {
      throw Object.assign(new Error('Workflows were deleted but filesystem cleanup did not finish.'), { code: 'video-director/project-delete-cleanup-failed', cause })
    }
    return { deletedAssetCount: ownedAssets.length }
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
      const requestedOrigin = oneOf(input.origin ?? 'input', 'origin', ['input', 'output'])
      const origin = kind === 'sketch' || kind === 'mask' ? 'input' : requestedOrigin
      return this.#withAssetWrite(async () => {
        const id = randomUUID()
        const metadata = { id, projectId, kind, name, mimeType, origin,
          size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'),
          createdAt: new Date().toISOString(), url: `/api/video-director/assets/${id}` }
        const slot = await allocateAssetFile(this.assetsDir, metadata, MIME_EXTENSIONS.get(mimeType), this.listAssets())
        metadata.filename = slot.filename
        if (slot.blobId) metadata.blobId = slot.blobId
        if (slot.created) await writeFile(join(this.assetsDir, slot.filename), data, { flag: 'wx' })
        const assets = new Map(this.assets)
        assets.set(id, metadata)
        try { await this.#writeAssetIndex(assets) }
        catch (error) {
          if (slot.created) await rm(join(this.assetsDir, slot.filename), { force: true })
          throw error
        }
        this.assets = assets
        return metadata
      })
    })
  }

  // Project-owned aliases point to immutable shared bytes. Removing an owner
  // only unlinks the file when the final alias disappears.
  async linkAsset(projectId, sourceId) {
    const target = uuid(projectId, 'projectId')
    return this.#withProjectWrite(target, async () => {
      await this.getProject(target)
      return this.#withAssetWrite(async () => {
        const source = this.asset(sourceId)
        if (source.projectId === target) return source
        const id = randomUUID()
        const asset = { ...source, id, blobId: source.blobId ?? source.id, projectId: target, url: `/api/video-director/assets/${id}` }
        const assets = new Map(this.assets)
        assets.set(id, asset)
        await this.#writeAssetIndex(assets)
        this.assets = assets
        return asset
      })
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

  availableAssets(kind, projectId) {
    oneOf(kind, 'kind', ['image', 'audio', 'video', 'sketch'])
    if (projectId !== undefined) uuid(projectId, 'projectId')
    const unique = new Map()
    for (const asset of this.assets.values()) {
      if (asset.kind !== kind) continue
      const previous = unique.get(asset.filename)
      if (!previous || asset.projectId === projectId) unique.set(asset.filename, asset)
    }
    return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name))
  }

  #refreshAssetRefs(value) {
    if (Array.isArray(value)) return value.map(item => this.#refreshAssetRefs(item))
    if (!value || typeof value !== 'object') return value
    if (typeof value.id === 'string' && typeof value.sha256 === 'string' && typeof value.mimeType === 'string') {
      const asset = this.assets.get(value.id)
      return asset ? { ...asset } : value
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#refreshAssetRefs(item)]))
  }

  async videoProperties(assetId, signal) {
    const asset = this.asset(assetId)
    if (asset.kind !== 'video' && asset.kind !== 'audio') throw new DirectorInputError('Media properties require a video or audio asset')
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
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.size || end < start) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${String(info.size)}` },
        })
      }
      // RFC 9110 §14.1.2: a satisfiable range may extend beyond EOF.
      end = Math.min(end, info.size - 1)
      headers.set('Content-Length', String(end - start + 1))
      headers.set('Content-Range', `bytes ${String(start)}-${String(end)}/${String(info.size)}`)
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
      const stream = Readable.toWeb(createReadStream(filePath, { start, end, signal: request.signal }))
      return new Response(stream, { status: 206, headers })
    }
    headers.set('Content-Length', String(info.size))
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(createReadStream(filePath, { signal: request.signal })), { status: 200, headers })
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

  async #atomicJson(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
      await rename(temp, path)
    } finally { await rm(temp, { force: true }) }
  }

  #parseAssetMetadata(value) {
    const input = record(value, 'asset metadata')
    const id = uuid(input.id, 'asset.id')
    const projectId = uuid(input.projectId, 'asset.projectId')
    const kind = oneOf(input.kind, 'asset.kind', ASSET_KINDS)
    const mimeType = string(input.mimeType, 'asset.mimeType', { min: 3, max: 128 })
    assertMimeForKind(kind, mimeType)
    const extension = MIME_EXTENSIONS.get(mimeType)
    const blobId = input.blobId === undefined ? id : uuid(input.blobId, 'asset.blobId')
    const filename = input.filename
    const legacy = isLegacyAsset(filename)
    const origin = input.origin === undefined ? undefined : oneOf(input.origin, 'asset.origin', ['input', 'output'])
    if (legacy ? filename !== `${blobId}.${extension}` : !validAssetFilename(filename, kind, origin)) {
      throw new Error(`asset ${id} filename does not match its metadata`)
    }
    if (!Number.isSafeInteger(input.size) || input.size < 1 || !/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error(`asset ${id} has invalid size or hash`)
    return {
      id,
      projectId,
      kind,
      name: string(input.name, 'asset.name', { min: 1, max: 240 }),
      mimeType,
      filename,
      ...(origin === undefined ? {} : { origin }),
      ...(input.blobId === undefined ? {} : { blobId }),
      size: Number(input.size),
      sha256: string(input.sha256, 'asset.sha256', { min: 64, max: 64 }),
      createdAt: string(input.createdAt, 'asset.createdAt', { min: 20, max: 40 }),
      url: `/api/video-director/assets/${id}`,
    }
  }
}
