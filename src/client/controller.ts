import { prepareNodeRequest, withDefaultRegisteredImageWorkflow } from './node-request'
import { vdNodeResultPayload, storedVdNodeResult, nodeOutputPayload, hasReusableNodeOutput, combinedSinkPayload, clearedSinkData, suppressedPreviewData, resumedPreviewData, recomputeSinkPayloads } from './node-results'
import { fileKind, inferredMimeType, inputFileKind, isTextFile } from './input-files'
import type { EditMedia, MediaEditResult } from './media-editing'
import type { Edge, Node, Viewport } from '@xyflow/react'
import type {
  AssetRef,
  BatchCase,
  BatchItem,
  BatchInputConfig,
  ClientContext,
  DirectorGraph,
  DirectorEdge,
  DirectorJob,
  DirectorNode,
  DirectorNodeData,
  DirectorSnapshot,
  GalleryProject,
  VdRun,
  MediaKind,
  VdNodeDefinitionDescriptor,
  ObservableSource,
  ProjectSummary,
  ProjectFolderLayout,
  ProjectFolderChange,
  ProviderDescriptor,
  RemoteFailure,
  RemoteResult,
  SessionBinding,
  SketchDocument,
  VideoProject,
  ComfyWorkflowDescriptor,
  ComfyWorkflowKind,
  VdRunMode,
  VdNodeResult,
} from './types'
import {
  inferredNodeOutputTypes,
  isTriggerNodeKind,
  mediaTypesIntersect,
  nodeDefinition,
  portHandleId,
  portsFor,
  resolveConnectionPorts,
  resolveEdgePorts,
  validateNodeInputPorts,
} from './ports'
import {
  activeFieldInputModes,
  fieldIdFromInputPort,
  fieldInputPortId,
  isFieldInputPort,
  parameterInputCandidates,
  resolveParameterInputs,
} from './parameter-inputs'
import { codexModelForNode, effectiveOllamaModel, ollamaModelSupports } from './model-choices'
import { DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT } from './default-system-prompt'
import { planVdRun, validateTriggerNodeConnections } from './workflow-runner'
import { ProjectDraftCache } from './project-drafts'
import { batchSourceItems, matchBatchItems, batchRange, caseSeed, materializeBatchCase, collectBatchArtifacts, MAX_BATCH_CASES } from './batch'

const CHANNEL = '/video-director'
const JOB_POLL_MS = 1_400
const JOB_RECONNECT_MIN_MS = 500
const JOB_RECONNECT_MAX_MS = 15_000
const HISTORY_LIMIT = 100
const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024
const PROJECT_ARCHIVE_FORMAT = 'deepseek-harness-video-director-project'
const PROJECT_ARCHIVE_VERSION = 1

type CanvasPosition = { x: number; y: number }

export interface IncomingNodeConnection {
  source: string
  sourceHandle: string
  targetHandle: string
}

interface ProjectHistoryState {
  name: string
  graph: DirectorGraph
  settings: Record<string, unknown>
  mediaLibrary?: AssetRef[]
}

interface ActiveNodeRun {
  projectId: string
  projectGeneration: number
  clientRunId: string
  seedStateAtSubmission?: {
    seed: number | undefined
    control: DirectorNodeData['seedControlAfterGenerate']
  }
  jobId?: string
  workflowRunId?: string
  completion?: ActiveRunCompletion
  suppressSeedUpdate?: boolean
  consecutivePollFailures?: number
}

function waitForRunTurn(previous: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new Error(String(signal.reason ?? 'vd-run was cancelled.')))
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    previous.then(() => {
      signal.removeEventListener('abort', aborted)
      if (signal.aborted) aborted()
      else resolve()
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}

interface ActiveRunCompletion {
  promise: Promise<DirectorJob>
  settled: boolean
  resolve(job: DirectorJob): void
  reject(error: Error): void
}

interface NodeRunOptions {
  project?: VideoProject
  graph?: DirectorGraph
  sourceRevision?: number
  workflowRunId?: string
  workflowRunMode?: VdRunMode
  batchIndex?: number
  batchSize?: number
  seed?: number
  batchRunId?: string
  caseId?: string
  caseIndex?: number
  suppressSeedUpdate?: boolean
  onSubmitted?: (job: DirectorJob) => Promise<void>
  awaitCompletion?: boolean
  signal?: AbortSignal
}

interface ProjectArchiveAsset {
  sourceId: string
  origin?: AssetRef['origin']
  kind: AssetRef['kind']
  name: string
  mimeType: string
  dataBase64: string
}

interface ProjectArchive {
  format: typeof PROJECT_ARCHIVE_FORMAT
  version: typeof PROJECT_ARCHIVE_VERSION
  exportedAt: string
  project: {
    name: string
    graph: DirectorGraph
    settings: Record<string, unknown>
    mediaLibrary?: AssetRef[]
  }
  assets: ProjectArchiveAsset[]
}

export interface ExportedProjectArchive {
  filename: string
  text: string
}

type ProjectUpdateOrigin = 'user' | 'transient' | 'system' | 'system-saveable'

function emptySnapshot(): DirectorSnapshot {
  return {
    open: false,
    phase: 'idle',
    projects: [],
    examples: [],
    examplesLoading: false,
    examplesError: null,
    project: null,
    providers: [],
    workflows: [],
    nodeDefinitions: [],
    dirty: false,
    canUndo: false,
    canRedo: false,
    canvasResetVersion: 0,
    saving: false,
    conflict: false,
    error: null,
    providerChecks: {},
    workflowRuns: [],
    jobs: [],
    batchCases: {},
  }
}

function activeRunCompletion(): ActiveRunCompletion {
  let resolvePromise!: (job: DirectorJob) => void
  let rejectPromise!: (error: Error) => void
  const completion: ActiveRunCompletion = {
    promise: new Promise<DirectorJob>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    settled: false,
    resolve(job) {
      if (completion.settled) return
      completion.settled = true
      resolvePromise(job)
    },
    reject(error) {
      if (completion.settled) return
      completion.settled = true
      rejectPromise(error)
    },
  }
  return completion
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jobPollRetryDelay(failures: number): number {
  const exponent = Math.min(5, Math.max(0, failures - 1))
  return Math.min(JOB_RECONNECT_MAX_MS, JOB_RECONNECT_MIN_MS * (2 ** exponent))
}

function isPermanentJobPollError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'video-director/job-not-found' || code === 'video-director/invalid-input'
}

function remoteError(error: RemoteFailure): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    details: error.details,
  })
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function withDiscoveredModels(
  provider: ProviderDescriptor,
  result: {
    models: string[]
    workflowModels: NonNullable<ProviderDescriptor['workflowModels']>
    modelDetails?: NonNullable<ProviderDescriptor['modelDetails']>
    loadedModels?: string[]
    model?: string
    codexModels?: ProviderDescriptor['codexModels']
    codexCatalog?: ProviderDescriptor['codexCatalog']
  },
): ProviderDescriptor {
  return {
    ...provider,
    availableModels: result.models,
    loadedModels: result.loadedModels ?? [],
    modelDetails: result.modelDetails ?? [],
    workflowModels: result.workflowModels,
    ...(provider.kind === 'codex-plan' ? { model: result.model, codexModels: result.codexModels, codexCatalog: result.codexCatalog } : {}),
    modelDiscovery: result.codexCatalog?.error ? { state: 'error', message: result.codexCatalog.error } : { state: 'ready' },
  }
}


function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAssetRef(value: unknown): value is AssetRef {
  if (!isObject(value)) return false
  return typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && typeof value.kind === 'string'
    && typeof value.name === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.url === 'string'
}

function collectAssetRefs(value: unknown, refs = new Map<string, AssetRef>()): Map<string, AssetRef> {
  if (isAssetRef(value)) {
    refs.set(value.id, value)
    return refs
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, refs)
    return refs
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) collectAssetRefs(item, refs)
  }
  return refs
}

function archivedGraph(graph: DirectorGraph): DirectorGraph {
  const cloned = structuredClone(graph)
  return {
    ...cloned,
    nodes: cloned.nodes.map(node => {
      if (node.data.status !== 'queued' && node.data.status !== 'running') return node
      const data = { ...node.data, status: 'idle' as const }
      delete data.phase
      delete data.progress
      delete data.jobId
      delete data.error
      delete data.runStartedAt
      delete data.runCompletedAt
      return { ...node, data }
    }),
  }
}

function clearedRuntimeData(data: DirectorNodeData, suppressPreview = false): DirectorNodeData {
  const {
    asset: _asset,
    assets: _assets,
    text: _text,
    mediaKind: _mediaKind,
    result: _result,
    derivedFrom: _derivedFrom,
    phase: _phase,
    progress: _progress,
    error: _error,
    jobId: _jobId,
    outputSeed: _outputSeed,
    batchRunId: _batchRunId,
    batchCaseIndex: _batchCaseIndex,
    batchFrozenCase: _batchFrozenCase,
    previewCleared: _previewCleared,
    status: _status,
    runStartedAt: _runStartedAt,
    runCompletedAt: _runCompletedAt,
    ...rest
  } = data
  return {
    ...rest,
    status: 'idle',
    ...(suppressPreview ? { previewCleared: true } : {}),
  }
}

function portableArchivedGraph(graph: DirectorGraph): DirectorGraph {
  const cloned = archivedGraph(graph)
  return {
    ...cloned,
    nodes: cloned.nodes.map(node => node.data.kind.startsWith('load-')
      ? node
      : {
          ...node,
          data: clearedRuntimeData(node.data, node.data.kind === 'preview'),
        }),
  }
}

async function archiveForProject(
  project: VideoProject,
  options: { portable?: boolean } = {},
): Promise<ProjectArchive> {
  const graph = options.portable === true ? portableArchivedGraph(project.graph) : archivedGraph(project.graph)
  const refs = [...collectAssetRefs([graph, project.mediaLibrary]).values()]
  const assets = await Promise.all(refs.map(async (asset): Promise<ProjectArchiveAsset> => {
    const response = await fetch(asset.url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Could not export asset “${asset.name}” (${String(response.status)}).`)
    return {
      sourceId: asset.id,
      origin: asset.origin,
      kind: asset.kind,
      name: asset.name,
      mimeType: asset.mimeType,
      dataBase64: base64(new Uint8Array(await response.arrayBuffer())),
    }
  }))
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      graph,
      settings: structuredClone(project.settings),
      ...(project.mediaLibrary === undefined ? {} : { mediaLibrary: structuredClone(project.mediaLibrary) }),
    },
    assets,
  }
}

function parseProjectArchive(text: string): ProjectArchive {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The selected file is not valid JSON.')
  }
  if (!isObject(parsed) || parsed.format !== PROJECT_ARCHIVE_FORMAT || parsed.version !== PROJECT_ARCHIVE_VERSION) {
    throw new Error('The selected file is not a supported Video Director project export.')
  }
  const project = parsed.project
  if (!isObject(project) || typeof project.name !== 'string' || project.name.trim() === '' || project.name.length > 120) {
    throw new Error('The project export has an invalid project name.')
  }
  const graph = project.graph
  if (!isObject(graph) || !Array.isArray(graph.nodes) || graph.nodes.length > 2_000 || !Array.isArray(graph.edges) || graph.edges.length > 5_000) {
    throw new Error('The project export has an invalid canvas.')
  }
  const viewport = graph.viewport
  if (!isObject(viewport)
    || typeof viewport.x !== 'number' || !Number.isFinite(viewport.x)
    || typeof viewport.y !== 'number' || !Number.isFinite(viewport.y)
    || typeof viewport.zoom !== 'number' || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || viewport.zoom > 8) {
    throw new Error('The project export has an invalid canvas viewport.')
  }
  if (!isObject(project.settings)) throw new Error('The project export has invalid settings.')
  if (!Array.isArray(parsed.assets) || parsed.assets.length > 5_000) {
    throw new Error('The project export has an invalid asset list.')
  }
  const sourceIds = new Set<string>()
  const kinds = new Set<AssetRef['kind']>(['image', 'audio', 'video', 'sketch', 'mask'])
  const assets = parsed.assets.map((value, index): ProjectArchiveAsset => {
    if (!isObject(value)
      || typeof value.sourceId !== 'string' || value.sourceId === ''
      || !kinds.has(value.kind as AssetRef['kind'])
      || typeof value.name !== 'string' || value.name === '' || value.name.length > 240
      || typeof value.mimeType !== 'string' || value.mimeType === ''
      || (value.origin !== undefined && value.origin !== 'input' && value.origin !== 'output')
      || typeof value.dataBase64 !== 'string' || value.dataBase64 === ''
      || value.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.dataBase64)) {
      throw new Error(`The project export has invalid asset data at position ${String(index + 1)}.`)
    }
    if (sourceIds.has(value.sourceId)) throw new Error(`The project export contains duplicate asset ${value.sourceId}.`)
    sourceIds.add(value.sourceId)
    return {
      sourceId: value.sourceId,
      origin: value.origin as AssetRef['origin'],
      kind: value.kind as AssetRef['kind'],
      name: value.name,
      mimeType: value.mimeType,
      dataBase64: value.dataBase64,
    }
  })
  const clonedGraph = structuredClone(graph) as unknown as DirectorGraph
  clonedGraph.nodes = clonedGraph.nodes.map(node => {
    if (node.data.kind.startsWith('load-')) return node
    const outputRefs = collectAssetRefs([node.data.asset, node.data.assets, node.data.result])
    const hasUnavailableOutput = [...outputRefs.keys()].some(id => !sourceIds.has(id))
    return hasUnavailableOutput
      ? { ...node, data: clearedRuntimeData(node.data, node.data.kind === 'preview') }
      : node
  })
  if (project.mediaLibrary !== undefined && !Array.isArray(project.mediaLibrary)) throw new Error('The media library must be an array.')
  for (const asset of collectAssetRefs([clonedGraph, project.mediaLibrary]).values()) {
    if (!sourceIds.has(asset.id)) throw new Error(`The project export is missing data for asset “${asset.name}”.`)
  }
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
    project: {
      name: project.name.trim(),
      graph: clonedGraph,
      settings: structuredClone(project.settings),
      ...(project.mediaLibrary === undefined ? {} : { mediaLibrary: structuredClone(project.mediaLibrary) as AssetRef[] }),
    },
    assets,
  }
}

function rewriteArchiveAssets(
  value: unknown,
  assets: ReadonlyMap<string, AssetRef>,
  parentKey?: string,
): unknown {
  if (isAssetRef(value)) {
    const replacement = assets.get(value.id)
    if (replacement === undefined) throw new Error(`Imported asset ${value.id} was not restored.`)
    return structuredClone(replacement)
  }
  if (Array.isArray(value)) return value.map(item => rewriteArchiveAssets(item, assets))
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      rewriteArchiveAssets(item, assets, key),
    ]))
  }
  if (typeof value === 'string' && (parentKey === 'assetId' || parentKey === 'maskAssetId')) {
    return assets.get(value)?.id ?? value
  }
  return value
}

function projectArchiveFilename(name: string): string {
  const safe = name.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
    .replace(/\s+/gu, ' ')
    .slice(0, 100)
  return `${safe === '' ? 'video-project' : safe}.video-director.json`
}

function nodeTitle(kind: Exclude<MediaKind, 'mask' | 'flow'>): string {
  return ({
    text: 'Text', image: 'Image', audio: 'Audio', video: 'Video', sketch: 'Sketch',
  })[kind]
}


function initializeDefaultRegisteredImageWorkflows(
  project: VideoProject,
  providers: readonly ProviderDescriptor[],
  workflows: readonly ComfyWorkflowDescriptor[],
): VideoProject {
  let changed = false
  const nodes = project.graph.nodes.map(node => {
    const data = withDefaultRegisteredImageWorkflow(node.data, providers, workflows)
    if (data === node.data) return node
    changed = true
    return { ...node, data }
  })
  return changed ? { ...project, graph: { ...project.graph, nodes } } : project
}

function normalizeLegacyProject(project: VideoProject): VideoProject {
  let changed = false
  const nodes = project.graph.nodes.map(node => {
    let data = node.data
    if (node.data.providerId === 'comfyui-mcp') {
      changed = true
      data = { ...data, providerId: 'comfyui' }
    }
    if (data.kind === 'prompt-enhancer' && (
      data.providerId === undefined
      || data.providerId === ''
      || data.providerId === 'comfyui'
      || data.providerId === 'comfyui-mcp'
    )) {
      changed = true
      data = { ...data, providerId: 'ollama' }
    }
    if (data.kind === 'image-generation' && data.title === 'Generate Image') {
      changed = true
      data = { ...data, title: 'Image Processing' }
    }
    if (data.kind === 'ollama-eject' || data.kind === 'comfyui-clear') {
      changed = true
      data = {
        ...data,
        kind: 'vram-trigger',
        nodeType: 'core.vram-trigger',
        nodeVersion: '1.0.0',
        nodeDigest: 'builtin:core.vram-trigger@1.0.0',
        vramAction: data.kind,
        vramReleaseWaitSeconds: 10,
        vramActionInitialized: true,
      }
    } else if (data.kind === 'vram-trigger') {
      const action = data.vramAction === 'ollama-eject' || data.vramAction === 'comfyui-clear' || data.vramAction === 'skip'
        ? data.vramAction
        : 'skip'
      const candidateWait = data.vramReleaseWaitSeconds ?? data.vramTimeoutSeconds
      const releaseWait = Number.isSafeInteger(candidateWait)
        && candidateWait! >= 0
        && candidateWait! <= 300
        ? candidateWait
        : 10
      if (action !== data.vramAction
        || releaseWait !== data.vramReleaseWaitSeconds
        || Object.hasOwn(data, 'vramTimeoutSeconds')) {
        changed = true
        const { vramTimeoutSeconds: _legacyTimeout, ...current } = data
        data = { ...current, vramAction: action, vramReleaseWaitSeconds: releaseWait }
      }
    }
    return data === node.data ? node : { ...node, data }
  })
  return changed ? { ...project, graph: { ...project.graph, nodes } } : project
}

function vramActionForUpstream(
  source: DirectorNode | undefined,
  providers: readonly ProviderDescriptor[],
): NonNullable<DirectorNodeData['vramAction']> {
  if (source === undefined) return 'skip'
  const provider = providers.find(candidate => candidate.id === source.data.providerId)
  if (provider?.kind === 'ollama') return 'ollama-eject'
  if (provider?.kind === 'comfyui' || provider?.kind === 'comfyui-mcp') return 'comfyui-clear'
  return 'skip'
}

function initializeConnectedVramTriggers(
  nodes: readonly DirectorNode[],
  edges: readonly DirectorEdge[],
  providers: readonly ProviderDescriptor[],
): DirectorNode[] {
  const nodesById = new Map(nodes.map(node => [node.id, node]))
  const firstIncoming = new Map<string, DirectorEdge>()
  for (const edge of edges) {
    if (!firstIncoming.has(edge.target)) firstIncoming.set(edge.target, edge)
  }
  return nodes.map(node => {
    if (node.data.kind !== 'vram-trigger' || node.data.vramActionInitialized === true) return node
    const incoming = firstIncoming.get(node.id)
    if (incoming === undefined) return node
    return {
      ...node,
      data: {
        ...node.data,
        vramAction: vramActionForUpstream(nodesById.get(incoming.source), providers),
        vramActionInitialized: true,
      },
    }
  })
}

function initializeProjectVramTriggers(
  project: VideoProject,
  providers: readonly ProviderDescriptor[],
): VideoProject {
  const nodes = initializeConnectedVramTriggers(project.graph.nodes, project.graph.edges, providers)
  return sameJson(nodes, project.graph.nodes) ? project : { ...project, graph: { ...project.graph, nodes } }
}

function normalizeLoadedPromptValidation(project: VideoProject): VideoProject {
  let changed = false
  const nodes = project.graph.nodes.map(node => {
    const emptyPrompt = node.data.kind === 'prompt-enhancer'
      && (typeof node.data.prompt !== 'string' || node.data.prompt.trim() === '')
    const staleValidation = node.data.phase === 'validation-failed'
      || node.data.error === 'prompt length must be between 1 and 100000'
    if (!emptyPrompt || !staleValidation) return node
    changed = true
    return {
      ...node,
      data: {
        ...node.data,
        status: 'idle' as const,
        phase: undefined,
        progress: undefined,
        error: undefined,
        jobId: undefined,
      },
    }
  })
  return changed ? { ...project, graph: { ...project.graph, nodes } } : project
}





function edgeFieldInputId(edge: DirectorEdge): string | undefined {
  const stored = fieldIdFromInputPort(edge.data?.targetPortId)
  if (stored !== undefined) return stored
  return typeof edge.targetHandle === 'string' && edge.targetHandle.startsWith('in:')
    ? fieldIdFromInputPort(edge.targetHandle.slice(3))
    : undefined
}





const EXECUTABLE_NODE_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
  'video-trim', 'video-crop', 'video-extract-frame',
  'vram-trigger',
  'ollama-eject',
  'comfyui-clear',
])

function duplicatedNodeData(data: DirectorNodeData, patch: Partial<DirectorNodeData>): DirectorNodeData {
  const merged = { ...data, ...patch }
  if (merged.kind === 'batch-input' || merged.kind === 'batch-output') return { ...clearedRuntimeData(merged), batchRunId: undefined, batchCaseIndex: undefined }
  if (merged.kind === 'preview' || merged.kind === 'save') return clearedSinkData(merged)
  if (!EXECUTABLE_NODE_KINDS.has(merged.kind)) return { ...merged, status: 'idle', jobId: undefined, error: undefined, runStartedAt: undefined, runCompletedAt: undefined }
  const {
    asset: _asset,
    assets: _assets,
    text: _text,
    mediaKind: _mediaKind,
    result: _result,
    phase: _phase,
    progress: _progress,
    error: _error,
    jobId: _jobId,
    derivedFrom: _derivedFrom,
    outputSeed: _outputSeed,
    runStartedAt: _runStartedAt,
    runCompletedAt: _runCompletedAt,
    ...rest
  } = merged
  return { ...rest, status: 'idle' }
}


export class DirectorController implements ObservableSource<DirectorSnapshot> {
  private snapshot = emptySnapshot()
  private baseProject: VideoProject | null = null
  private readonly listeners = new Set<() => void>()
  private savePromise: Promise<void> | null = null
  private editVersion = 0
  private savedState: ProjectHistoryState | null = null
  private readonly undoStack: ProjectHistoryState[] = []
  private readonly redoStack: ProjectHistoryState[] = []
  private historyTransaction: { projectId: string; before: ProjectHistoryState } | null = null
  private projectGeneration = 0
  private transitionVersion = 0
  private disposed = false
  private readonly jobTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private hostObservationTimer?: ReturnType<typeof setTimeout>
  private runRefresh: Promise<void> | null = null
  private readonly activeRuns = new Map<string, ActiveNodeRun>()
  private submissionTail: Promise<unknown> = Promise.resolve()
  private readonly hostSubmissions = new Map<string, Promise<unknown>>()
  private readonly modelRefreshVersions = new Map<string, number>()
  private nodeClipboard: { projectId: string; nodes: DirectorNode[]; edges: DirectorEdge[] } | null = null
  private readonly drafts: ProjectDraftCache
  private reorderVersion = 0

  constructor(private readonly ctx: ClientContext) {
    this.drafts = new ProjectDraftCache(
      (projectId, draft) => this.rpc('projects/draft', { projectId, draft }),
      error => { if (!this.disposed) this.patch({ error: `Could not cache workflow changes: ${errorMessage(error)}` }) },
    )
  }

  getSnapshot = (): DirectorSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async start(): Promise<void> {
    this.patch({ phase: 'loading', error: null })
    try {
      const [projects, providers, workflows, nodes] = await Promise.all([
        this.rpc<{ projects: ProjectSummary[]; projectFolders?: ProjectFolderLayout }>('projects/list', {}),
        this.rpc<{ providers: ProviderDescriptor[] }>('providers/list', {}),
        this.rpc<{ workflows: ComfyWorkflowDescriptor[] }>('workflows/list', {}),
        this.rpc<{ nodeDefinitions: VdNodeDefinitionDescriptor[] }>('nodes/list', {})
          .catch(() => ({ nodeDefinitions: [] })),
      ])
      const recoveredProjects = projects.projects.map(project => {
        const entry = this.drafts.recover(project.id)
        return entry === undefined ? project : { ...project, name: entry.draft?.name ?? project.name,
          nodeCount: entry.draft?.graph.nodes.length ?? project.nodeCount, unsaved: entry.draft !== null || project.hasSavedVersion === false }
      })
      this.patch({
        projects: recoveredProjects,
        projectFolders: projects.projectFolders,
        providers: providers.providers,
        workflows: workflows.workflows,
        nodeDefinitions: nodes.nodeDefinitions,
        phase: 'ready',
      })
      for (const provider of providers.providers) {
        if (provider.configured && (provider.kind === 'codex-plan' || provider.kind === 'ollama' || provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp')) {
          void this.refreshProviderModels(provider.id)
        }
      }
      const currentSession = this.ctx.sessions.list.getSnapshot().current
      const selected = projects.projects.find(project => project.sessionId === currentSession) ?? projects.projects[0]
      if (selected !== undefined) await this.loadProject(selected.id, false)
      void this.drafts.flush().catch(error => this.patch({ error: errorMessage(error) }))
    } catch (error) {
      this.patch({ phase: 'error', error: errorMessage(error) })
    }
  }

  open = (): void => { this.patch({ open: true }) }

  close = (): void => { this.patch({ open: false }) }

  private stopObservingRuns(message: string): void {
    for (const active of this.activeRuns.values()) active.completion?.reject(new Error(message))
  }

  dispose = (): void => {
    this.disposed = true
    this.drafts.dispose()
    for (const timer of this.jobTimers.values()) clearTimeout(timer)
    this.jobTimers.clear()
    clearTimeout(this.hostObservationTimer)
    this.stopObservingRuns('Job monitoring was disposed.')
    this.activeRuns.clear()
    this.listeners.clear()
  }

  async createProject(name: string, location?: { parentId: string | null; expectedRevision: number }): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before creating another project.')
    }
    if (this.snapshot.saving) throw new Error('Wait for the current save to finish before creating another project.')
    await this.cacheBeforeSwitch()
    const transition = ++this.transitionVersion
    this.patch({ phase: 'loading', error: null, conflict: false })
    try {
      const sessionId = await this.ctx.sessions.create()
      const binding = this.requireSessionBinding(sessionId)
      await this.renameSession(binding, name)
      const { project, projectFolders } = await this.rpc<{ project: VideoProject; projectFolders?: ProjectFolderLayout }>('projects/create', {
        name, sessionId, unsaved: true, ...(location ? { parentId: location.parentId, expectedFolderRevision: location.expectedRevision } : {}),
      })
      if (transition !== this.transitionVersion) return
      const projects = [
        { ...project, nodeCount: project.graph.nodes.length },
        ...this.snapshot.projects.filter(row => row.id !== project.id),
      ]
      this.baseProject = structuredClone(project)
      this.savedState = this.historyState(project)
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      this.ctx.sessions.open(project.sessionId)
      this.patch({ project, projects, ...(projectFolders ? { projectFolders } : {}), dirty: project.hasSavedVersion === false, saving: false, phase: 'ready' })
    } catch (error) {
      if (transition === this.transitionVersion) this.patch({ phase: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async exportProject(projectId = this.requireProject().id): Promise<ExportedProjectArchive> {
    const project = await this.projectForAction(projectId)
    try {
      const archive = await archiveForProject(project, { portable: true })
      return {
        filename: projectArchiveFilename(project.name),
        text: `${JSON.stringify(archive, null, 2)}\n`,
      }
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  refreshVdRuns(): Promise<void> {
    if (this.runRefresh) return this.runRefresh
    this.runRefresh = this.fetchVdRuns().finally(() => { this.runRefresh = null; this.scheduleHostObservation() })
    return this.runRefresh
  }

  private scheduleHostObservation(): void {
    if (this.disposed || this.hostObservationTimer || !this.snapshot.workflowRuns.some(run => run.scheduler === 'host' && ['queued', 'running'].includes(run.status))) return
    this.hostObservationTimer = setTimeout(() => {
      this.hostObservationTimer = undefined
      void this.refreshVdRuns().catch(() => {})
    }, JOB_POLL_MS)
  }

  private async fetchVdRuns(): Promise<void> {
    const [{ runs }, { jobs }, { projects, projectFolders }] = await Promise.all([
      this.rpc<{ runs: VdRun[] }>('vd-runs/list', {}),
      this.rpc<{ jobs: DirectorJob[] }>('jobs/list', {}),
      this.rpc<{ projects: ProjectSummary[]; projectFolders?: ProjectFolderLayout }>('projects/list', {}),
    ])
    if (this.disposed) return
    const previousRuns = this.snapshot.workflowRuns
    const localRuns = previousRuns.filter(run => this.hostSubmissions.has(run.id) && !runs.some(row => row.id === run.id))
    const current = this.snapshot.project
    this.patch({ workflowRuns: [...runs, ...localRuns], jobs, projectFolders, projects: projects.map(project => {
      const draft = this.drafts.recover(project.id)?.draft
      return project.id === current?.id ? { ...project, name: current.name, unsaved: this.snapshot.dirty }
        : draft ? { ...project, name: draft.name, nodeCount: draft.graph.nodes.length, unsaved: true } : project
    }) })
    if (current) {
      if (runs.some(run => run.projectId === current.id && run.status === 'running'
        && !previousRuns.some(previous => previous.id === run.id && previous.executionStartedAt === run.executionStartedAt && previous.status === 'running'))) this.resetRunStatuses(current.id)
      const visible = jobs.filter(job => job.projectId === current.id)
      this.updateVisibleJobs(visible)
      for (const job of visible) {
        const previous = current.jobs.find(item => item.id === job.id)
        const node = this.snapshot.project?.graph.nodes.find(node => node.id === job.nodeId)
        if (!node || node.data.frozen || job.batchRunId || this.activeRuns.has(this.runKey(job.nodeId))) continue
        if (previous?.status === job.status && previous?.updatedAt === job.updatedAt) continue
        this.updateSystemNode(job.nodeId, { jobId: job.id, status: job.status === 'orphaned' ? 'failed' : job.status === 'cancelled' ? 'idle' : job.status,
          phase: job.phase, progress: job.progress, error: job.error, runStartedAt: job.startedAt, runCompletedAt: job.completedAt })
        if (job.status === 'completed' && job.result && node.data.mediaEditedFromJobId !== job.id) this.applyJobResult(job.nodeId, job.result)
      }
      for (const run of runs.filter(run => run.projectId === current.id && run.kind === 'batch')) {
        if (this.snapshot.batchCases[run.id] || ['queued', 'running'].includes(run.status)) {
          const rows = await this.loadBatchCases(run.id)
          const node = this.snapshot.project?.graph.nodes.find(node => node.id === run.batchInputNodeId)
          if (node?.data.batchRunId === run.id && !node.data.frozen) this.updateSystemNode(node.id, {
            status: run.status === 'cancelled' ? 'idle' : run.status, phase: run.status, error: run.error,
            batchCaseIndex: rows.find(row => row.status === 'running')?.caseIndex ?? rows.filter(row => row.status === 'completed').at(-1)?.caseIndex,
            progress: rows.length ? rows.filter(row => row.status === 'completed').length / rows.length : 0,
          })
        }
      }
    }
  }

  private async waitForPendingNodeSubmissions(projectId: string, signal: AbortSignal): Promise<void> {
    // A direct job dispatched just before Run must reach the Host queue first.
    // Otherwise the workflow could reserve the slot its own dependency needs.
    while ([...this.activeRuns.values()].some(run => run.projectId === projectId && !run.workflowRunId && !run.jobId)) {
      try { await waitForRunTurn(new Promise<void>(resolve => setTimeout(resolve, 100)), signal) }
      catch (error) { if (signal.aborted) return; throw error }
    }
  }

  private submitToHost(projectId: string, endpoint: string, payload: unknown, provisional: VdRun[]): Promise<{ runs: VdRun[] }> {
    provisional.forEach(run => this.storeVdRun(run))
    const request = this.submissionTail.catch(() => {}).then(() => this.waitForPendingNodeSubmissions(projectId, new AbortController().signal))
      .then(() => this.rpc<{ runs: VdRun[] }>(endpoint, payload))
    this.submissionTail = request
    for (const run of provisional) this.hostSubmissions.set(run.id, request)
    return request.then(result => { result.runs.forEach(run => this.storeVdRun(run)); return result }, error => {
      this.patch({ workflowRuns: this.snapshot.workflowRuns.filter(run => !provisional.some(item => item.id === run.id)), error: errorMessage(error) })
      throw error
    }).finally(() => { for (const run of provisional) this.hostSubmissions.delete(run.id) })
  }

  private async submittedVdWorkflow(runId: string): Promise<Pick<VideoProject, 'name' | 'graph' | 'settings'>> {
    const { run } = await this.rpc<{ run: VdRun & { snapshot: Pick<VideoProject, 'name' | 'graph' | 'settings'> } }>(
      'vd-runs/get', { projectId: this.snapshot.workflowRuns.find(run => run.id === runId)?.projectId ?? this.requireProject().id, runId },
    )
    return run.snapshot
  }

  async openVdWorkflow(runId: string): Promise<void> {
    try {
      const projectId = this.snapshot.workflowRuns.find(run => run.id === runId)?.projectId ?? this.requireProject().id
      await this.selectProject(projectId)
      const submitted = await this.submittedVdWorkflow(runId)
      if (this.snapshot.project?.id !== projectId) return
      const project = this.requireProject()
      // Opening is an ordinary undoable canvas edit. Execution uses its own graph.
      this.updateProject({ ...project, graph: archivedGraph(submitted.graph), settings: submitted.settings })
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  async exportVdWorkflow(runId: string): Promise<ExportedProjectArchive> {
    try {
      const project = await this.projectForAction(this.snapshot.workflowRuns.find(run => run.id === runId)?.projectId ?? this.requireProject().id)
      const submitted = await this.submittedVdWorkflow(runId)
      const archive = await archiveForProject({ ...project, ...submitted })
      return { filename: projectArchiveFilename(`${submitted.name}-${runId.slice(0, 8)}`), text: `${JSON.stringify(archive, null, 2)}\n` }
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  async duplicateProject(projectId = this.requireProject().id): Promise<void> {
    const project = await this.projectForAction(projectId)
    const usedNames = new Set(this.snapshot.projects.map(value => value.name.toLocaleLowerCase()))
    let copyNumber = 1
    let name = ''
    do {
      const suffix = copyNumber === 1 ? ' Copy' : ` Copy ${String(copyNumber)}`
      name = `${project.name.slice(0, Math.max(1, 120 - suffix.length)).trimEnd()}${suffix}`
      copyNumber += 1
    } while (usedNames.has(name.toLocaleLowerCase()))
    const graph = archivedGraph(project.graph)
    await this.installProjectArchive(name, async () => ({
      format: PROJECT_ARCHIVE_FORMAT, version: PROJECT_ARCHIVE_VERSION, exportedAt: new Date().toISOString(),
      project: { name, graph, settings: structuredClone(project.settings), mediaLibrary: project.mediaLibrary }, assets: [],
    }), [...collectAssetRefs([graph, project.mediaLibrary]).values()])
  }

  async importProject(text: string): Promise<void> {
    let archive: ProjectArchive
    try {
      archive = parseProjectArchive(text)
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
    await this.installProjectArchive(archive.project.name, async () => archive)
  }

  async refreshExamples(): Promise<void> {
    if (this.snapshot.examplesLoading) return
    this.patch({ examplesLoading: true, examplesError: null })
    try {
      const result = await this.rpc<{ examples: DirectorSnapshot['examples'] }>('examples/list', {})
      if (!this.disposed) this.patch({ examples: result.examples })
    } catch (error) {
      if (!this.disposed) this.patch({ examplesError: errorMessage(error) })
    } finally {
      if (!this.disposed) this.patch({ examplesLoading: false })
    }
  }

  async openExample(id: string): Promise<void> {
    try {
      if (this.snapshot.saving || this.snapshot.phase === 'loading') throw new Error('Wait for the current project operation before opening an example.')
      await this.installProjectArchive(archive => {
        const usedNames = new Set(this.snapshot.projects.map(project => project.name.toLocaleLowerCase()))
        let name = archive.project.name
        for (let count = 2; usedNames.has(name.toLocaleLowerCase()); count++) {
          const suffix = ` (${count})`
          name = archive.project.name.slice(0, 120 - suffix.length).trimEnd() + suffix
        }
        return name
      }, async () => {
        const result = await this.rpc<{ archive: string }>('examples/get', { id })
        return parseProjectArchive(result.archive)
      })
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  async startNewChatSession(): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before starting a new session.')
    }
    if (this.snapshot.saving) {
      throw new Error('Wait for the current save to finish before starting a new session.')
    }
    const project = this.requireProject()
    const projectId = project.id
    const sessionId = await this.ctx.sessions.create()
    const binding = this.requireSessionBinding(sessionId)
    await this.renameSession(binding, project.name)
    const persisted = (await this.rpc<{ project: VideoProject }>('projects/session', {
      projectId,
      sessionId,
    })).project
    const current = this.snapshot.project
    if (current === null || current.id !== projectId) return

    const visible: VideoProject = {
      ...current,
      sessionId: persisted.sessionId,
      revision: persisted.revision,
      status: persisted.status,
      jobs: persisted.jobs,
      updatedAt: persisted.updatedAt,
    }
    if (this.baseProject !== null && this.baseProject.id === projectId) {
      this.baseProject = {
        ...this.baseProject,
        sessionId: persisted.sessionId,
        revision: persisted.revision,
        status: persisted.status,
        jobs: persisted.jobs,
        updatedAt: persisted.updatedAt,
      }
    }
    const projects = this.snapshot.projects.map(summary => summary.id === projectId
      ? { ...visible, nodeCount: visible.graph.nodes.length }
      : summary)
    this.ctx.sessions.open(sessionId)
    this.patch({ project: visible, projects, error: null })
  }

  async selectProject(projectId: string, options: { discard?: boolean } = {}): Promise<void> {
    if (projectId === this.snapshot.project?.id) return
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before switching projects.')
    }
    if (this.snapshot.saving) {
      throw new Error('Wait for the current save to finish before switching projects.')
    }
    if (options.discard === true) await this.discardChanges()
    await this.cacheBeforeSwitch()
    await this.loadProject(projectId, true)
  }

  private async cacheBeforeSwitch(): Promise<void> {
    this.patch({ phase: 'loading' })
    try { await this.drafts.flush() }
    catch (error) { this.patch({ phase: 'ready', error: errorMessage(error) }); throw error }
  }

  async flushDrafts(): Promise<void> { await this.drafts.flush() }

  loadGallery = async (signal?: AbortSignal): Promise<GalleryProject[]> => {
    const { projects } = await this.rpc<{ projects: GalleryProject[] }>('gallery/list', {}, signal)
    return projects
  }

  /** Media edits replace references, never shared bytes or captured generation jobs. */
  editMedia: EditMedia = async (source, edit, action, signal) => {
    const before = await this.projectForAction(source.projectId)
    const owners = before.graph.nodes.filter(node => collectAssetRefs(node.data).has(source.id)).map(node => node.id)
    const result = await this.rpc<MediaEditResult>('media/edit', { projectId: source.projectId, assetId: source.id, edit, action }, signal)
    signal.throwIfAborted()
    if (!('asset' in result)) return result
    const current = await this.projectForAction(source.projectId)
    const replacement = result.asset
    if (owners.length && !current.graph.nodes.some(node => owners.includes(node.id) && collectAssetRefs(node.data).has(source.id))) {
      throw new Error('The source changed while editing. Reopen its preview and try again.')
    }
    const replace = (value: unknown): unknown => {
      if (isAssetRef(value)) return value.id === source.id ? replacement : value
      if (Array.isArray(value)) return value.map(replace)
      if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
      return value
    }
    const nodes = current.graph.nodes.map(node => {
      if (!collectAssetRefs(node.data).has(source.id)) return node
      const data = replace(node.data) as DirectorNodeData
      const job = current.jobs.filter(job => job.nodeId === node.id).at(-1)
      return { ...node, data: { ...data, maskAsset: undefined, trim: { start: 0 }, mediaEditId: replacement.id,
        ...(job ? { mediaEditedFromJobId: job.id } : {}) } }
    })
    const library = (current.mediaLibrary ?? []).filter(asset => action === 'copy' || asset.id !== source.id)
    if (action === 'copy' && !library.some(asset => asset.id === source.id)) library.push(source)
    library.push(replacement)
    const next = { ...current, graph: { ...current.graph, nodes: recomputeSinkPayloads(nodes, current.graph.edges, this.snapshot.nodeDefinitions) }, mediaLibrary: library }
    if (this.snapshot.project?.id === source.projectId) this.updateProject(next)
    else {
      this.drafts.stage(source.projectId, this.historyState(next))
      this.patch({ projects: this.snapshot.projects.map(row => row.id === source.projectId ? { ...row, unsaved: true } : row) })
    }
    await this.drafts.flush(source.projectId)
    return result
  }

  private async projectForAction(projectId: string): Promise<VideoProject> {
    if (projectId === this.snapshot.project?.id) return structuredClone(this.snapshot.project)
    await this.drafts.flush(projectId)
    const { project } = await this.rpc<{ project: VideoProject }>('projects/get', { projectId })
    const { draft, ...saved } = project
    return { ...saved, ...draft }
  }

  async renameProjectById(projectId: string, name: string): Promise<void> {
    if (projectId === this.snapshot.project?.id) { this.renameProject(name); return }
    await this.drafts.flush(projectId)
    const { project: saved } = await this.rpc<{ project: VideoProject }>('projects/get', { projectId })
    const project = { ...saved, ...saved.draft }
    if (project.name === name) return
    const draft = this.historyState({ ...project, name })
    const unsaved = saved.hasSavedVersion === false || !sameJson(draft, this.historyState(saved))
    this.drafts.stage(projectId, unsaved ? draft : null)
    this.patch({ projects: this.snapshot.projects.map(row => row.id === projectId ? { ...row, name, unsaved } : row) })
    await this.drafts.flush(projectId)
  }

  async reorderProjects(projectIds: string[]): Promise<void> {
    const before = this.snapshot.projects
    if (projectIds.length !== before.length || new Set(projectIds).size !== before.length
      || projectIds.some(id => !before.some(project => project.id === id))) return
    const version = ++this.reorderVersion
    this.patch({ projects: projectIds.map(id => before.find(project => project.id === id)!) })
    try { await this.rpc('projects/reorder', { projectIds }) }
    catch (error) {
      if (version === this.reorderVersion) this.patch({ projects: before, error: errorMessage(error) })
      throw error
    }
  }

  async refreshProjectFolders(): Promise<void> {
    const result = await this.rpc<{ projects: ProjectSummary[]; projectFolders: ProjectFolderLayout }>('projects/list', {})
    if (!this.disposed) this.patch({ projectFolders: result.projectFolders, projects: this.preserveLocalSummaries(result.projects) })
  }

  private preserveLocalSummaries(projects: ProjectSummary[]): ProjectSummary[] {
    return projects.map(project => {
      if (project.id === this.snapshot.project?.id) return { ...project, name: this.snapshot.project.name, unsaved: this.snapshot.dirty }
      const draft = this.drafts.recover(project.id)?.draft
      return draft ? { ...project, name: draft.name, nodeCount: draft.graph.nodes.length, unsaved: true } : project
    })
  }

  async organizeProjects(change: ProjectFolderChange): Promise<void> {
    const deleting = (change.action === 'delete' && change.mode === 'delete-workflows')
      || (change.action === 'batch-delete' && (change.projectIds.length > 0 || change.mode === 'delete-workflows'))
    if (this.snapshot.saving || this.snapshot.phase === 'loading') throw new Error('Wait for the current project operation to finish.')
    if (deleting) this.patch({ phase: 'loading' })
    try {
      if (deleting) await this.drafts.flush()
      const result = await this.rpc<{ projects: ProjectSummary[]; projectFolders: ProjectFolderLayout; deletedProjectIds: string[] }>('projects/organize', change)
      for (const id of result.deletedProjectIds) this.drafts.forget(id)
      const deletedCurrent = this.snapshot.project && result.deletedProjectIds.includes(this.snapshot.project.id)
      this.patch({ projectFolders: result.projectFolders, projects: this.preserveLocalSummaries(result.projects), ...(deleting ? { phase: 'ready' as const } : {}) })
      if (deletedCurrent) {
        this.projectGeneration++
        this.baseProject = null; this.savedState = null; this.editVersion = 0; this.resetHistory()
        this.patch({ project: null, dirty: false, conflict: false, canvasResetVersion: this.snapshot.canvasResetVersion + 1 })
        if (result.projects[0]) await this.loadProject(result.projects[0].id, true)
      }
    } catch (error) {
      if (deleting) this.patch({ phase: 'ready' })
      await this.refreshProjectFolders().catch(() => {})
      throw error
    }
  }

  async discardChanges(projectId = this.snapshot.project?.id): Promise<void> {
    if (projectId === undefined) return
    if (this.snapshot.saving || this.snapshot.phase === 'loading') throw new Error('Wait for the current project operation before discarding changes.')
    const current = this.snapshot.project?.id === projectId
    if ([...this.activeRuns.values()].some(run => run.projectId === projectId)
      || this.snapshot.workflowRuns.some(run => run.projectId === projectId && ['queued', 'running'].includes(run.status))) {
      throw new Error('Wait for tasks in this workflow to finish or cancel them before discarding changes.')
    }
    this.patch({ phase: 'loading', error: null })
    try {
      await this.drafts.flush(projectId)
      const result = await this.rpc<{ project: VideoProject | null; projects: ProjectSummary[] }>('projects/discard', { projectId })
      this.drafts.forget(projectId)
      this.patch({ projects: result.projects, phase: 'ready' })
      if (!current) return
      this.resetHistory()
      this.baseProject = null
      this.savedState = null
      this.patch({ project: null, dirty: false, canvasResetVersion: this.snapshot.canvasResetVersion + 1 })
      const nextId = result.project?.id ?? result.projects[0]?.id
      if (nextId !== undefined) await this.loadProject(nextId, result.project === null)
    } catch (error) {
      this.patch({ phase: 'ready', error: errorMessage(error) })
      throw error
    }
  }

  async deleteProject(projectId: string = this.requireProject().id): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before deleting a project.')
    }
    if (this.snapshot.saving) {
      throw new Error('Wait for the current save to finish before deleting a project.')
    }
    if (!this.snapshot.projects.some(project => project.id === projectId)) {
      throw new Error(`Project ${projectId} was not found.`)
    }

    const transition = ++this.transitionVersion
    const deletingCurrent = this.snapshot.project?.id === projectId
    this.patch({ phase: 'loading', error: null, conflict: false })
    try {
      await this.drafts.flush(projectId)
      const result = await this.rpc<{ projects?: ProjectSummary[] }>('projects/delete', { projectId })
      this.drafts.forget(projectId)
      if (transition !== this.transitionVersion) return
      const projects = result.projects ?? this.snapshot.projects.filter(project => project.id !== projectId)
      if (!deletingCurrent) {
        this.patch({ projects, phase: 'ready' })
        return
      }

      this.projectGeneration += 1
      this.baseProject = null
      this.savedState = null
      this.editVersion = 0
      this.resetHistory()
      this.patch({
        projects,
        project: null,
        dirty: false,
        saving: false,
        conflict: false,
        phase: 'ready',
      })
      const nextProject = projects[0]
      if (nextProject !== undefined) await this.loadProject(nextProject.id, true)
    } catch (error) {
      if (transition === this.transitionVersion) this.patch({ phase: 'error', error: errorMessage(error) })
      throw error
    }
  }

  renameProject(name: string): void {
    const project = this.snapshot.project
    if (project === null || name.trim() === '') return
    this.updateProject({ ...project, name: name.trim() })
  }

  clearPreviews(): void {
    const project = this.snapshot.project
    if (project === null || this.snapshot.phase === 'loading' || this.snapshot.saving) return
    let changed = false
    const nodes = project.graph.nodes.map(node => {
      if (node.data.kind !== 'preview') return node
      const data = suppressedPreviewData(node.data)
      if (sameJson(data, node.data)) return node
      changed = true
      return { ...node, data }
    })
    if (!changed) return
    this.updateProject({
      ...project,
      graph: { ...project.graph, nodes },
    }, 'system-saveable')
  }

  undo(): void {
    const project = this.snapshot.project
    if (project === null || this.snapshot.phase === 'loading' || this.snapshot.saving) return
    this.endHistoryTransaction()
    const prior = this.undoStack.pop()
    if (prior === undefined) return
    this.pushBounded(this.redoStack, this.historyState(project))
    this.applyHistoryState(project, prior)
  }

  redo(): void {
    const project = this.snapshot.project
    if (project === null || this.snapshot.phase === 'loading' || this.snapshot.saving) return
    this.endHistoryTransaction()
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.pushBounded(this.undoStack, this.historyState(project))
    this.applyHistoryState(project, next)
  }

  beginHistoryTransaction(): void {
    const project = this.snapshot.project
    if (project === null || this.snapshot.phase === 'loading' || this.snapshot.saving || this.historyTransaction !== null) return
    this.historyTransaction = { projectId: project.id, before: this.historyState(project) }
  }

  endHistoryTransaction(): void {
    const transaction = this.historyTransaction
    this.historyTransaction = null
    const project = this.snapshot.project
    if (transaction === null || project === null || project.id !== transaction.projectId) return
    if (sameJson(transaction.before, this.historyState(project))) return
    this.pushBounded(this.undoStack, transaction.before)
    this.redoStack.length = 0
    this.patch({})
  }

  updateGraph(
    nodes: Node<DirectorNodeData>[],
    edges: Edge[],
    viewport?: Viewport,
    options: { recordHistory?: boolean } = {},
  ): void {
    const project = this.snapshot.project
    if (project === null) return
    const directorNodes = initializeConnectedVramTriggers(
      nodes as DirectorNode[],
      edges as DirectorEdge[],
      this.snapshot.providers,
    )
    const directorEdges = edges as DirectorEdge[]
    const graph: DirectorGraph = {
      nodes: recomputeSinkPayloads(directorNodes, directorEdges, this.snapshot.nodeDefinitions),
      edges: directorEdges,
      viewport: viewport ?? project.graph.viewport,
    }
    this.updateProject({ ...project, graph }, options.recordHistory === false ? 'transient' : 'user')
  }

  updateViewport(viewport: Viewport): void {
    const project = this.snapshot.project
    if (project === null || sameJson(viewport, project.graph.viewport)) return
    this.updateProject({
      ...project,
      graph: { ...project.graph, viewport: structuredClone(viewport) },
    }, 'transient')
  }

  connect(edge: DirectorEdge): void {
    const project = this.requireProject()
    const ports = resolveConnectionPorts(project.graph, this.snapshot.nodeDefinitions, edge)
    const normalizedEdge: DirectorEdge = {
      ...edge,
      sourceHandle: ports.sourceHandle,
      targetHandle: ports.targetHandle,
      data: {
        ...edge.data,
        sourcePortId: ports.sourcePortId,
        targetPortId: ports.targetPortId,
      },
    }
    const edges = [...project.graph.edges, normalizedEdge]
    const reconnectingPreview = project.graph.nodes.find(node => node.id === normalizedEdge.target)?.data.kind === 'preview'
    const inputNodes = reconnectingPreview
      ? project.graph.nodes.map(node => node.id === normalizedEdge.target
        ? { ...node, data: resumedPreviewData(node.data) }
        : node)
      : project.graph.nodes
    const nodes = recomputeSinkPayloads(inputNodes, edges, this.snapshot.nodeDefinitions)
    this.updateGraph(nodes, edges, project.graph.viewport)
  }

  updateNode(nodeId: string, patch: Partial<DirectorNodeData>): void {
    const project = this.snapshot.project
    if (project === null) return
    let enabledFields: Set<string> | undefined
    const nodes = project.graph.nodes.map(node => {
      if (node.id !== nodeId) return node
      const clearPromptValidation = Object.hasOwn(patch, 'prompt')
        && (node.data.phase === 'validation-failed' || node.data.error === 'prompt length must be between 1 and 100000')
      const patched = {
        ...node.data,
        ...patch,
        ...(clearPromptValidation
          ? { status: 'idle' as const, phase: undefined, progress: undefined, error: undefined, jobId: undefined }
          : {}),
      }
      const definition = nodeDefinition(patched, this.snapshot.nodeDefinitions)
      const modes = activeFieldInputModes(patched, definition)
      enabledFields = new Set(Object.keys(modes))
      return {
        ...node,
        data: {
          ...patched,
          fieldInputModes: enabledFields.size === 0 ? undefined : modes,
        },
      }
    })
    if (enabledFields === undefined) return
    const referenceLimit = patch.videoMode === undefined
      ? undefined
      : patch.videoMode === 'text-to-video'
        ? 0
        : patch.videoMode === 'first-to-last-frame' ? 2 : 1
    let referenceCount = 0
    const edges = project.graph.edges.filter(edge => {
      if (edge.target !== nodeId) return true
      const fieldId = edgeFieldInputId(edge)
      if (fieldId !== undefined && !enabledFields!.has(fieldId)) return false
      if (referenceLimit === undefined) return true
      const reference = edge.data?.targetPortId === 'reference'
        || edge.targetHandle === 'in'
        || edge.targetHandle === 'in:reference'
      if (!reference) return true
      referenceCount += 1
      return referenceCount <= referenceLimit
    })
    this.updateGraph(nodes, edges, project.graph.viewport)
  }

  setNodeFrozen(nodeId: string, frozen: boolean): void {
    const project = this.requireProject()
    const node = project.graph.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`Node ${nodeId} was not found.`)
    if (node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(this.runKey(nodeId))) {
      throw new Error('Cancel the active job before changing this node\'s Freeze state.')
    }
    if (node.data.frozen === frozen) return
    const clearMissingResultError = !frozen && node.data.phase === 'frozen-missing-result'
    const rows = node.data.batchRunId ? this.snapshot.batchCases[node.data.batchRunId] : undefined
    const frozenCase = node.data.batchFollow !== false ? [...(rows ?? [])].reverse().find(row => row.status !== 'pending') ?? rows?.[0]
      : rows?.find(row => row.caseIndex === node.data.batchCaseIndex)
    this.updateNode(nodeId, {
      frozen,
      ...(node.data.kind === 'batch-output' ? { batchFrozenCase: frozen && frozenCase ? structuredClone(frozenCase) : undefined } : {}),
      ...(clearMissingResultError
        ? { status: 'idle', phase: undefined, progress: undefined, error: undefined, jobId: undefined }
        : {}),
    })
  }

  toggleNodesFrozen(nodeIds: readonly string[]): void {
    const project = this.requireProject()
    const ids = new Set(nodeIds)
    const targets = project.graph.nodes.filter(node => ids.has(node.id))
    if (targets.length === 0) return
    if (targets.some(node => node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(this.runKey(node.id)))) {
      throw new Error('Cancel active jobs before changing the selected nodes’ Freeze state.')
    }
    const frozen = !targets.every(node => node.data.frozen === true)
    this.beginHistoryTransaction()
    try {
      for (const node of targets) this.setNodeFrozen(node.id, frozen)
    } finally { this.endHistoryTransaction() }
  }

  copyNodes(nodeIds: readonly string[]): void {
    const project = this.requireProject()
    const ids = new Set(nodeIds)
    const nodes = project.graph.nodes.filter(node => ids.has(node.id))
    if (nodes.length === 0) return
    this.nodeClipboard = structuredClone({ projectId: project.id, nodes,
      edges: project.graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) })
  }

  canPasteNodes(): boolean {
    return this.nodeClipboard !== null && this.nodeClipboard.projectId === this.snapshot.project?.id
  }

  pasteNodes(position: CanvasPosition): string[] {
    const project = this.requireProject()
    const clipboard = this.nodeClipboard
    if (clipboard === null || clipboard.projectId !== project.id) return []
    const origin = { x: Math.min(...clipboard.nodes.map(node => node.position.x)),
      y: Math.min(...clipboard.nodes.map(node => node.position.y)) }
    const ids = new Map(clipboard.nodes.map(node => [node.id, crypto.randomUUID()]))
    const nodes = clipboard.nodes.map(source => ({
      ...structuredClone(source), id: ids.get(source.id)!, selected: false, dragging: false,
      position: { x: position.x + source.position.x - origin.x, y: position.y + source.position.y - origin.y },
      data: duplicatedNodeData(structuredClone(source.data), {}),
    }))
    const edges = clipboard.edges.map(edge => ({ ...structuredClone(edge), id: crypto.randomUUID(),
      source: ids.get(edge.source)!, target: ids.get(edge.target)!, selected: false }))
    this.updateGraph([...project.graph.nodes, ...nodes], [...project.graph.edges, ...edges], project.graph.viewport)
    return [...ids.values()]
  }

  async resetVram(): Promise<void> {
    try {
      const providers = this.snapshot.providers.filter(provider => provider.configured !== false && provider.baseUrl)
      const actions = [
        ...(providers.some(provider => provider.kind === 'ollama') ? ['ollama-eject'] : []),
        ...(providers.some(provider => provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp') ? ['comfyui-clear'] : []),
      ]
      if (actions.length === 0) throw new Error('Configure Ollama or ComfyUI before resetting VRAM.')
      const results = await Promise.allSettled(actions.map(action => this.rpc('triggers/run', { action, releaseWaitSeconds: 10 })))
      const errors = results.flatMap(result => result.status === 'rejected' ? [errorMessage(result.reason)] : [])
      if (errors.length > 0) throw new Error(errors.join(' '))
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  configureFieldInput(nodeId: string, fieldId: string, enabled: boolean): void {
    const project = this.requireProject()
    const node = project.graph.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`Node ${nodeId} was not found.`)
    const definition = nodeDefinition(node.data, this.snapshot.nodeDefinitions)
    const candidate = parameterInputCandidates(node.data, definition)
      .find(value => value.id === fieldId)
    if (candidate === undefined) throw new Error(`Field ${fieldId} cannot receive a text input.`)

    const modes = activeFieldInputModes(node.data, definition)
    const currentlyEnabled = modes[fieldId]?.mode === 'input'
    if (currentlyEnabled === enabled) return
    if (enabled) modes[fieldId] = { mode: 'input' }
    else delete modes[fieldId]

    const nodes = project.graph.nodes.map(value => value.id === nodeId
      ? {
          ...value,
          data: {
            ...value.data,
            fieldInputModes: Object.keys(modes).length === 0 ? undefined : modes,
          },
        }
      : value)
    const portId = fieldInputPortId(fieldId)
    const edges = enabled
      ? project.graph.edges
      : project.graph.edges.filter(edge => (
          edge.target !== nodeId
            || (edge.data?.targetPortId !== portId && edgeFieldInputId(edge) !== fieldId)
        ))
    this.updateGraph(nodes, edges, project.graph.viewport)
  }

  private runKey(nodeId: string, projectId = this.snapshot.project?.id): string { return `${projectId}:${nodeId}` }

  private updateSystemNode(nodeId: string, patch: Partial<DirectorNodeData>, projectId = this.snapshot.project?.id): void {
    const project = this.snapshot.project
    if (project === null || project.id !== projectId) return
    const nodes = project.graph.nodes.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, ...patch } }
      : node)
    const graph: DirectorGraph = {
      ...project.graph,
      nodes: recomputeSinkPayloads(nodes, project.graph.edges, this.snapshot.nodeDefinitions),
    }
    this.updateProject({ ...project, graph }, 'system')
  }

  /** Begin a new run display without discarding cached outputs or interrupting other jobs. */
  private resetRunStatuses(projectId = this.snapshot.project?.id): void {
    if (this.snapshot.project?.id !== projectId) return
    const project = this.requireProject()
    const nodes = project.graph.nodes.map(node => {
      if (node.data.frozen === true || this.activeRuns.has(this.runKey(node.id)) || node.data.status === 'running') return node
      return { ...node, data: { ...node.data, status: 'idle' as const,
        phase: undefined, progress: undefined, error: undefined, jobId: undefined,
        runStartedAt: undefined, runCompletedAt: undefined } }
    })
    this.updateProject({ ...project, graph: { ...project.graph, nodes } }, 'system')
  }

  private updateVisibleJob(job: DirectorJob): void {
    this.patch({ jobs: [...this.snapshot.jobs.filter(row => row.id !== job.id), job] })
    const project = this.snapshot.project
    if (project === null || job.projectId !== project.id) return
    const existing = project.jobs.findIndex(candidate => candidate.id === job.id)
    const jobs = (existing < 0
      ? [...project.jobs, job]
      : project.jobs.map((candidate, index) => index === existing ? job : candidate))
      .sort((left, right) => (left.runSequence ?? 0) - (right.runSequence ?? 0))
      .slice(-100)
    this.updateVisibleJobs(jobs)
  }

  private updateVisibleJobs(jobs: DirectorJob[]): void {
    const project = this.snapshot.project
    if (!project) return
    if (jobs.length === 0 && project.jobs.length === 0) return
    const active = jobs.some(candidate => candidate.status === 'queued' || candidate.status === 'running')
    const latest = jobs.at(-1)
    const status: VideoProject['status'] = active
      ? 'running'
      : latest?.status === 'failed' || latest?.status === 'orphaned'
        ? 'error'
        : 'ready'
    this.updateProject({ ...project, jobs, status }, 'system')
  }

  private storeVdRun(run: VdRun): void {
    const workflowRuns = [run, ...this.snapshot.workflowRuns.filter(candidate => candidate.id !== run.id)]
    this.patch({ workflowRuns, error: null })
  }

  addText(text: string, position?: { x: number; y: number }): void {
    const project = this.snapshot.project
    if (project === null || text.trim() === '') return
    const node: DirectorNode = {
      id: crypto.randomUUID(),
      type: 'director',
      position: position ?? this.nextPosition(),
      data: { kind: 'load-text', mediaKind: 'text', title: 'Text', text: text.trim(), status: 'idle' },
    }
    this.updateGraph([...project.graph.nodes, node], project.graph.edges, project.graph.viewport)
  }

  addTextNode(position?: CanvasPosition): void {
    const project = this.snapshot.project
    if (project === null) return
    const node: DirectorNode = {
      id: crypto.randomUUID(),
      type: 'director',
      position: position ?? this.nextPosition(),
      data: { kind: 'load-text', mediaKind: 'text', title: 'Text', text: '', status: 'idle' },
    }
    this.updateGraph([...project.graph.nodes, node], project.graph.edges, project.graph.viewport)
  }

  addInputNode(kind: 'image' | 'audio' | 'video' | 'sketch', position?: CanvasPosition): string {
    return this.addCreatedNode({ id: crypto.randomUUID(), type: 'director', position: position ?? this.nextPosition(),
      data: { kind: `load-${kind}`, mediaKind: kind, title: nodeTitle(kind), status: 'idle' } })
  }

  private addCreatedNode(node: DirectorNode, incoming?: IncomingNodeConnection): string {
    const project = this.requireProject()
    const nodes = [...project.graph.nodes, node]
    if (incoming === undefined) {
      this.updateGraph(nodes, project.graph.edges, project.graph.viewport)
      return node.id
    }
    const candidate: DirectorEdge = {
      id: crypto.randomUUID(),
      source: incoming.source,
      sourceHandle: incoming.sourceHandle,
      target: node.id,
      targetHandle: incoming.targetHandle,
    }
    const ports = resolveConnectionPorts(
      { ...project.graph, nodes },
      this.snapshot.nodeDefinitions,
      candidate,
    )
    const edge: DirectorEdge = {
      ...candidate,
      sourceHandle: ports.sourceHandle,
      targetHandle: ports.targetHandle,
      data: {
        role: 'visual',
        includeAudio: false,
        sourcePortId: ports.sourcePortId,
        targetPortId: ports.targetPortId,
      },
    }
    this.updateGraph(nodes, [...project.graph.edges, edge], project.graph.viewport)
    return node.id
  }

  async addFile(
    file: File,
    explicitKind?: Exclude<MediaKind, 'text' | 'mask' | 'flow'>,
    position?: { x: number; y: number },
    sketchDocument?: SketchDocument,
  ): Promise<AssetRef> {
    const project = this.requireProject()
    const projectGeneration = this.projectGeneration
    const kind = explicitKind ?? fileKind(file)
    const dataBase64 = base64(new Uint8Array(await file.arrayBuffer()))
    const { asset } = await this.rpc<{ asset: AssetRef }>('assets/put', {
      projectId: project.id,
      kind,
      name: file.name,
      mimeType: inferredMimeType(file, kind),
      dataBase64,
    })
    const current = this.snapshot.project
    if (current?.id !== project.id || this.projectGeneration !== projectGeneration || this.snapshot.phase === 'loading') {
      throw new Error('The asset was saved to its original project, but the project changed before it could be added to the canvas.')
    }
    const node: DirectorNode = {
      id: crypto.randomUUID(),
      type: 'director',
      position: position ?? this.nextPosition(),
      data: {
        kind: `load-${kind}` as DirectorNodeData['kind'],
        mediaKind: kind,
        title: nodeTitle(kind),
        asset,
        status: 'idle',
        ...(kind === 'sketch' && sketchDocument !== undefined ? { sketchDocument: structuredClone(sketchDocument) } : {}),
        ...(kind === 'audio' || kind === 'video' ? { trim: { start: 0 } } : {}),
      },
    }
    this.updateGraph([...current.graph.nodes, node], current.graph.edges, current.graph.viewport)
    return asset
  }

  /** Replace an input's content as one undoable edit, retaining its identity and connections. */
  async replaceInputFile(nodeId: string, file: File): Promise<void> {
    const project = this.requireProject()
    const projectGeneration = this.projectGeneration
    const node = project.graph.nodes.find(candidate => candidate.id === nodeId)
    const kind = node === undefined ? undefined : inputFileKind(node.data.kind)
    if (node === undefined || kind === undefined) {
      throw new Error('Choose a text, image, audio, or video input node.')
    }
    let patch: Partial<DirectorNodeData>
    if (kind === 'text') {
      if (!isTextFile(file)) {
        throw new Error('Choose a UTF-8 text file.')
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (text.includes('\0')) throw new Error('Choose a UTF-8 text file.')
      patch = { text }
    } else {
      if (fileKind(file) !== kind) throw new Error(`Choose ${kind === 'video' ? 'a' : 'an'} ${kind} file for this input.`)
      const { asset } = await this.rpc<{ asset: AssetRef }>('assets/put', {
        projectId: project.id,
        kind,
        name: file.name,
        mimeType: inferredMimeType(file, kind),
        dataBase64: base64(new Uint8Array(await file.arrayBuffer())),
      })
      patch = {
        asset, mediaKind: kind, assets: undefined, maskAsset: undefined,
        trim: kind === 'audio' || kind === 'video' ? { start: 0 } : undefined,
        result: undefined, status: 'idle', phase: undefined, progress: undefined,
        jobId: undefined, error: undefined,
        runStartedAt: undefined, runCompletedAt: undefined,
      }
    }
    const current = this.snapshot.project
    if (current?.id !== project.id || this.projectGeneration !== projectGeneration || this.snapshot.phase === 'loading') {
      throw new Error('The project changed before the file could be attached. Choose the file again.')
    }
    const target = current.graph.nodes.find(candidate => candidate.id === nodeId)
    if (target === undefined || target.data.kind !== node.data.kind
      || target.data.asset?.id !== node.data.asset?.id || target.data.text !== node.data.text) {
      throw new Error('The input changed before the file could be attached. Choose the file again.')
    }
    this.updateNode(nodeId, patch)
  }

  async listInputAssets(kind: 'image' | 'audio' | 'video' | 'sketch'): Promise<AssetRef[]> {
    const project = this.requireProject()
    return (await this.rpc<{ assets: AssetRef[] }>('assets/list', { kind, projectId: project.id })).assets
  }

  async useExistingAsset(nodeId: string, source: AssetRef): Promise<void> {
    const project = this.requireProject()
    const generation = this.projectGeneration
    const node = project.graph.nodes.find(candidate => candidate.id === nodeId)
    if (!node || !['image', 'audio', 'video', 'sketch'].includes(source.kind) || node.data.kind !== `load-${source.kind}`) {
      throw new Error('Choose an asset that matches the input type.')
    }
    if (node.data.asset?.id === source.id) return
    const { asset } = await this.rpc<{ asset: AssetRef }>('assets/link', { projectId: project.id, sourceId: source.id })
    if (asset.kind !== source.kind) throw new Error('The selected asset does not match the input type.')
    const current = this.snapshot.project
    const target = current?.graph.nodes.find(candidate => candidate.id === nodeId)
    if (current?.id !== project.id || generation !== this.projectGeneration || this.snapshot.phase === 'loading'
      || target?.data.kind !== node.data.kind || target?.data.asset?.id !== node.data.asset?.id
      || !sameJson(target?.data.sketchDocument, node.data.sketchDocument)) {
      throw new Error('The input changed before the asset could be attached. Choose the asset again.')
    }
    this.updateNode(nodeId, {
      asset, mediaKind: asset.kind, assets: undefined, maskAsset: undefined, sketchDocument: undefined,
      trim: asset.kind === 'audio' || asset.kind === 'video' ? { start: 0 } : undefined,
      mediaEditId: undefined, mediaEditedFromJobId: undefined,
      result: undefined, status: 'idle', phase: undefined, progress: undefined,
      jobId: undefined, error: undefined, runStartedAt: undefined, runCompletedAt: undefined,
    })
  }

  async uploadDerived(file: File, kind: 'sketch' | 'mask'): Promise<AssetRef> {
    const project = this.requireProject()
    const projectGeneration = this.projectGeneration
    const { asset } = await this.rpc<{ asset: AssetRef }>('assets/put', {
      projectId: project.id,
      kind,
      name: file.name,
      mimeType: file.type || 'image/png',
      dataBase64: base64(new Uint8Array(await file.arrayBuffer())),
    })
    if (this.snapshot.project?.id !== project.id || this.projectGeneration !== projectGeneration || this.snapshot.phase === 'loading') {
      throw new Error('The derived asset was saved to its original project, but the project changed before it could be attached.')
    }
    return asset
  }

  duplicateNode(nodeId: string, patch: Partial<DirectorNodeData> = {}): void {
    const project = this.requireProject()
    const source = project.graph.nodes.find(node => node.id === nodeId)
    if (source === undefined) return
    const duplicate: DirectorNode = {
      ...source,
      id: crypto.randomUUID(),
      selected: false,
      position: { x: source.position.x + 56, y: source.position.y + 56 },
      data: {
        ...duplicatedNodeData(source.data, patch),
        title: `${source.data.title} copy`,
        derivedFrom: source.id,
      },
    }
    this.updateGraph([...project.graph.nodes, duplicate], project.graph.edges, project.graph.viewport)
  }

  deleteNodes(nodeIds: readonly string[]): void {
    const project = this.requireProject()
    const ids = new Set(nodeIds)
    if (ids.size === 0) return
    const targets = project.graph.nodes.filter(node => ids.has(node.id))
    if (targets.length === 0) return
    const running = targets.find(node => node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(this.runKey(node.id)))
    if (running !== undefined) throw new Error(`Cancel ${running.data.title} before deleting it.`)
    for (const node of targets) {
      this.activeRuns.delete(this.runKey(node.id))
      if (node.data.jobId === undefined) continue
      const timer = this.jobTimers.get(node.data.jobId)
      if (timer !== undefined) clearTimeout(timer)
      this.jobTimers.delete(node.data.jobId)
    }
    this.updateGraph(
      project.graph.nodes.filter(node => !ids.has(node.id)),
      project.graph.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)),
      project.graph.viewport,
    )
  }

  addWorkflowNode(
    kind: 'prompt-enhancer' | 'image-generation' | 'video-generation' | 'audio-generation',
    position?: CanvasPosition,
    incoming?: IncomingNodeConnection,
  ): string {
    const project = this.requireProject()
    const videoProviderId = String(project.settings.defaultVideoProvider ?? 'comfyui')
    const workflowKind = kind === 'image-generation' || kind === 'video-generation' || kind === 'audio-generation'
      ? kind
      : undefined
    const workflow = workflowKind === undefined ? undefined : this.defaultWorkflow(workflowKind)
    const workflowDefaults = workflow === undefined ? {} : {
      workflowId: workflow.id,
      modelFamily: workflow.modelFamily,
      workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
      ...workflow.defaults,
    }
    const defaults: Record<typeof kind, Partial<DirectorNodeData>> = {
      'prompt-enhancer': {
        providerId: String(project.settings.defaultTextProvider ?? 'ollama'),
        systemPrompt: DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT,
        contextLength: 32_000,
        thinking: true,
      },
      'image-generation': { providerId: String(project.settings.defaultImageProvider ?? 'openai'), imageMode: 'generate', width: 1024, height: 1024 },
      'video-generation': { providerId: videoProviderId, ...workflowDefaults },
      'audio-generation': { providerId: videoProviderId, ...workflowDefaults },
    }
    const titles = {
      'prompt-enhancer': 'Prompt Enhancer',
      'image-generation': 'Image Processing',
      'video-generation': 'MiniMax H3 Video',
      'audio-generation': 'MiniMax H3 Audio',
    }
    const data = withDefaultRegisteredImageWorkflow(
      { kind, title: titles[kind], prompt: '', status: 'idle', ...defaults[kind] },
      this.snapshot.providers,
      this.snapshot.workflows,
    )
    const provider = this.snapshot.providers.find(candidate => candidate.id === data.providerId)
    if (provider?.kind === 'codex-plan') data.modelId = codexModelForNode(data, provider)
    const node: DirectorNode = {
      id: crypto.randomUUID(),
      type: 'director',
      position: position ?? this.nextPosition(),
      data,
    }
    return this.addCreatedNode(node, incoming)
  }

  addNodeDefinition(
    type: string,
    version?: string,
    position?: CanvasPosition,
    incoming?: IncomingNodeConnection,
  ): string {
    const project = this.requireProject()
    const definition = this.snapshot.nodeDefinitions.find(candidate => (
      candidate.type === type && (version === undefined || candidate.version === version)
    ))
    if (definition === undefined) throw new Error(`Node definition ${type}${version === undefined ? '' : `@${version}`} was not found`)
    if (definition.behavior === 'media') {
      return this.addCreatedNode({ id: crypto.randomUUID(), type: 'director', position: position ?? this.nextPosition(),
        data: { kind: definition.operation!, title: definition.title, providerId: 'ffmpeg',
          nodeType: definition.type, nodeVersion: definition.version, nodeDigest: definition.digest, status: 'idle',
          mediaOptions: Object.fromEntries(definition.fields.filter(field => typeof field.default === 'number').map(field => [field.id, field.default as number])) } }, incoming)
    }
    if (definition.behavior === 'preview' || definition.behavior === 'save' || definition.behavior === 'trigger' || definition.behavior === 'batch-input' || definition.behavior === 'batch-output') {
      const kind = definition.behavior === 'trigger' ? definition.triggerAction : definition.behavior
      if (kind === undefined) throw new Error(`Trigger ${definition.type}@${definition.version} has no action`)
      const node: DirectorNode = {
        id: crypto.randomUUID(),
        type: 'director',
        position: position ?? this.nextPosition(),
        data: {
          kind,
          title: definition.title,
          nodeType: definition.type,
          nodeVersion: definition.version,
          nodeDigest: definition.digest,
          status: 'idle',
          ...(definition.behavior === 'save' ? { outputName: '' } : {}),
          ...(kind === 'batch-input' ? { batch: { source: 'text' as const, text: '', startIndex: 1, sort: 'input' as const, recursive: true, errorPolicy: 'stop' as const } } : {}),
          ...(kind === 'vram-trigger'
            ? { vramAction: 'skip', vramReleaseWaitSeconds: 10, vramActionInitialized: false }
            : {}),
        },
      }
      return this.addCreatedNode(node, incoming)
    }
    if (definition.workflowId === undefined || definition.operation === undefined) {
      throw new Error(`Node definition ${definition.type}@${definition.version} is missing its workflow implementation`)
    }
    const workflow = this.snapshot.workflows.find(candidate => candidate.id === definition.workflowId)
    if (workflow === undefined) throw new Error(`Workflow ${definition.workflowId} was not found`)
    const operation = definition.operation
    const providerId = 'comfyui'
    const node: DirectorNode = {
      id: crypto.randomUUID(),
      type: 'director',
      position: position ?? this.nextPosition(),
      data: {
        kind: operation,
        title: definition.title,
        prompt: String(workflow.defaults.prompt ?? ''),
        providerId,
        workflowId: workflow.id,
        workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
        modelFamily: workflow.modelFamily,
        nodeType: definition.type,
        nodeVersion: definition.version,
        nodeDigest: definition.digest,
        status: 'idle',
        ...workflow.defaults,
      },
    }
    return this.addCreatedNode(node, incoming)
  }

  async runNode(nodeId: string): Promise<void> {
    if (this.activeRuns.get(this.runKey(nodeId))?.workflowRunId !== undefined) {
      throw new Error('This node is executing a submitted workflow. Queue another workflow or cancel its current run first.')
    }
    const project = this.requireProject()
    const node = project.graph.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`Node ${nodeId} was not found`)
    if (node.data.kind === 'batch-input') { await this.runBatch(nodeId); return }
    if (this.snapshot.workflowRuns.some(run => run.projectId === project.id
      && (run.status === 'running' || run.status === 'queued') && run.nodeIds.includes(nodeId))) {
      throw new Error('This node is part of a submitted workflow. Queue another workflow or cancel its current run first.')
    }
    if (isTriggerNodeKind(node.data.kind)) {
      await this.submitTriggerRun(nodeId)
      return
    }
    await this.submitNodeRun(nodeId)
  }

  async runDependencies(nodeId: string): Promise<string> {
    return this.runVdWorkflow({ mode: 'dependencies', selectedNodeIds: [nodeId] })
  }

  private async submitTriggerRun(nodeId: string, options: NodeRunOptions = {}): Promise<void> {
    if (options.project === undefined && (this.snapshot.saving || this.snapshot.phase === 'loading')) {
      throw new Error('Wait for the current project operation before running a trigger node.')
    }
    const project = options.project ?? this.requireProject()
    const updateNode = (patch: Partial<DirectorNodeData>): void => this.updateSystemNode(nodeId, patch, project.id)
    const executionGraph = options.graph ?? project.graph
    const node = executionGraph.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`Node ${nodeId} was not found`)
    if (!isTriggerNodeKind(node.data.kind)) throw new Error(`${node.data.title} is not a trigger node.`)
    if (node.data.frozen === true) throw new Error(`${node.data.title} is frozen. Unfreeze it before running the node directly.`)
    if (signalAborted(options.signal)) throw new Error('vd-run was cancelled.')
    try {
      validateTriggerNodeConnections(executionGraph, nodeId)
      const definition = nodeDefinition(node.data, this.snapshot.nodeDefinitions)
      const action = node.data.kind === 'vram-trigger'
        ? node.data.vramAction ?? 'skip'
        : definition?.triggerAction ?? node.data.kind
      const releaseWaitSeconds = Number.isSafeInteger(node.data.vramReleaseWaitSeconds)
        && node.data.vramReleaseWaitSeconds! >= 0
        && node.data.vramReleaseWaitSeconds! <= 300
        ? node.data.vramReleaseWaitSeconds
        : 10
      if (options.workflowRunId === undefined) this.resetRunStatuses()
      const runStartedAt = new Date().toISOString()
      updateNode({
        status: 'running',
        runStartedAt,
        runCompletedAt: undefined,
        phase: action === 'ollama-eject'
          ? 'ejecting-models'
          : action === 'comfyui-clear' ? 'unloading-and-clearing-cache' : 'bypassing',
        progress: 0.5,
        error: undefined,
        jobId: undefined,
      })
      await this.rpc('triggers/run', { action, releaseWaitSeconds }, options.signal)
      if (signalAborted(options.signal)) throw new Error('vd-run was cancelled.')
      updateNode({
        status: 'completed',
        runStartedAt,
        runCompletedAt: new Date().toISOString(),
        phase: 'completed',
        progress: 1,
        error: undefined,
        jobId: undefined,
      })
    } catch (error) {
      updateNode({
        status: signalAborted(options.signal) ? 'idle' : 'failed',
        phase: signalAborted(options.signal) ? 'cancelled' : 'trigger-failed',
        progress: 0,
        error: errorMessage(error),
        jobId: undefined,
      })
      throw error
    }
  }

  private async submitNodeRun(nodeId: string, options: NodeRunOptions = {}): Promise<ActiveNodeRun> {
    if (options.project === undefined && (this.snapshot.saving || this.snapshot.phase === 'loading')) {
      throw new Error('Wait for the current project operation before running a vd-node.')
    }
    const project = options.project ?? this.requireProject()
    const updateNode = (patch: Partial<DirectorNodeData>): void => this.updateSystemNode(nodeId, patch, project.id)
    const projectGeneration = this.projectGeneration
    let node: DirectorNode
    const clientRunId = crypto.randomUUID()
    let request: Record<string, unknown>
    try {
      if (signalAborted(options.signal)) throw new Error('vd-run was cancelled.')
      ;({ node, request } = prepareNodeRequest(project, nodeId, this.snapshot, options))
    } catch (error) {
      updateNode({
        status: 'failed',
        phase: 'validation-failed',
        progress: 0,
        error: errorMessage(error),
        jobId: undefined,
      })
      throw error
    }
    if (options.workflowRunId === undefined) this.resetRunStatuses()
    const activeRun: ActiveNodeRun = {
      projectId: project.id,
      projectGeneration,
      clientRunId,
      seedStateAtSubmission: {
        seed: node.data.seed,
        control: node.data.seedControlAfterGenerate,
      },
      workflowRunId: options.workflowRunId,
      suppressSeedUpdate: options.suppressSeedUpdate,
      completion: options.awaitCompletion === true ? activeRunCompletion() : undefined,
    }
    this.activeRuns.get(this.runKey(nodeId, project.id))?.completion?.reject(new Error(`${node.data.title} was superseded by a newer run.`))
    this.activeRuns.set(this.runKey(nodeId, project.id), activeRun)
    updateNode({ status: 'queued', phase: 'submitting', progress: 0, error: undefined, jobId: undefined,
      runStartedAt: undefined, runCompletedAt: undefined })
    try {
      const { job } = await this.rpc<{ job: DirectorJob }>('jobs/start', {
        projectId: project.id,
        nodeId,
        clientRunId,
        snapshot: {
          version: 1,
          sourceRevision: options.sourceRevision ?? project.revision,
          nodeType: node.data.nodeType,
          nodeVersion: node.data.nodeVersion,
          nodeDigest: node.data.nodeDigest,
          request,
        },
      })
      if (!this.isActiveRun(nodeId, activeRun)) return activeRun
      activeRun.jobId = job.id
      this.updateVisibleJob(job)
      updateNode({ jobId: job.id, status: job.status === 'running' ? 'running' : 'queued', phase: job.phase,
        progress: job.progress, runStartedAt: job.startedAt, runCompletedAt: undefined })
      this.scheduleJobPoll(job.id, nodeId, 0, activeRun)
      if (signalAborted(options.signal)) await this.cancelJob(job.id, project.id)
    } catch (error) {
      // A failed Cancel RPC does not undo a successful jobs/start. Preserve the
      // poller so the submitted job can still be observed and cancelled again.
      if (activeRun.jobId !== undefined && (error as RemoteFailure).code === 'video-director/cancel-request-failed') throw error
      if (this.isActiveRun(nodeId, activeRun)) {
        this.activeRuns.delete(this.runKey(nodeId, project.id))
        updateNode({
          status: 'failed',
          phase: 'submission-failed',
          progress: 0,
          error: errorMessage(error),
        })
      }
      if (options.batchRunId && activeRun.jobId === undefined && (error as RemoteFailure).code !== 'video-director/invalid-input') {
        throw Object.assign(new Error(`Submission receipt is uncertain. Inspect this case's jobs before retrying. ${errorMessage(error)}`), { code: 'video-director/submission-unknown' })
      }
      throw error
    }
    return activeRun
  }

  async cancelJob(jobId: string, projectId = this.snapshot.jobs.find(job => job.id === jobId)?.projectId ?? this.requireProject().id): Promise<void> {
    try {
      const { job } = await this.rpc<{ job: DirectorJob }>('jobs/cancel', { projectId, jobId })
      this.updateVisibleJob(job)
    } catch (cause) {
      throw Object.assign(new Error(`Could not request cancellation for job ${jobId}: ${errorMessage(cause)}`), {
        code: 'video-director/cancel-request-failed',
      })
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    const projectId = this.snapshot.jobs.find(job => job.id === jobId)?.projectId ?? this.requireProject().id
    const project = this.requireProject()
    await this.rpc<{ job: DirectorJob }>('jobs/delete', { projectId, jobId })
    this.patch({ jobs: this.snapshot.jobs.filter(job => job.id !== jobId) })
    if (project.id !== projectId) return
    const jobs = project.jobs.filter(candidate => candidate.id !== jobId)
    const latest = jobs.at(-1)
    const status: VideoProject['status'] = jobs.some(candidate => candidate.status === 'queued' || candidate.status === 'running')
      ? 'running'
      : latest?.status === 'failed' || latest?.status === 'orphaned'
        ? 'error'
        : 'ready'
    const graph = {
      ...project.graph,
      nodes: project.graph.nodes.map(node => node.data.jobId === jobId
        ? { ...node, data: { ...node.data, jobId: undefined } }
        : node),
    }
    this.updateProject({ ...project, graph, jobs, status }, 'system')
  }

  async importBatchFiles(nodeId: string, files: File[], directory = false): Promise<void> {
    const project = this.requireProject()
    const generation = this.projectGeneration
    const node = project.graph.nodes.find(node => node.id === nodeId)
    if (node?.data.kind !== 'batch-input') throw new Error('Choose a Batch Input node.')
    if (node.data.frozen) throw new Error('Unfreeze Batch Input before replacing its cases.')
    const candidates = files.map((file, index) => ({ id: String(index), name: file.name, relativePath: directory ? (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name : undefined }))
    const matched = await matchBatchItems(candidates, { ...node.data.batch, source: 'files' })
    if (matched.length > MAX_BATCH_CASES) throw new Error(`The filter matched more than ${MAX_BATCH_CASES} files. Narrow the regex.`)
    const items: BatchItem[] = []
    for (const candidate of matched) {
      const file = files[Number(candidate.id)]
      const relativePath = directory ? (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name : undefined
      if (isTextFile(file)) {
        if (file.size > 400_000) throw new Error(`${file.name}: text cases must be at most 100,000 characters.`)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
        if (text.includes('\0') || text.length > 100_000) throw new Error(`${file.name}: choose a UTF-8 text file with at most 100,000 characters.`)
        items.push({ id: crypto.randomUUID(), name: file.name, relativePath, text })
      } else {
        let kind: Exclude<MediaKind, 'text' | 'mask' | 'flow'>
        try { kind = fileKind(file) } catch (error) { if (directory) continue; throw error }
        const { asset } = await this.rpc<{ asset: AssetRef }>('assets/put', { projectId: project.id, kind,
          name: file.name, mimeType: inferredMimeType(file, kind), dataBase64: base64(new Uint8Array(await file.arrayBuffer())) })
        items.push({ id: crypto.randomUUID(), name: file.name, relativePath, asset })
      }
    }
    if (this.snapshot.project?.id !== project.id || this.projectGeneration !== generation) throw new Error('The project changed while importing cases.')
    if (!items.length) throw new Error('No supported text, image, audio or video files were found.')
    const target = this.requireProject().graph.nodes.find(node => node.id === nodeId)
    if (!target || target.data.frozen || !sameJson(target.data.batch, node.data.batch)) throw new Error('The Batch Input changed while files were being imported. Import again.')
    this.updateNode(nodeId, { batch: { ...node.data.batch, source: 'files', items, sort: directory ? 'name' : 'input', startIndex: 1, endIndex: undefined } })
  }

  async loadBatchCases(runId: string): Promise<BatchCase[]> {
    const project = this.requireProject()
    const { cases } = await this.rpc<{ cases: BatchCase[] }>('batch-cases/list', { projectId: project.id, runId })
    if (this.snapshot.project?.id === project.id) this.patch({ batchCases: { ...this.snapshot.batchCases, [runId]: cases } })
    return cases
  }

  async runBatch(nodeId: string, resumeRunId?: string): Promise<string> {
    if (this.snapshot.saving || this.snapshot.phase === 'loading') throw new Error('Wait for the current project operation.')
    const project = this.requireProject()
    const currentInput = project.graph.nodes.find(node => node.id === nodeId)
    if (currentInput?.data.kind !== 'batch-input' || currentInput.data.frozen) throw new Error('Choose an unfrozen Batch Input node.')
    if (this.snapshot.workflowRuns.some(run => run.projectId === project.id && run.kind === 'batch' && run.batchInputNodeId === nodeId && ['queued', 'running'].includes(run.status))) throw new Error('This Batch Input already has a queued or running batch.')
    const generation = this.projectGeneration
    const updateInput = (patch: Partial<DirectorNodeData>): void => this.updateSystemNode(nodeId, patch, project.id)
    let source = structuredClone(project)
    let rows: BatchCase[]
    let summary: VdRun
    if (resumeRunId) {
      const { run } = await this.rpc<{ run: VdRun & { snapshot: Pick<VideoProject, 'name' | 'graph' | 'settings'> } }>('vd-runs/get', { projectId: project.id, runId: resumeRunId })
      if (run.kind !== 'batch' || run.batchInputNodeId !== nodeId) throw new Error('This batch belongs to another input node.')
      if (run.status === 'queued' || run.status === 'running') throw new Error('Cancel the unfinished batch before resuming it. It may still be scheduled in another window.')
      source = { ...source, ...run.snapshot }
      rows = await this.loadBatchCases(resumeRunId)
      if (rows.some(row => row.status === 'running' || row.uncertain)) throw new Error('An interrupted case has an uncertain submission. Inspect its jobs before starting a new batch; it cannot be retried automatically.')
      if (!rows.some(row => row.status !== 'completed')) throw new Error('All cases are already complete.')
      // Cancel cleanup failures must be reconciled before any duplicate submission.
      if (rows.some(row => row.jobs.some(job => job.errorCode === 'video-director/remote-cancel-failed' || ['orphaned', 'queued', 'running'].includes(job.status)))) throw new Error('Resolve the uncertain remote jobs before retrying this batch.')
      const { snapshot: _snapshot, ...saved } = run
      summary = { ...saved, status: 'queued', error: undefined, completedAt: undefined }
    } else {
      const input = source.graph.nodes.find(node => node.id === nodeId)!
      const config: BatchInputConfig = input.data.batch ?? { source: 'text' }
      const items = await matchBatchItems(batchSourceItems(config), config)
      const { start, end } = batchRange(config, items.length)
      const id = crypto.randomUUID()
      const seedNodes = source.graph.nodes.filter(node => !node.data.frozen && ['image-generation', 'image-edit', 'video-generation', 'audio-generation'].includes(node.data.kind))
      const bases = new Map(seedNodes.map(node => [node.id, { ...node.data, seed: node.data.seed ?? caseSeed({ ...node.data, seedControlAfterGenerate: 'fixed' }, 0) }]))
      rows = items.slice(start - 1, end).map((input, offset) => ({ caseId: crypto.randomUUID(), batchRunId: id,
        caseIndex: start + offset, input, status: 'pending', attempt: 0,
        seeds: Object.fromEntries(seedNodes.map(node => [node.id, caseSeed(bases.get(node.id)!, offset)])), jobs: [], artifacts: [] }))
      summary = { id, projectId: project.id, kind: 'batch', mode: 'all', batchSize: rows.length, nodeIds: [],
        completedJobs: 0, totalJobs: 0, status: 'queued', startedAt: new Date().toISOString(),
        batchInputNodeId: nodeId, startIndex: start, endIndex: end, completedCases: 0, failedCases: 0 }
    }
    if (this.snapshot.project?.id !== project.id || this.projectGeneration !== generation) throw new Error('The project changed while preparing the batch.')
    const seedWritebackExpected = new Map(source.graph.nodes.map(node => [node.id, node.data.seed]))
    if (resumeRunId) {
      for (const node of source.graph.nodes) {
        const last = rows.flatMap(row => row.jobs).filter(job => job.nodeId === node.id && job.status === 'completed').at(-1)
        const seed = last?.seed ?? (last?.result && 'seed' in last.result ? last.result.seed : undefined)
        if (seed === undefined) continue
        const policy = node.data.seedControlAfterGenerate
        const expected = policy === 'increment' ? seed + 1 : policy === 'decrement' ? seed - 1 : policy === 'randomize' ? seed : node.data.seed
        const live = project.graph.nodes.find(live => live.id === node.id)
        if (live?.data.seed === expected) seedWritebackExpected.set(node.id, expected)
      }
    }
    const config = source.graph.nodes.find(node => node.id === nodeId)!.data.batch ?? { source: 'text' as const }
    const other = source.graph.nodes.find(node => node.id !== nodeId && node.data.kind === 'batch-input' && !node.data.frozen)
    if (other) throw new Error('Use one active Batch Input per workflow. Freeze other batch inputs to reuse their current payloads.')
    const plan = planVdRun(source.graph, { mode: 'all' })
    for (const id of plan.frozenNodeIds) {
      const node = source.graph.nodes.find(node => node.id === id)!
      const requiredOutput = node.data.kind !== 'preview' || source.graph.edges.some(edge => edge.source === id)
      if (requiredOutput && !['save', 'batch-output'].includes(node.data.kind) && !isTriggerNodeKind(node.data.kind) && !hasReusableNodeOutput(node)) throw new Error(`Frozen node has no reusable result: ${node.data.title}. Unfreeze and run it first.`)
    }
    // Validate the range's media against every consuming port before submitting anything.
    for (const row of rows) {
      for (const edge of source.graph.edges.filter(edge => edge.source === nodeId)) {
        const target = source.graph.nodes.find(node => node.id === edge.target)
        if (target?.data.frozen) continue
        const ports = resolveEdgePorts(source.graph, this.snapshot.nodeDefinitions, edge)
        if (!ports.targetTypes.includes('flow') && !ports.targetTypes.includes(row.input.asset?.kind ?? 'text')) throw new Error(`Case ${row.caseIndex} (${row.input.name}) is incompatible with ${target?.data.title}.`)
      }
    }
    summary.nodeIds = plan.nodeIds
    summary.totalJobs = rows.length * plan.nodeIds.length
    const submitted = { name: source.name, graph: source.graph, settings: source.settings }
    const response = resumeRunId
      ? await this.submitToHost(project.id, 'vd-runs/resume', { projectId: project.id, runId: resumeRunId }, [summary])
      : await this.submitToHost(project.id, 'vd-runs/submit', { projectId: project.id, snapshot: submitted,
          runIds: [summary.id], options: { mode: 'all', batchSize: 1 }, batch: { nodeId, rows } }, [summary])
    const id = response.runs[0].id
    response.runs.forEach(run => this.storeVdRun(run))
    this.patch({ batchCases: { ...this.snapshot.batchCases, [id]: structuredClone(rows) } })
    updateInput({ batchRunId: id, status: 'queued', error: undefined })
    if (this.snapshot.project?.id === project.id) this.updateProject({ ...this.requireProject(),
      graph: { ...this.requireProject().graph, nodes: this.requireProject().graph.nodes.map(node => node.data.kind === 'batch-output' && !node.data.frozen
        ? { ...node, data: { ...node.data, batchRunId: id, batchCaseIndex: rows[0].caseIndex } } : node) } }, 'system-saveable')
    try {
      await this.observeHostRuns([id], config.errorPolicy === 'continue')
      return id
    } finally {
      if (!this.disposed) {
        rows = (await this.rpc<{ cases: BatchCase[] }>('batch-cases/list', { projectId: project.id, runId: id })).cases
        this.patch({ batchCases: { ...this.snapshot.batchCases, [id]: rows } })
      // Commit the next editable seed once, only if its captured settings still match.
      for (const node of source.graph.nodes.filter(node => !node.data.frozen && this.snapshot.project?.id === project.id)) {
        const completed = rows.flatMap(row => row.jobs).filter(job => job.nodeId === node.id && job.status === 'completed').at(-1)
        const actualSeed = completed?.seed ?? (completed?.result && 'seed' in completed.result ? completed.result.seed : undefined)
        const live = this.snapshot.project?.graph.nodes.find(candidate => candidate.id === node.id)
        if (!completed || actualSeed === undefined || !live || live.data.frozen || live.data.seed !== seedWritebackExpected.get(node.id) || live.data.seedControlAfterGenerate !== node.data.seedControlAfterGenerate) continue
        const policy = node.data.seedControlAfterGenerate
        const next = policy === 'increment' ? actualSeed + 1 : policy === 'decrement' ? actualSeed - 1 : policy === 'randomize' ? actualSeed : undefined
        if (next !== undefined && Number.isSafeInteger(next) && next >= 0) this.updateSystemNode(node.id, { seed: next })
      }
        const latest = this.snapshot.workflowRuns.find(run => run.id === id)
        updateInput({ status: latest?.status === 'completed' ? 'completed' : latest?.status === 'cancelled' ? 'idle' : 'failed',
          phase: latest?.status, progress: rows.filter(row => row.status === 'completed').length / rows.length, error: latest?.error })
      }
    }
  }

  async runVdWorkflow(options: {
    mode: VdRunMode
    selectedNodeIds?: readonly string[]
    batchSize?: number
  }): Promise<string> {
    if (this.snapshot.saving || this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project operation before running the vd-workflow.')
    }
    const project = this.requireProject()
    const batchInput = project.graph.nodes.find(node => node.data.kind === 'batch-input' && !node.data.frozen
      && (options.mode === 'all' || options.selectedNodeIds?.includes(node.id)))
    if (batchInput) {
      if ((options.batchSize ?? 1) !== 1) throw new Error('Use the Batch Input index range; Repeat Count must be 1 for a case batch.')
      return this.runBatch(batchInput.id)
    }

    let batchSize: number
    let executionSource: VideoProject
    let plan: ReturnType<typeof planVdRun>
    try {
      batchSize = options.batchSize ?? 1
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20) {
        throw new Error('Batch size must be an integer from 1 to 20.')
      }
      executionSource = structuredClone(project)
      plan = planVdRun(executionSource.graph, {
        mode: options.mode,
        selectedNodeIds: options.selectedNodeIds,
      })
      const missingFrozenOutputs = plan.frozenNodeIds
        .map(nodeId => executionSource.graph.nodes.find(node => node.id === nodeId))
        .filter((node): node is DirectorNode => node !== undefined
          && node.data.kind !== 'preview'
          && node.data.kind !== 'save'
          && node.data.kind !== 'batch-output'
          && !isTriggerNodeKind(node.data.kind)
          && !hasReusableNodeOutput(node))
      if (missingFrozenOutputs.length > 0) {
        const message = `Frozen node has no reusable result: ${missingFrozenOutputs.map(node => node.data.title).join(', ')}. Unfreeze and run it first.`
        for (const node of missingFrozenOutputs) {
          this.updateSystemNode(node.id, {
            status: 'failed',
            phase: 'frozen-missing-result',
            progress: undefined,
            error: 'Frozen node has no previous result. Unfreeze and run it first.',
          })
        }
        throw new Error(message)
      }
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }

    const submitted = { name: executionSource.name, graph: executionSource.graph, settings: executionSource.settings }
    const runIds = Array.from({ length: batchSize }, () => crypto.randomUUID())
    const provisional: VdRun[] = runIds.map(id => ({ id, projectId: project.id, mode: options.mode, batchSize: 1,
      nodeIds: plan.nodeIds, totalJobs: plan.nodeIds.length, completedJobs: 0, status: 'queued', startedAt: new Date().toISOString() }))
    const { runs } = await this.submitToHost(project.id, 'vd-runs/submit', {
      projectId: project.id, snapshot: submitted, runIds, options: { ...options, batchSize },
    }, provisional)
    runs.forEach(run => this.storeVdRun(run))
    await this.observeHostRuns(runs.map(run => run.id))
    return runs[0].id
  }

  /** Observation only: closing/suspending this client never cancels or advances Host work. */
  private async observeHostRuns(ids: string[], continueOnCaseError = false): Promise<void> {
    while (!this.disposed) {
      try { await this.refreshVdRuns() } catch {
        await new Promise(resolve => setTimeout(resolve, JOB_POLL_MS))
        continue
      }
      const runs = ids.map(id => this.snapshot.workflowRuns.find(run => run.id === id))
      if (runs.every(run => run && !['queued', 'running'].includes(run.status))) {
        const failed = runs.find(run => run?.status === 'failed' || run?.status === 'cancelled')
        if (failed && !(continueOnCaseError && failed.error?.includes('case(s) failed.'))) throw new Error(failed.error ?? 'vd-run was cancelled.')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  async cancelVdRun(workflowRunId: string): Promise<void> {
    const run = this.snapshot.workflowRuns.find(run => run.id === workflowRunId)
    const projectId = run?.projectId ?? this.snapshot.jobs.find(job => job.workflowRunId === workflowRunId)?.projectId ?? this.requireProject().id
    await this.hostSubmissions.get(workflowRunId)
    const latest = await this.rpc<{ run: VdRun }>('vd-runs/get', { projectId, runId: workflowRunId }).catch(() => null)
    if (latest) this.storeVdRun(latest.run)
    await this.rpc('vd-runs/cancel', { projectId, runId: workflowRunId })
    await this.refreshVdRuns()
  }

  async deleteVdRun(runId: string): Promise<void> {
    const run = this.snapshot.workflowRuns.find(run => run.id === runId)
    if (!run) throw new Error('Workflow run was not found.')
    await this.rpc('vd-runs/delete', { projectId: run.projectId, runId })
    await this.refreshVdRuns()
  }

  async getVdRunJobs(runId: string): Promise<DirectorJob[]> {
    const run = this.snapshot.workflowRuns.find(run => run.id === runId)
    if (!run) throw new Error('Workflow run was not found.')
    return (await this.rpc<{ jobs: DirectorJob[] }>('vd-runs/jobs', { projectId: run.projectId, runId })).jobs
  }

  /** @deprecated Use runVdWorkflow; this executes the canvas graph, not a ComfyUI graph. */
  runWorkflow(options: Parameters<DirectorController['runVdWorkflow']>[0]): Promise<string> {
    return this.runVdWorkflow(options)
  }

  /** @deprecated Use cancelVdRun. The argument is a grouped vd-run ID. */
  cancelWorkflowRun(workflowRunId: string): Promise<void> {
    return this.cancelVdRun(workflowRunId)
  }

  async checkProvider(providerId: string): Promise<void> {
    const expected = this.snapshot.providers.find(provider => provider.id === providerId)
    const checkDiscoversModels = expected?.kind === 'ollama' || expected?.kind === 'codex-plan'
    const refreshVersion = checkDiscoversModels
      ? (this.modelRefreshVersions.get(providerId) ?? 0) + 1
      : undefined
    if (refreshVersion !== undefined) this.modelRefreshVersions.set(providerId, refreshVersion)
    this.patch({
      providerChecks: { ...this.snapshot.providerChecks, [providerId]: { state: 'checking' } },
      ...(checkDiscoversModels
        ? {
            providers: this.snapshot.providers.map(provider => provider.id === providerId
              ? { ...provider, modelDiscovery: { state: 'loading' } }
              : provider),
          }
        : {}),
    })
    try {
      const result = await this.rpc<{
        ok: true
        latencyMs: number
        transport?: 'rest' | 'mcp'
        models: string[]
        workflowModels: NonNullable<ProviderDescriptor['workflowModels']>
        modelDetails?: NonNullable<ProviderDescriptor['modelDetails']>
        loadedModels?: string[]
      }>('providers/check', { providerId })
      this.patch({
        providerChecks: { ...this.snapshot.providerChecks, [providerId]: { state: 'ok', latencyMs: result.latencyMs, transport: result.transport } },
      })
      const provider = this.snapshot.providers.find(candidate => candidate.id === providerId)
      if (checkDiscoversModels && provider !== undefined
        && provider.baseUrl === expected?.baseUrl
        && this.modelRefreshVersions.get(providerId) === refreshVersion) {
        this.patch({
          providers: this.snapshot.providers.map(candidate => candidate.id === providerId
            ? withDiscoveredModels(candidate, result)
            : candidate),
        })
      } else if (provider !== undefined
        && provider.baseUrl === expected?.baseUrl
        && (provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp')) {
        await this.refreshProviderModels(providerId)
      }
    } catch (error) {
      this.patch({
        providerChecks: { ...this.snapshot.providerChecks, [providerId]: { state: 'error', message: errorMessage(error) } },
        ...(checkDiscoversModels
          && this.snapshot.providers.some(provider => provider.id === providerId && provider.baseUrl === expected?.baseUrl)
          && this.modelRefreshVersions.get(providerId) === refreshVersion
          ? {
              providers: this.snapshot.providers.map(provider => provider.id === providerId
                ? { ...provider, modelDiscovery: { state: 'error', message: errorMessage(error) } }
                : provider),
            }
          : {}),
      })
    }
  }

  async refreshProviderModels(providerId: string): Promise<void> {
    const expected = this.snapshot.providers.find(provider => provider.id === providerId)
    if (expected === undefined) return
    const refreshVersion = (this.modelRefreshVersions.get(providerId) ?? 0) + 1
    this.modelRefreshVersions.set(providerId, refreshVersion)
    this.patch({
      providers: this.snapshot.providers.map(provider => provider.id === providerId
        ? { ...provider, modelDiscovery: { state: 'loading' } }
        : provider),
    })
    try {
      const result = await this.rpc<{
        models: string[]
        workflowModels: NonNullable<ProviderDescriptor['workflowModels']>
        modelDetails?: NonNullable<ProviderDescriptor['modelDetails']>
        loadedModels?: string[]
      }>('providers/models', { providerId })
      const current = this.snapshot.providers.find(provider => provider.id === providerId)
      if (current === undefined || current.baseUrl !== expected.baseUrl || this.modelRefreshVersions.get(providerId) !== refreshVersion) return
      const providers = this.snapshot.providers.map(provider => provider.id === providerId
        ? withDiscoveredModels(provider, result)
        : provider)
      this.patch({ providers })
    } catch (error) {
      const current = this.snapshot.providers.find(provider => provider.id === providerId)
      if (current === undefined || current.baseUrl !== expected.baseUrl || this.modelRefreshVersions.get(providerId) !== refreshVersion) return
      this.patch({
        providers: this.snapshot.providers.map(provider => provider.id === providerId
          ? { ...provider, modelDiscovery: { state: 'error', message: errorMessage(error) } }
          : provider),
      })
    }
  }

  async unloadProviderModel(providerId: string, model: string): Promise<void> {
    const expected = this.snapshot.providers.find(provider => provider.id === providerId)
    if (expected === undefined || expected.kind !== 'ollama' || model.trim() === '') return
    this.patch({
      providers: this.snapshot.providers.map(provider => provider.id === providerId
        ? { ...provider, modelDiscovery: { state: 'loading' } }
        : provider),
    })
    try {
      const result = await this.rpc<{ model: string; loaded: boolean }>('providers/unload-model', { providerId, model })
      const current = this.snapshot.providers.find(provider => provider.id === providerId)
      if (current === undefined || current.baseUrl !== expected.baseUrl) return
      this.patch({
        providers: this.snapshot.providers.map(provider => provider.id === providerId
          ? {
              ...provider,
              loadedModels: result.loaded
                ? [...new Set([...(provider.loadedModels ?? []), result.model])]
                : (provider.loadedModels ?? []).filter(candidate => candidate !== result.model),
              modelDiscovery: { state: 'ready' },
            }
          : provider),
      })
    } catch (error) {
      const current = this.snapshot.providers.find(provider => provider.id === providerId)
      if (current === undefined || current.baseUrl !== expected.baseUrl) return
      this.patch({
        providers: this.snapshot.providers.map(provider => provider.id === providerId
          ? { ...provider, modelDiscovery: { state: 'error', message: errorMessage(error) } }
          : provider),
      })
    }
  }

  async updateProvider(providerId: string, patch: Record<string, unknown>): Promise<void> {
    const result = await this.rpc<{ providers: ProviderDescriptor[] }>('providers/update', { providerId, patch })
    const providerChecks = { ...this.snapshot.providerChecks }
    delete providerChecks[providerId]
    this.patch({ providers: result.providers, providerChecks })
    const provider = result.providers.find(candidate => candidate.id === providerId)
    if (provider?.configured && (provider.kind === 'ollama' || provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp')) {
      await this.refreshProviderModels(providerId)
    }
  }

  async transcribeAudio(providerId: string, model: string, file: File): Promise<string> {
    if (file.size === 0 || file.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw new Error('音频文件必须大于 0，且不能超过 25 MiB。')
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    const mimeType = file.type.split(';', 1)[0] || ({
      flac: 'audio/flac', mp3: 'audio/mpeg', mp4: 'audio/mp4', mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
      m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm',
    } as Record<string, string>)[extension ?? '']
    if (mimeType === undefined || (!mimeType.startsWith('audio/') && mimeType !== 'video/mp4' && mimeType !== 'video/webm')) {
      throw new Error('不支持这个音频格式。请选择 FLAC、MP3、MP4、M4A、OGG、WAV 或 WebM。')
    }
    const result = await this.rpc<{ text: string }>('providers/transcribe', {
      providerId,
      audio: {
        model,
        name: file.name || `recording.${mimeType === 'audio/mp4' ? 'm4a' : 'webm'}`,
        mimeType,
        dataBase64: base64(new Uint8Array(await file.arrayBuffer())),
      },
    })
    return result.text
  }

  async importWorkflow(input: {
    name: string
    kind: ComfyWorkflowKind
    description?: string
    document: Record<string, unknown>
  }): Promise<ComfyWorkflowDescriptor> {
    const result = await this.rpc<{ workflow: ComfyWorkflowDescriptor; nodeDefinitions?: VdNodeDefinitionDescriptor[] }>('workflows/import', input)
    const workflows = [...this.snapshot.workflows.filter(workflow => workflow.id !== result.workflow.id), result.workflow]
      .sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name))
    this.patch({ workflows, ...(result.nodeDefinitions === undefined ? {} : { nodeDefinitions: result.nodeDefinitions }) })
    await this.refreshConfiguredComfyProviderModels()
    return result.workflow
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    if (this.snapshot.project?.graph.nodes.some(node => node.data.workflowId === workflowId)) {
      throw new Error('This workflow is still selected by a node in the current project. Choose another workflow and save the project before deleting it.')
    }
    const result = await this.rpc<{ workflows: ComfyWorkflowDescriptor[]; nodeDefinitions?: VdNodeDefinitionDescriptor[] }>('workflows/delete', { workflowId })
    this.patch({ workflows: result.workflows, ...(result.nodeDefinitions === undefined ? {} : { nodeDefinitions: result.nodeDefinitions }) })
  }

  async installNode(pack: Record<string, unknown>): Promise<VdNodeDefinitionDescriptor> {
    const result = await this.rpc<{
      definition: VdNodeDefinitionDescriptor
      workflows: ComfyWorkflowDescriptor[]
      nodeDefinitions: VdNodeDefinitionDescriptor[]
    }>('nodes/install', { pack })
    this.patch({ workflows: result.workflows, nodeDefinitions: result.nodeDefinitions })
    await this.refreshConfiguredComfyProviderModels()
    return result.definition
  }

  async deleteNodeDefinition(type: string, version: string): Promise<void> {
    if (this.snapshot.project?.graph.nodes.some(node => node.data.nodeType === type && (node.data.nodeVersion ?? '1.0.0') === version)) {
      throw new Error('This vd-node definition is still used by the current project. Remove it from the canvas and save before deleting it.')
    }
    const result = await this.rpc<{ workflows: ComfyWorkflowDescriptor[]; nodeDefinitions: VdNodeDefinitionDescriptor[] }>('nodes/remove', { type, version })
    this.patch({ workflows: result.workflows, nodeDefinitions: result.nodeDefinitions })
  }

  currentContext(): string {
    const project = this.snapshot.project
    if (project === null) return ''
    const nodes = project.graph.nodes.map(node => ({
      id: node.id,
      kind: node.data.kind,
      title: node.data.title,
      text: node.data.text,
      prompt: node.data.prompt,
      asset: node.data.asset === undefined ? undefined : {
        id: node.data.asset.id,
        kind: node.data.asset.kind,
        name: node.data.asset.name,
      },
      status: node.data.status,
      workflowId: node.data.workflowId,
      nodeType: node.data.nodeType,
      nodeVersion: node.data.nodeVersion,
    }))
    return JSON.stringify({
      project: { id: project.id, name: project.name, revision: project.revision, status: project.status },
      canvas: { nodes, edges: project.graph.edges },
    })
  }

  private async refreshConfiguredComfyProviderModels(): Promise<void> {
    const providerIds = this.snapshot.providers
      .filter(provider => provider.configured && (provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp'))
      .map(provider => provider.id)
    await Promise.all(providerIds.map(providerId => this.refreshProviderModels(providerId)))
  }

  private async installProjectArchive(
    nameOrResolver: string | ((archive: ProjectArchive) => string),
    archiveLoader: () => Promise<ProjectArchive>,
    linkedAssets: AssetRef[] = [],
  ): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before importing a project.')
    }
    if (this.snapshot.saving) {
      throw new Error('Wait for the current save to finish before importing a project.')
    }
    await this.cacheBeforeSwitch()
    const transition = ++this.transitionVersion
    let createdProjectId: string | undefined
    this.patch({ phase: 'loading', error: null, conflict: false })
    try {
      const archive = await archiveLoader()
      if (transition !== this.transitionVersion) return
      const name = typeof nameOrResolver === 'string' ? nameOrResolver : nameOrResolver(archive)
      const sessionId = await this.ctx.sessions.create()
      const binding = this.requireSessionBinding(sessionId)
      await this.renameSession(binding, name)
      const created = (await this.rpc<{ project: VideoProject }>('projects/create', { name, sessionId, unsaved: true })).project
      createdProjectId = created.id

      const restoredAssets = new Map<string, AssetRef>()
      for (const asset of linkedAssets) {
        const restored = await this.rpc<{ asset: AssetRef }>('assets/link', { projectId: created.id, sourceId: asset.id })
        restoredAssets.set(asset.id, restored.asset)
      }
      for (const asset of archive.assets) {
        const generated = archive.project.graph.nodes.some(node => !node.data.kind.startsWith('load-')
          && node.data.kind !== 'preview' && node.data.kind !== 'save'
          && collectAssetRefs([node.data.asset, node.data.assets, node.data.result]).has(asset.sourceId))
        const restored = (await this.rpc<{ asset: AssetRef }>('assets/put', {
          projectId: created.id,
          origin: asset.origin ?? (generated ? 'output' : 'input'),
          kind: asset.kind,
          name: asset.name,
          mimeType: asset.mimeType,
          dataBase64: asset.dataBase64,
        })).asset
        restoredAssets.set(asset.sourceId, restored)
      }
      const graph = rewriteArchiveAssets(archive.project.graph, restoredAssets) as DirectorGraph
      const draft = { name, graph, settings: structuredClone(archive.project.settings),
        ...(archive.project.mediaLibrary === undefined ? {} : { mediaLibrary: rewriteArchiveAssets(archive.project.mediaLibrary, restoredAssets) as AssetRef[] }) }
      await this.rpc('projects/draft', {
        projectId: created.id,
        draft,
      })
      const saved = { ...created, ...draft }
      const persisted = initializeProjectVramTriggers(
        initializeDefaultRegisteredImageWorkflows(
          normalizeLegacyProject(saved),
          this.snapshot.providers,
          this.snapshot.workflows,
        ),
        this.snapshot.providers,
      )
      if (transition !== this.transitionVersion) return

      const project = normalizeLoadedPromptValidation(persisted)
      const projects = [
        { ...project, nodeCount: project.graph.nodes.length },
        ...this.snapshot.projects.filter(value => value.id !== project.id),
      ]
      this.baseProject = structuredClone(persisted)
      this.savedState = this.historyState(project)
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      this.ctx.sessions.open(project.sessionId)
      createdProjectId = undefined
      this.patch({
        project,
        projects,
        dirty: true,
        saving: false,
        conflict: false,
        phase: 'ready',
        error: null,
      })
    } catch (error) {
      if (createdProjectId !== undefined) {
        try { await this.rpc('projects/delete', { projectId: createdProjectId }) } catch { /* best-effort rollback */ }
      }
      if (transition === this.transitionVersion) this.patch({ phase: 'error', error: errorMessage(error) })
      throw error
    }
  }

  private async loadProject(projectId: string, openSession: boolean): Promise<void> {
    const transition = ++this.transitionVersion
    this.patch({ phase: 'loading', error: null, conflict: false })
    try {
      const response = await this.rpc<{ project: VideoProject }>('projects/get', { projectId })
      const persistedProject = initializeProjectVramTriggers(
        initializeDefaultRegisteredImageWorkflows(
          normalizeLegacyProject(response.project),
          this.snapshot.providers,
          this.snapshot.workflows,
        ),
        this.snapshot.providers,
      )
      if (transition !== this.transitionVersion) return
      const sessionState = this.ctx.sessions.list.getSnapshot()
      let binding = this.ctx.sessions.binding(persistedProject.sessionId)
      let sessionReady = sessionState.byId[persistedProject.sessionId] !== undefined && binding !== undefined
      let sessionError: string | null = null
      if (!sessionReady) {
        try {
          const adoptedSessionId = await this.ctx.sessions.create({ sessionId: persistedProject.sessionId })
          if (adoptedSessionId !== persistedProject.sessionId) {
            throw new Error(`Session adoption returned ${adoptedSessionId} instead of ${persistedProject.sessionId}.`)
          }
          binding = this.requireSessionBinding(persistedProject.sessionId)
          await this.renameSession(binding, persistedProject.name)
          sessionReady = true
        } catch (error) {
          sessionError = errorMessage(error)
        }
      }
      if (transition !== this.transitionVersion) return
      const recovered = this.drafts.recover(projectId)
      const draft = recovered === undefined ? persistedProject.draft : recovered.draft
      const { draft: _draft, ...savedProject } = persistedProject
      const saved = normalizeLoadedPromptValidation(this.restoreCompletedJobResults(savedProject))
      const project = draft == null ? saved : normalizeLoadedPromptValidation(this.restoreCompletedJobResults({ ...savedProject, ...draft }))
      this.baseProject = structuredClone(persistedProject)
      this.savedState = this.historyState(saved)
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      if (sessionReady && (openSession || this.ctx.sessions.list.getSnapshot().current !== project.sessionId)) {
        this.ctx.sessions.open(project.sessionId)
      }
      this.patch({ project, phase: 'ready', dirty: project.hasSavedVersion === false || draft != null, saving: false, conflict: false, error: sessionError })
      if (recovered !== undefined) void this.drafts.flush(projectId).catch(error => this.patch({ error: errorMessage(error) }))
      if (project.graph.nodes.some(node => node.data.kind === 'batch-input' || node.data.kind === 'batch-output')) await this.refreshVdRuns()
      else void this.refreshVdRuns().catch(() => {})
      for (const job of project.jobs) {
        if ((job.status !== 'queued' && job.status !== 'running') || !project.graph.nodes.some(node => node.id === job.nodeId)) continue
        if (this.activeRuns.has(this.runKey(job.nodeId, project.id))) continue
        const activeRun: ActiveNodeRun = {
          projectId: project.id,
          projectGeneration: this.projectGeneration,
          clientRunId: job.clientRunId ?? job.id,
          jobId: job.id,
          workflowRunId: job.workflowRunId,
          suppressSeedUpdate: job.batchRunId !== undefined,
        }
        this.activeRuns.set(this.runKey(job.nodeId), activeRun)
        this.updateSystemNode(job.nodeId, {
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
          runStartedAt: job.startedAt,
          runCompletedAt: undefined,
        })
        this.scheduleJobPoll(job.id, job.nodeId, 0, activeRun)
      }
    } catch (error) {
      if (transition === this.transitionVersion) this.patch({ phase: 'error', error: errorMessage(error) })
      throw error
    }
  }

  private updateProject(project: VideoProject, origin: ProjectUpdateOrigin = 'user'): void {
    if (this.snapshot.phase === 'loading') return
    const current = this.snapshot.project
    if (current !== null && sameJson(project, current)) return
    if (origin === 'user' && current !== null && this.historyTransaction === null) {
      this.pushBounded(this.undoStack, this.historyState(current))
      this.redoStack.length = 0
    }
    if (origin !== 'system') this.editVersion += 1
    if (origin === 'system' && !this.snapshot.dirty) this.savedState = this.historyState(project)
    const projects = this.snapshot.projects.map(summary => summary.id === project.id
      ? { ...project, nodeCount: project.graph.nodes.length }
      : summary)
    this.patch({
      project,
      projects,
      dirty: origin === 'system' ? this.snapshot.dirty : this.isDirty(project),
      conflict: false,
      error: null,
    })
  }

  async saveProject(): Promise<void> {
    if (this.savePromise !== null) return this.savePromise
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before saving.')
    }
    const project = this.snapshot.project
    if (project === null || !this.snapshot.dirty) return
    const editVersion = this.editVersion
    const local = structuredClone(project)
    this.patch({ saving: true })
    this.drafts.pause(local.id)
    this.savePromise = this.drafts.settled(local.id).catch(() => {}).then(() => this.performSave(local, editVersion)).finally(() => {
      this.drafts.resume(local.id)
      const current = this.snapshot.project
      if (current?.id === local.id && this.snapshot.dirty) this.drafts.stage(local.id, this.historyState(current))
      else this.drafts.forget(local.id)
      this.savePromise = null
    })
    return this.savePromise
  }

  private async performSave(local: VideoProject, editVersion: number): Promise<void> {
    try {
      let saved: VideoProject
      try {
        saved = (await this.rpc<{ project: VideoProject }>('projects/save', {
          projectId: local.id,
          expectedRevision: local.revision,
          project: local,
        })).project
      } catch (error) {
        const remote = error as Error & { code?: string }
        if (remote.code !== 'video-director/revision-conflict') throw error
        saved = await this.forceSaveProject(local)
      }
      this.acceptSaved(saved, editVersion)
    } catch (error) {
      const conflict = (error as Error & { code?: string }).code === 'video-director/revision-conflict'
      this.patch({
        saving: false,
        conflict,
        error: conflict
          ? 'The current project could not overwrite the newer revision. Try Save again.'
          : errorMessage(error),
      })
      throw error
    }
  }

  private async forceSaveProject(local: VideoProject): Promise<VideoProject> {
    let candidate = local
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return (await this.rpc<{ project: VideoProject }>('projects/save', {
          projectId: candidate.id,
          expectedRevision: candidate.revision,
          project: candidate,
          force: true,
        })).project
      } catch (error) {
        const remote = error as Error & { code?: string }
        if (remote.code !== 'video-director/revision-conflict' || attempt === 3) throw error
        const latest = (await this.rpc<{ project: VideoProject }>('projects/get', { projectId: local.id })).project
        candidate = {
          ...latest,
          name: local.name,
          graph: local.graph,
          settings: local.settings,
          mediaLibrary: local.mediaLibrary ?? [],
        }
      }
    }
    throw new Error('The current project could not be force-saved.')
  }

  private acceptSaved(project: VideoProject, editVersion: number): void {
    const current = this.snapshot.project
    if (current === null || current.id !== project.id) {
      const projects = this.snapshot.projects.map(summary => summary.id === project.id
        ? { ...project, nodeCount: project.graph.nodes.length }
        : summary)
      this.patch({ projects, saving: false })
      return
    }
    this.baseProject = structuredClone(project)
    this.savedState = this.historyState(project)
    const unchanged = this.editVersion === editVersion
    const visible = unchanged
      ? project
      : {
          ...current,
          revision: project.revision,
          hasSavedVersion: project.hasSavedVersion,
          status: project.status,
          jobs: project.jobs,
          updatedAt: project.updatedAt,
        }
    const projects = this.snapshot.projects.map(summary => summary.id === project.id
      ? { ...visible, nodeCount: visible.graph.nodes.length }
      : summary)
    this.patch({
      project: visible,
      projects,
      dirty: this.isDirty(visible),
      saving: false,
      conflict: false,
      error: null,
    })
  }

  private isActiveRun(nodeId: string, activeRun: ActiveNodeRun, jobId?: string): boolean {
    if (this.disposed) return false
    if (this.activeRuns.get(this.runKey(nodeId, activeRun.projectId)) !== activeRun) return false
    if (jobId !== undefined && activeRun.jobId !== jobId) return false
    return true
  }

  private scheduleJobPoll(jobId: string, nodeId: string, delay = JOB_POLL_MS, activeRun = this.activeRuns.get(this.runKey(nodeId))): void {
    if (activeRun === undefined || !this.isActiveRun(nodeId, activeRun, jobId)) return
    const prior = this.jobTimers.get(jobId)
    if (prior !== undefined) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.jobTimers.delete(jobId)
      void this.pollJob(jobId, nodeId, activeRun)
    }, delay)
    this.jobTimers.set(jobId, timer)
  }

  private async pollJob(jobId: string, nodeId: string, activeRun: ActiveNodeRun): Promise<void> {
    if (!this.isActiveRun(nodeId, activeRun, jobId)) return
    const updateNode = (patch: Partial<DirectorNodeData>): void => this.updateSystemNode(nodeId, patch, activeRun.projectId)
    try {
      const { job } = await this.rpc<{ job: DirectorJob }>('jobs/get', { projectId: activeRun.projectId, jobId })
      if (!this.isActiveRun(nodeId, activeRun, jobId)) return
      activeRun.consecutivePollFailures = 0
      this.updateVisibleJob(job)
      if (job.status === 'queued' || job.status === 'running') {
        updateNode({ status: job.status, phase: job.phase, progress: job.progress, error: undefined, jobId,
          runStartedAt: job.startedAt, runCompletedAt: undefined })
        this.scheduleJobPoll(jobId, nodeId, JOB_POLL_MS, activeRun)
        return
      }
      if (job.status === 'completed' && job.result !== undefined) {
        this.applyJobResult(nodeId, job.result, activeRun)
      } else {
        updateNode({ status: 'failed', phase: job.phase, error: job.error ?? job.status, progress: job.progress })
      }
      if (this.activeRuns.get(this.runKey(nodeId, activeRun.projectId)) === activeRun) this.activeRuns.delete(this.runKey(nodeId, activeRun.projectId))
      activeRun.completion?.resolve(job)
    } catch (error) {
      if (!this.isActiveRun(nodeId, activeRun, jobId)) return
      if (!isPermanentJobPollError(error)) {
        const failures = (activeRun.consecutivePollFailures ?? 0) + 1
        activeRun.consecutivePollFailures = failures
        const currentProject = this.snapshot.project
        const currentJob = currentProject?.jobs.find(candidate => candidate.id === jobId)
        if (currentJob !== undefined) this.updateVisibleJob({ ...currentJob, phase: 'reconnecting' })
        const currentNode = this.snapshot.project?.graph.nodes.find(node => node.id === nodeId)
        updateNode({
          status: currentNode?.data.status === 'queued' ? 'queued' : 'running',
          phase: 'reconnecting',
          error: undefined,
          jobId,
        })
        this.scheduleJobPoll(jobId, nodeId, jobPollRetryDelay(failures), activeRun)
        return
      }
      updateNode({ status: 'failed', error: errorMessage(error) })
      this.activeRuns.delete(this.runKey(nodeId, activeRun.projectId))
      activeRun.completion?.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private applyJobResult(nodeId: string, result: VdNodeResult, activeRun?: ActiveNodeRun): void {
    if (activeRun !== undefined && (this.snapshot.project?.id !== activeRun.projectId || !this.isActiveRun(nodeId, activeRun, activeRun.jobId))) return
    const project = this.requireProject()
    const updated = this.projectWithJobResult(project, nodeId, result, true, activeRun)
    if (updated === project) return
    // A terminal result is not a user Undo step, but the materialized output and
    // auto-created Preview are explicit-save canvas changes.
    this.updateProject(updated, 'system-saveable')
  }

  private restoreCompletedJobResults(project: VideoProject): VideoProject {
    const latestJobIds = new Map<string, string>()
    for (const job of project.jobs) {
      if (job.projectId === project.id) latestJobIds.set(job.nodeId, job.id)
    }
    return project.jobs.reduce((current, job) => {
      if (job.batchRunId !== undefined || latestJobIds.get(job.nodeId) !== job.id || job.status !== 'completed' || job.result === undefined) return current
      if (current.graph.nodes.find(node => node.id === job.nodeId)?.data.mediaEditedFromJobId === job.id) return current
      return this.projectWithJobResult(current, job.nodeId, job.result, false)
    }, project)
  }

  private projectWithJobResult(
    project: VideoProject,
    nodeId: string,
    result: VdNodeResult,
    createPreview: boolean,
    activeRun?: ActiveNodeRun,
  ): VideoProject {
    const source = project.graph.nodes.find(node => node.id === nodeId)
    if (source === undefined) return project
    const payload = vdNodeResultPayload(result)
    const completedSeed = 'seed' in result && Number.isSafeInteger(result.seed) ? result.seed : undefined
    const submittedSeedState = activeRun?.seedStateAtSubmission
    const seedControl = submittedSeedState?.control ?? source.data.seedControlAfterGenerate
    const seedStateUnchanged = submittedSeedState === undefined
      ? source.data.seed === completedSeed
      : source.data.seed === submittedSeedState.seed
        && source.data.seedControlAfterGenerate === submittedSeedState.control
    const controlledSeed = activeRun?.suppressSeedUpdate === true || completedSeed === undefined || !seedStateUnchanged
      ? undefined
      : seedControl === 'randomize' && submittedSeedState !== undefined
        ? completedSeed
        : seedControl === 'increment'
          ? completedSeed >= Number.MAX_SAFE_INTEGER ? 0 : completedSeed + 1
          : seedControl === 'decrement'
            ? completedSeed === 0 ? Number.MAX_SAFE_INTEGER : completedSeed - 1
            : undefined
    const completedJob = activeRun?.jobId === undefined
      ? [...project.jobs].reverse().find(candidate => candidate.nodeId === nodeId && candidate.status === 'completed')
      : project.jobs.find(candidate => candidate.id === activeRun.jobId)
    const sourcePatch: Partial<DirectorNodeData> = {
      mediaEditId: undefined, mediaEditedFromJobId: undefined,
      status: 'completed', progress: 1, phase: 'completed', result, ...payload,
      runStartedAt: completedJob?.startedAt ?? completedJob?.createdAt ?? source.data.runStartedAt,
      runCompletedAt: completedJob?.completedAt ?? source.data.runCompletedAt,
      ...(completedSeed === undefined ? {} : { outputSeed: completedSeed }),
      ...(controlledSeed === undefined ? {} : { seed: controlledSeed }),
    }
    let nodes = project.graph.nodes.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, ...sourcePatch } }
      : node)
    let edges = [...project.graph.edges]
    if (createPreview) {
      nodes = nodes.map(node => node.data.kind === 'preview'
        && (node.data.derivedFrom === source.id || edges.some(edge => edge.source === source.id && edge.target === node.id))
        ? { ...node, data: resumedPreviewData(node.data) }
        : node)
    }
    const existingPreview = nodes.find(node => (
      (node.data.kind === 'preview' || node.data.kind === 'batch-output')
      && (node.data.derivedFrom === source.id || edges.some(edge => edge.source === source.id && edge.target === node.id))
    ))
    if (createPreview && existingPreview === undefined) {
      const previewId = crypto.randomUUID()
      const definition = this.snapshot.nodeDefinitions.find(candidate => candidate.type === 'core.preview')
      const preview: DirectorNode = {
        id: previewId,
        type: 'director',
        position: { x: source.position.x + 420, y: source.position.y },
        data: {
          kind: 'preview',
          title: 'Preview',
          nodeType: 'core.preview',
          nodeVersion: definition?.version ?? '1.0.0',
          nodeDigest: definition?.digest ?? 'builtin:core.preview@1.0.0',
          derivedFrom: source.id,
          status: 'completed',
          result,
          ...payload,
        },
      }
      nodes.push(preview)

      const completedSource = nodes.find(node => node.id === nodeId) ?? source
      const sourceDefinition = nodeDefinition(completedSource.data, this.snapshot.nodeDefinitions)
      const resultTypes: MediaKind[] = result.kind === 'assets'
        ? [...new Set(result.assets.map(asset => asset.kind))]
        : ['text']
      const sourcePorts = portsFor(sourceDefinition, 'output')
      const sourcePort = sourcePorts.find(port => mediaTypesIntersect(port.types, resultTypes)) ?? sourcePorts[0]
      const sourceHandle = sourceDefinition === undefined || sourcePort === undefined
        ? 'out'
        : portHandleId('output', sourcePort, sourcePorts.length)
      const candidate: DirectorEdge = {
        id: crypto.randomUUID(),
        source: nodeId,
        sourceHandle,
        target: previewId,
        targetHandle: 'in',
      }
      const ports = resolveConnectionPorts(
        { ...project.graph, nodes, edges },
        this.snapshot.nodeDefinitions,
        candidate,
      )
      edges.push({
        ...candidate,
        sourceHandle: ports.sourceHandle,
        targetHandle: ports.targetHandle,
        data: { sourcePortId: ports.sourcePortId, targetPortId: ports.targetPortId },
      })
    }

    nodes = recomputeSinkPayloads(nodes, edges, this.snapshot.nodeDefinitions)
    return { ...project, graph: { ...project.graph, nodes, edges } }
  }

  private nextPosition(): { x: number; y: number } {
    const project = this.snapshot.project
    const count = project?.graph.nodes.length ?? 0
    return { x: 120 + (count % 4) * 330, y: 120 + Math.floor(count / 4) * 260 }
  }

  private defaultWorkflow(kind: ComfyWorkflowKind): ComfyWorkflowDescriptor | undefined {
    if (kind === 'video-generation') {
      const textImageVideo = this.snapshot.workflows.find(workflow => workflow.id === 'builtin-minimax-h3-video-turbo')
      if (textImageVideo !== undefined) return textImageVideo
    }
    return this.snapshot.workflows.find(workflow => workflow.kind === kind)
  }

  private historyState(project: VideoProject): ProjectHistoryState {
    return structuredClone({
      name: project.name,
      graph: project.graph,
      settings: project.settings,
      mediaLibrary: project.mediaLibrary ?? [],
    })
  }

  private isDirty(project: VideoProject): boolean {
    return project.hasSavedVersion === false || (this.savedState !== null && !sameJson(this.historyState(project), this.savedState))
  }

  private pushBounded(stack: ProjectHistoryState[], state: ProjectHistoryState): void {
    stack.push(structuredClone(state))
    if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT)
  }

  private resetHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.historyTransaction = null
  }

  private applyHistoryState(current: VideoProject, state: ProjectHistoryState): void {
    const runtimeKeys: Array<keyof DirectorNodeData> = [
      'status', 'phase', 'progress', 'jobId', 'error', 'result', 'derivedFrom', 'outputSeed', 'runStartedAt', 'runCompletedAt',
    ]
    const currentNodes = new Map(current.graph.nodes.map(node => [node.id, node]))
    const nodes = state.graph.nodes.map(node => {
      const live = currentNodes.get(node.id)
      if (live === undefined) return node
      if (live.data.mediaEditId !== node.data.mediaEditId) return node
      const data = { ...node.data }
      for (const key of runtimeKeys) {
        if (key in live.data) data[key] = live.data[key]
        else delete data[key]
      }
      if (!node.data.kind.startsWith('load-')) {
        if ('asset' in live.data) data.asset = live.data.asset
        else delete data.asset
        if ('assets' in live.data) data.assets = live.data.assets
        else delete data.assets
        if ('mediaKind' in live.data) data.mediaKind = live.data.mediaKind
        else delete data.mediaKind
      }
      return { ...node, data }
    })
    const project: VideoProject = {
      ...current,
      name: state.name,
      graph: { ...structuredClone(state.graph), nodes },
      settings: structuredClone(state.settings),
      ...((state.mediaLibrary !== undefined || current.mediaLibrary !== undefined) ? { mediaLibrary: structuredClone(state.mediaLibrary ?? []) } : {}),
    }
    this.editVersion += 1
    this.patch({ project, dirty: this.isDirty(project), conflict: false, error: null })
  }

  private requireProject(): VideoProject {
    const project = this.snapshot.project
    if (project === null) throw new Error('Create or select a Video Project first.')
    return project
  }

  private requireSessionBinding(sessionId: string): SessionBinding {
    if (this.ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
      throw new Error(`Session ${sessionId} was not listed after creation.`)
    }
    const binding = this.ctx.sessions.binding(sessionId)
    if (binding === undefined) {
      throw new Error(`Session ${sessionId} had no binding after creation.`)
    }
    return binding
  }

  private async renameSession(binding: SessionBinding, title: string): Promise<void> {
    const result = await binding.session.rename(title)
    if (!result.ok) throw remoteError(result.error)
  }

  private patch(patch: Partial<DirectorSnapshot>): void {
    const previous = this.snapshot
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    }
    const project = this.snapshot.project
    if (project !== null) {
      this.snapshot.projects = this.snapshot.projects.map(row => row.id === project.id
        ? { ...row, name: project.name, nodeCount: project.graph.nodes.length, unsaved: this.snapshot.dirty,
            hasSavedVersion: project.hasSavedVersion !== false } : row)
      if (this.snapshot.phase === 'ready' && previous.project?.id === project.id
        && (previous.project !== project || previous.dirty !== this.snapshot.dirty)
        && (this.snapshot.dirty || previous.dirty)) {
        this.drafts.stage(project.id, this.snapshot.dirty ? this.historyState(project) : null)
      }
    }
    for (const listener of [...this.listeners]) listener()
  }

  private async rpc<T = unknown>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const result = await this.ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal) as RemoteResult<T>
    if (result.ok) return result.value
    throw remoteError(result.error)
  }

  storage<T>(endpoint: 'info' | 'open' | 'choose' | 'change' | 'reset', payload: unknown = {}, signal?: AbortSignal): Promise<T> {
    return this.rpc<T>(`storage/${endpoint}`, payload, signal)
  }
}
