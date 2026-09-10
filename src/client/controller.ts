import type { Edge, Node, Viewport } from '@xyflow/react'
import type {
  AssetRef,
  ClientContext,
  DirectorGraph,
  DirectorEdge,
  DirectorJob,
  DirectorNode,
  DirectorNodeData,
  DirectorSnapshot,
  VdRun,
  MediaKind,
  VdNodeDefinitionDescriptor,
  ObservableSource,
  ProjectSummary,
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
  graph?: DirectorGraph
  sourceRevision?: number
  workflowRunId?: string
  workflowRunMode?: VdRunMode
  batchIndex?: number
  batchSize?: number
  seed?: number
  awaitCompletion?: boolean
  signal?: AbortSignal
}

interface ProjectArchiveAsset {
  sourceId: string
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

function fileKind(file: File): Exclude<MediaKind, 'text' | 'mask' | 'flow'> {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension ?? '')) return 'image'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(extension ?? '')) return 'audio'
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension ?? '')) return 'video'
  throw new Error(`Unsupported media type: ${file.type || file.name}`)
}

function inferredMimeType(file: File, kind: Exclude<MediaKind, 'text' | 'mask' | 'flow'>): string {
  if (file.type !== '') return file.type
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  const byExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: kind === 'audio' ? 'audio/webm' : 'video/webm', mov: 'video/quicktime',
  }
  if (kind === 'sketch') return 'image/png'
  const inferred = extension === undefined ? undefined : byExtension[extension]
  if (inferred === undefined || !inferred.startsWith(`${kind}/`)) {
    throw new Error(`Cannot infer a supported ${kind} MIME type from ${file.name}`)
  }
  return inferred
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
    previewCleared: _previewCleared,
    status: _status,
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
  const refs = [...collectAssetRefs(graph).values()]
  const assets = await Promise.all(refs.map(async (asset): Promise<ProjectArchiveAsset> => {
    const response = await fetch(asset.url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Could not export asset “${asset.name}” (${String(response.status)}).`)
    return {
      sourceId: asset.id,
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
      || typeof value.dataBase64 !== 'string' || value.dataBase64 === ''
      || value.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.dataBase64)) {
      throw new Error(`The project export has invalid asset data at position ${String(index + 1)}.`)
    }
    if (sourceIds.has(value.sourceId)) throw new Error(`The project export contains duplicate asset ${value.sourceId}.`)
    sourceIds.add(value.sourceId)
    return {
      sourceId: value.sourceId,
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
  for (const asset of collectAssetRefs(clonedGraph).values()) {
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

function withDefaultRegisteredImageWorkflow(
  data: DirectorNodeData,
  providers: readonly ProviderDescriptor[],
  workflows: readonly ComfyWorkflowDescriptor[],
): DirectorNodeData {
  if ((data.kind !== 'image-generation' && data.kind !== 'image-edit')
    || data.workflowId !== undefined
    || data.workflow !== undefined) return data
  const provider = providers.find(candidate => candidate.id === data.providerId)
  if (provider?.kind !== 'comfyui' && provider?.kind !== 'comfyui-mcp') return data
  const workflow = workflows.find(candidate => candidate.kind === 'image-generation' || candidate.kind === 'image-edit')
  if (workflow === undefined) return data
  return {
    ...workflow.defaults,
    ...data,
    kind: workflow.kind,
    workflowId: workflow.id,
    modelFamily: workflow.modelFamily ?? workflow.defaults.modelFamily,
    workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
  }
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

function vdNodeResultPayload(result: VdNodeResult): Partial<DirectorNodeData> {
  if (result.kind === 'assets') {
    return {
      assets: result.assets,
      asset: result.assets[0],
      mediaKind: result.assets[0]?.kind,
      text: undefined,
    }
  }
  return {
    assets: undefined,
    asset: undefined,
    mediaKind: 'text',
    text: result.kind === 'text' ? result.text : JSON.stringify(result.result, null, 2),
  }
}

function storedVdNodeResult(value: unknown): VdNodeResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<VdNodeResult>
  if (candidate.kind === 'assets' && Array.isArray(candidate.assets)) return candidate as VdNodeResult
  if (candidate.kind === 'text' && typeof candidate.text === 'string') return candidate as VdNodeResult
  if (candidate.kind === 'mcp-result' && 'result' in candidate) return candidate as VdNodeResult
  return undefined
}

function nodeOutputPayload(data: DirectorNodeData): Partial<DirectorNodeData> | undefined {
  const result = storedVdNodeResult(data.result)
  if (result !== undefined) return { ...vdNodeResultPayload(result), result }
  if (data.asset === undefined && data.assets === undefined && data.text === undefined) return undefined
  return {
    asset: data.asset,
    assets: data.assets ?? (data.asset === undefined ? undefined : [data.asset]),
    text: data.text,
    mediaKind: data.mediaKind,
    result: data.result,
  }
}

function hasReusableNodeOutput(node: DirectorNode): boolean {
  if (node.data.kind === 'load-text') {
    return typeof node.data.text === 'string' && node.data.text.trim() !== ''
  }
  if (node.data.kind === 'load-image'
    || node.data.kind === 'load-video'
    || node.data.kind === 'load-audio') {
    return node.data.asset !== undefined || (node.data.assets?.length ?? 0) > 0
  }
  const payload = nodeOutputPayload(node.data)
  return payload?.result !== undefined
    || payload?.asset !== undefined
    || (payload?.assets?.length ?? 0) > 0
    || (typeof payload?.text === 'string' && payload.text.trim() !== '')
}

function edgeFieldInputId(edge: DirectorEdge): string | undefined {
  const stored = fieldIdFromInputPort(edge.data?.targetPortId)
  if (stored !== undefined) return stored
  return typeof edge.targetHandle === 'string' && edge.targetHandle.startsWith('in:')
    ? fieldIdFromInputPort(edge.targetHandle.slice(3))
    : undefined
}

function combinedSinkPayload(
  nodes: readonly DirectorNode[],
  edges: readonly DirectorEdge[],
  sinkId: string,
  definitions: readonly VdNodeDefinitionDescriptor[],
): Partial<DirectorNodeData> | undefined {
  const graph: DirectorGraph = { nodes: [...nodes], edges: [...edges], viewport: { x: 0, y: 0, zoom: 1 } }
  const payloads: Array<{ node: DirectorNode; payload: Partial<DirectorNodeData> }> = []
  for (const edge of edges.filter(candidate => candidate.target === sinkId)) {
    const node = nodes.find(candidate => candidate.id === edge.source)
    if (node === undefined) continue
    const payload = nodeOutputPayload(node.data)
    if (payload === undefined) continue
    const ports = resolveEdgePorts(graph, definitions, edge)
    const carriedTypes = ports.sourceTypes.filter(type => ports.targetTypes.includes(type))
    const assets = (payload.assets ?? (payload.asset === undefined ? [] : [payload.asset]))
      .filter(asset => carriedTypes.includes(asset.kind))
    const text = carriedTypes.includes('text') ? payload.text : undefined
    if (assets.length === 0 && (text === undefined || text === '')) continue
    const stored = storedVdNodeResult(payload.result)
    const result = stored?.kind === 'assets'
      ? { ...stored, assets }
      : payload.result
    payloads.push({
      node,
      payload: {
        asset: assets[0],
        assets: assets.length === 0 ? undefined : assets,
        text,
        mediaKind: assets[0]?.kind ?? (text === undefined ? undefined : 'text'),
        result,
      },
    })
  }
  if (payloads.length === 0) return undefined

  const seenAssets = new Set<string>()
  const assets = payloads.flatMap(({ payload }) => payload.assets ?? (payload.asset === undefined ? [] : [payload.asset]))
    .filter(asset => {
      if (seenAssets.has(asset.id)) return false
      seenAssets.add(asset.id)
      return true
    })
  const texts = payloads
    .map(({ payload }) => payload.text)
    .filter((value): value is string => value !== undefined && value !== '')
  const results = payloads
    .map(({ payload }) => payload.result)
    .filter(value => value !== undefined)
  return {
    asset: assets[0],
    assets: assets.length === 0 ? undefined : assets,
    text: texts.length === 0 ? undefined : texts.join('\n\n'),
    mediaKind: assets[0]?.kind ?? (texts.length > 0 ? 'text' : undefined),
    result: results.length === 0 ? undefined : results.length === 1 ? results[0] : results,
    status: 'completed',
    phase: 'completed',
    progress: 1,
    derivedFrom: payloads.length === 1 ? payloads[0].node.id : undefined,
  }
}

function clearedSinkData(data: DirectorNodeData): DirectorNodeData {
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
    previewCleared: _previewCleared,
    ...rest
  } = data
  return { ...rest, status: 'idle' }
}

function suppressedPreviewData(data: DirectorNodeData): DirectorNodeData {
  return { ...clearedSinkData(data), previewCleared: true }
}

function resumedPreviewData(data: DirectorNodeData): DirectorNodeData {
  const { previewCleared: _previewCleared, ...rest } = data
  return rest as DirectorNodeData
}

const EXECUTABLE_NODE_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
  'vram-trigger',
  'ollama-eject',
  'comfyui-clear',
])

function duplicatedNodeData(data: DirectorNodeData, patch: Partial<DirectorNodeData>): DirectorNodeData {
  const merged = { ...data, ...patch }
  if (merged.kind === 'preview' || merged.kind === 'save') return clearedSinkData(merged)
  if (!EXECUTABLE_NODE_KINDS.has(merged.kind)) return { ...merged, status: 'idle', jobId: undefined, error: undefined }
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
    ...rest
  } = merged
  return { ...rest, status: 'idle' }
}

function recomputeSinkPayloads(
  nodes: readonly DirectorNode[],
  edges: readonly DirectorEdge[],
  definitions: readonly VdNodeDefinitionDescriptor[],
): DirectorNode[] {
  const sinks = new Set(nodes
    .filter(node => (
      (node.data.kind === 'preview' || node.data.kind === 'save')
      && node.data.frozen !== true
      && node.data.previewCleared !== true
    ))
    .map(node => node.id))
  if (sinks.size === 0) return [...nodes]

  let current = nodes.map(node => sinks.has(node.id)
    ? { ...node, data: clearedSinkData(node.data) }
    : node)
  for (let pass = 0; pass <= sinks.size; pass += 1) {
    let changed = false
    const next = current.map(node => {
      if (!sinks.has(node.id)) return node
      const payload = combinedSinkPayload(current, edges, node.id, definitions)
      if (payload === undefined) return node
      const data = { ...node.data, ...payload }
      if (sameJson(data, node.data)) return node
      changed = true
      return { ...node, data }
    })
    current = next
    if (!changed) break
  }
  return current
}

export class DirectorController implements ObservableSource<DirectorSnapshot> {
  private snapshot = emptySnapshot()
  private baseProject: VideoProject | null = null
  private readonly listeners = new Set<() => void>()
  private savePromise: Promise<void> | null = null
  private editVersion = 0
  private savedState: ProjectHistoryState | null = null
  private openedProject: { id: string; state: ProjectHistoryState } | null = null
  private readonly undoStack: ProjectHistoryState[] = []
  private readonly redoStack: ProjectHistoryState[] = []
  private historyTransaction: { projectId: string; before: ProjectHistoryState } | null = null
  private projectGeneration = 0
  private transitionVersion = 0
  private disposed = false
  private readonly jobTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeRuns = new Map<string, ActiveNodeRun>()
  private readonly vdRunControllers = new Map<string, AbortController>()
  private vdRunTail: Promise<void> = Promise.resolve()
  private readonly vdRunSnapshots = new Map<string, Pick<VideoProject, 'name' | 'graph' | 'settings'>>()
  private readonly vdRunWrites = new Map<string, Promise<unknown>>()
  private readonly modelRefreshVersions = new Map<string, number>()
  private nodeClipboard: { projectId: string; nodes: DirectorNode[]; edges: DirectorEdge[] } | null = null

  constructor(private readonly ctx: ClientContext) {}

  getSnapshot = (): DirectorSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async start(): Promise<void> {
    this.patch({ phase: 'loading', error: null })
    try {
      const [projects, providers, workflows, nodes] = await Promise.all([
        this.rpc<{ projects: ProjectSummary[] }>('projects/list', {}),
        this.rpc<{ providers: ProviderDescriptor[] }>('providers/list', {}),
        this.rpc<{ workflows: ComfyWorkflowDescriptor[] }>('workflows/list', {}),
        this.rpc<{ nodeDefinitions: VdNodeDefinitionDescriptor[] }>('nodes/list', {})
          .catch(() => ({ nodeDefinitions: [] })),
      ])
      this.patch({
        projects: projects.projects,
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
    } catch (error) {
      this.patch({ phase: 'error', error: errorMessage(error) })
    }
  }

  open = (): void => { this.patch({ open: true }) }

  close = (): void => { this.patch({ open: false }) }

  private stopVdRunSchedulers(message = 'vd-run stopped because the project changed.'): void {
    for (const controller of this.vdRunControllers.values()) controller.abort(message)
    this.vdRunControllers.clear()
    for (const active of this.activeRuns.values()) active.completion?.reject(new Error(message))
  }

  dispose = (): void => {
    this.disposed = true
    for (const timer of this.jobTimers.values()) clearTimeout(timer)
    this.jobTimers.clear()
    this.stopVdRunSchedulers('vd-run scheduler was disposed.')
    this.activeRuns.clear()
    this.listeners.clear()
  }

  async createProject(name: string): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before creating another project.')
    }
    if (this.snapshot.dirty || this.snapshot.saving) {
      throw new Error('Save or discard the current project changes before creating another project.')
    }
    const transition = ++this.transitionVersion
    this.patch({ phase: 'loading', error: null, conflict: false })
    try {
      const sessionId = await this.ctx.sessions.create()
      const binding = this.requireSessionBinding(sessionId)
      await this.renameSession(binding, name)
      const { project } = await this.rpc<{ project: VideoProject }>('projects/create', { name, sessionId })
      if (transition !== this.transitionVersion) return
      const projects = [
        { ...project, nodeCount: project.graph.nodes.length },
        ...this.snapshot.projects.filter(row => row.id !== project.id),
      ]
      this.baseProject = structuredClone(project)
      this.savedState = this.historyState(project)
      this.openedProject = { id: project.id, state: this.historyState(project) }
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      this.stopVdRunSchedulers()
      this.activeRuns.clear()
      this.ctx.sessions.open(project.sessionId)
      this.patch({ project, projects, dirty: false, saving: false, phase: 'ready', workflowRuns: [] })
    } catch (error) {
      if (transition === this.transitionVersion) this.patch({ phase: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async exportProject(): Promise<ExportedProjectArchive> {
    const project = structuredClone(this.requireProject())
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

  async refreshVdRuns(): Promise<void> {
    const project = this.requireProject()
    const { runs } = await this.rpc<{ runs: VdRun[] }>('vd-runs/list', { projectId: project.id })
    if (this.snapshot.project?.id !== project.id) return
    const current = new Map(this.snapshot.workflowRuns.map(run => [run.id, run]))
    this.patch({ workflowRuns: runs.map(run => current.get(run.id) ?? run)
      .concat(this.snapshot.workflowRuns.filter(run => !runs.some(saved => saved.id === run.id))) })
  }

  private async submittedVdWorkflow(runId: string): Promise<Pick<VideoProject, 'name' | 'graph' | 'settings'>> {
    const cached = this.vdRunSnapshots.get(runId)
    if (cached !== undefined) return structuredClone(cached)
    const { run } = await this.rpc<{ run: VdRun & { snapshot: Pick<VideoProject, 'name' | 'graph' | 'settings'> } }>(
      'vd-runs/get', { projectId: this.requireProject().id, runId },
    )
    return run.snapshot
  }

  async openVdWorkflow(runId: string): Promise<void> {
    try {
      const projectId = this.requireProject().id
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
      const project = this.requireProject()
      const submitted = await this.submittedVdWorkflow(runId)
      const archive = await archiveForProject({ ...project, ...submitted })
      return { filename: projectArchiveFilename(`${submitted.name}-${runId.slice(0, 8)}`), text: `${JSON.stringify(archive, null, 2)}\n` }
    } catch (error) {
      this.patch({ error: errorMessage(error) })
      throw error
    }
  }

  async duplicateProject(): Promise<void> {
    const project = structuredClone(this.requireProject())
    const usedNames = new Set(this.snapshot.projects.map(value => value.name.toLocaleLowerCase()))
    let copyNumber = 1
    let name = ''
    do {
      const suffix = copyNumber === 1 ? ' Copy' : ` Copy ${String(copyNumber)}`
      name = `${project.name.slice(0, Math.max(1, 120 - suffix.length)).trimEnd()}${suffix}`
      copyNumber += 1
    } while (usedNames.has(name.toLocaleLowerCase()))
    await this.installProjectArchive(name, () => archiveForProject(project))
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
      if (this.snapshot.dirty) await this.saveProject()
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
    if (this.snapshot.dirty && options.discard !== true) {
      throw new Error('Save or discard the current project changes before switching projects.')
    }
    if (this.snapshot.conflict) throw new Error('Resolve the save conflict before switching projects.')
    await this.loadProject(projectId, true)
  }

  async discardChanges(): Promise<void> {
    const project = this.snapshot.project
    if (project === null || this.snapshot.saving || this.snapshot.phase === 'loading') return
    await this.loadProject(project.id, false)
  }

  /** Restore this opening's workflow snapshot locally; explicit saves keep the restore point. */
  restoreOpenedProject(): void {
    const current = this.snapshot.project
    if (current === null || this.openedProject?.id !== current.id) return
    if (this.snapshot.saving || this.snapshot.phase === 'loading') {
      throw new Error('请等待当前工程操作完成后再放弃更改。')
    }
    if (this.activeRuns.size > 0 || this.vdRunControllers.size > 0
      || current.jobs.some(job => job.status === 'queued' || job.status === 'running')
      || this.snapshot.workflowRuns.some(run => run.projectId === current.id && (run.status === 'queued' || run.status === 'running'))) {
      throw new Error('请等待任务结束或取消任务后再放弃更改。')
    }
    const project = { ...current, ...structuredClone(this.openedProject.state) }
    // An execution that was active on opening cannot be rewound with the canvas.
    project.graph.nodes = project.graph.nodes.map(node => {
      if (node.data.status !== 'queued' && node.data.status !== 'running') return node
      const job = current.jobs.find(job => job.id === node.data.jobId)
      return { ...node, data: { ...node.data, status: job === undefined ? 'idle' : job.status === 'completed' ? 'completed' : 'failed', phase: job?.phase,
        progress: job?.progress, error: job?.error, result: job?.result } }
    })
    this.resetHistory()
    this.editVersion += 1
    this.projectGeneration += 1
    this.patch({
      project,
      projects: this.snapshot.projects.map(summary => summary.id === project.id
        ? { ...project, nodeCount: project.graph.nodes.length } : summary),
      dirty: this.isDirty(project),
      conflict: false,
      error: null,
      canvasResetVersion: this.snapshot.canvasResetVersion + 1,
    })
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
      const result = await this.rpc<{ projects?: ProjectSummary[] }>('projects/delete', { projectId })
      if (transition !== this.transitionVersion) return
      const projects = result.projects ?? this.snapshot.projects.filter(project => project.id !== projectId)
      if (!deletingCurrent) {
        this.patch({ projects, phase: 'ready' })
        return
      }

      for (const timer of this.jobTimers.values()) clearTimeout(timer)
      this.jobTimers.clear()
      this.stopVdRunSchedulers()
      this.activeRuns.clear()
      this.projectGeneration += 1
      this.baseProject = null
      this.savedState = null
      this.openedProject = null
      this.editVersion = 0
      this.resetHistory()
      this.patch({
        projects,
        project: null,
        dirty: false,
        saving: false,
        conflict: false,
        phase: 'ready',
        workflowRuns: [],
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
    if (node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(nodeId)) {
      throw new Error('Cancel the active job before changing this node\'s Freeze state.')
    }
    if (node.data.frozen === frozen) return
    const clearMissingResultError = !frozen && node.data.phase === 'frozen-missing-result'
    this.updateNode(nodeId, {
      frozen,
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
    if (targets.some(node => node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(node.id))) {
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

  private updateSystemNode(nodeId: string, patch: Partial<DirectorNodeData>): void {
    const project = this.snapshot.project
    if (project === null) return
    const nodes = project.graph.nodes.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, ...patch } }
      : node)
    const graph: DirectorGraph = {
      ...project.graph,
      nodes: recomputeSinkPayloads(nodes, project.graph.edges, this.snapshot.nodeDefinitions),
    }
    this.updateProject({ ...project, graph }, 'system')
  }

  private updateVisibleJob(job: DirectorJob): void {
    const project = this.snapshot.project
    if (project === null || job.projectId !== project.id) return
    const existing = project.jobs.findIndex(candidate => candidate.id === job.id)
    const jobs = (existing < 0
      ? [...project.jobs, job]
      : project.jobs.map((candidate, index) => index === existing ? job : candidate))
      .sort((left, right) => (left.runSequence ?? 0) - (right.runSequence ?? 0))
      .slice(-100)
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

  private patchVdRun(id: string, patch: Partial<VdRun>): void {
    const workflowRuns = this.snapshot.workflowRuns.map(run => run.id === id ? { ...run, ...patch } : run)
    this.patch({ workflowRuns })
  }

  private persistVdRun(run: VdRun, snapshot?: Pick<VideoProject, 'name' | 'graph' | 'settings'>): Promise<unknown> {
    const previous = this.vdRunWrites.get(run.id) ?? Promise.resolve()
    const submittedRun = structuredClone(run)
    const write = previous.catch(() => {}).then(() => this.rpc('vd-runs/save', {
      projectId: run.projectId, run: submittedRun, ...(snapshot === undefined ? {} : { snapshot }),
    }))
    this.vdRunWrites.set(run.id, write)
    return write
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
    const running = targets.find(node => node.data.status === 'queued' || node.data.status === 'running' || this.activeRuns.has(node.id))
    if (running !== undefined) throw new Error(`Cancel ${running.data.title} before deleting it.`)
    for (const node of targets) {
      this.activeRuns.delete(node.id)
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
    if (definition.behavior === 'preview' || definition.behavior === 'save' || definition.behavior === 'trigger') {
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
    if (this.activeRuns.get(nodeId)?.workflowRunId !== undefined) {
      throw new Error('This node is executing a submitted workflow. Queue another workflow or cancel its current run first.')
    }
    const node = this.requireProject().graph.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined) throw new Error(`Node ${nodeId} was not found`)
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
    if ((this.snapshot.saving && options.workflowRunId === undefined) || this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project operation before running a trigger node.')
    }
    const project = this.requireProject()
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
      this.updateSystemNode(nodeId, {
        status: 'running',
        phase: action === 'ollama-eject'
          ? 'ejecting-models'
          : action === 'comfyui-clear' ? 'unloading-and-clearing-cache' : 'bypassing',
        progress: 0.5,
        error: undefined,
        jobId: undefined,
      })
      await this.rpc('triggers/run', { action, releaseWaitSeconds }, options.signal)
      if (signalAborted(options.signal)) throw new Error('vd-run was cancelled.')
      this.updateSystemNode(nodeId, {
        status: 'completed',
        phase: 'completed',
        progress: 1,
        error: undefined,
        jobId: undefined,
      })
    } catch (error) {
      this.updateSystemNode(nodeId, {
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
    if ((this.snapshot.saving && options.workflowRunId === undefined) || this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project operation before running a vd-node.')
    }
    const project = this.requireProject()
    const projectGeneration = this.projectGeneration
    const sourceGraph = options.graph ?? project.graph
    const storedNode = sourceGraph.nodes.find(candidate => candidate.id === nodeId)
    if (storedNode === undefined) throw new Error(`Node ${nodeId} was not found`)
    const effectiveData = withDefaultRegisteredImageWorkflow(
      storedNode.data,
      this.snapshot.providers,
      this.snapshot.workflows,
    )
    const node = effectiveData === storedNode.data ? storedNode : { ...storedNode, data: effectiveData }
    const executionGraph = node === storedNode
      ? sourceGraph
      : {
          ...sourceGraph,
          nodes: sourceGraph.nodes.map(candidate => candidate.id === nodeId ? node : candidate),
        }
    if (node.data.frozen === true) {
      throw new Error(`${node.data.title} is frozen. Unfreeze it before running the node directly.`)
    }
    if (signalAborted(options.signal)) throw new Error('vd-run was cancelled.')
    const clientRunId = crypto.randomUUID()
    let request: Record<string, unknown>
    try {
      if (node.data.kind === 'preview' || node.data.kind === 'save') {
        throw new Error(`${node.data.title} is a local output sink and does not run a remote job.`)
      }
      const inputEdges = executionGraph.edges.filter(edge => edge.target === nodeId
        && !isTriggerNodeKind(executionGraph.nodes.find(candidate => candidate.id === edge.source)?.data.kind ?? 'load-text'))
      validateNodeInputPorts(executionGraph, this.snapshot.nodeDefinitions, nodeId)
      const mappedInputs = inputEdges.map(edge => {
        const candidate = executionGraph.nodes.find(row => row.id === edge.source)
        if (candidate === undefined) throw new Error(`Connection source ${edge.source} was not found.`)
        const ports = resolveEdgePorts(executionGraph, this.snapshot.nodeDefinitions, edge)
        const outputTypes = inferredNodeOutputTypes(candidate)
        const mediaType = ports.targetTypes.length === 1 && ports.targetTypes[0] === 'mask'
          ? 'mask'
          : candidate.data.asset?.kind ?? candidate.data.mediaKind ?? outputTypes.find(type => ports.targetTypes.includes(type))
        const asset = candidate.data.assets?.find(value => ports.sourceTypes.includes(value.kind)) ?? candidate.data.asset
        return {
          nodeId: candidate.id,
          kind: candidate.data.kind,
          mediaType,
          sourcePortId: ports.sourcePortId,
          targetPortId: ports.targetPortId,
          text: candidate.data.text,
          prompt: candidate.data.prompt,
          assetId: asset?.id,
          assetName: asset?.name,
          maskAssetId: candidate.data.maskAsset?.id,
          trim: candidate.data.trim,
          transform: candidate.data.transform,
          role: edge?.data?.role ?? candidate.data.referenceRole ?? 'visual',
          includeAudio: edge?.data?.includeAudio ?? candidate.data.includeAudio ?? false,
        }
      })
      const mediaInputs = [
        ...mappedInputs.filter(input => !isFieldInputPort(input.targetPortId)),
        ...mappedInputs.filter(input => isFieldInputPort(input.targetPortId)),
      ]
      const definition = nodeDefinition(node.data, this.snapshot.nodeDefinitions)
      const resolvedParameters = resolveParameterInputs(node.data, definition, mediaInputs)
      if (node.data.kind === 'prompt-enhancer'
        && (typeof resolvedParameters.prompt !== 'string' || resolvedParameters.prompt.trim() === '')) {
        throw new Error('Enter a prompt before running this node.')
      }
      const fieldInputModes = activeFieldInputModes(node.data, definition)
      const assetIds = [...new Set(mediaInputs.flatMap(candidate => [candidate.assetId, candidate.maskAssetId]
        .filter((value): value is string => value !== undefined)))]
      const context = JSON.stringify(mediaInputs.filter(input => !isFieldInputPort(input.targetPortId)))
      const selectedProvider = this.snapshot.providers.find(provider => provider.id === node.data.providerId)
      const selectedModel = selectedProvider?.kind === 'ollama'
        ? effectiveOllamaModel(selectedProvider.availableModels ?? [], selectedProvider.model, node.data.modelId)
        : selectedProvider?.kind === 'codex-plan'
          ? codexModelForNode(node.data, selectedProvider)
          : node.data.modelId ?? (node.data.modelFamily === 'minimax-h3' ? undefined : node.data.modelFamily)
      const selectedModelDetails = selectedProvider?.modelDetails?.find(details => details.id === selectedModel)
      if (node.data.contextLength !== undefined && selectedModelDetails?.contextLength !== undefined
        && node.data.contextLength > selectedModelDetails.contextLength) {
        throw new Error(`Context length cannot exceed ${String(selectedModelDetails.contextLength)} tokens for ${selectedModel}.`)
      }
      const submittedPrompt = node.data.kind === 'image-generation'
        && (selectedProvider?.kind === 'codex-plan' || node.data.providerId === 'codex-plan')
        ? `${node.data.imageMode === 'edit' ? '$Edit Image$' : '$Create Image$'}\n${String(resolvedParameters.prompt ?? '')}`
        : resolvedParameters.prompt
      const submittedSeed = node.data.seedControlAfterGenerate === 'randomize'
        ? undefined
        : options.seed ?? node.data.seed
      request = structuredClone({
        providerId: node.data.providerId,
        operation: node.data.kind,
        modelFamily: node.data.modelFamily,
        model: selectedModel,
        prompt: submittedPrompt,
        negativePrompt: resolvedParameters.negativePrompt,
        systemPrompt: node.data.kind === 'prompt-enhancer'
          ? (node.data.systemPrompt ?? DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT)
          : node.data.systemPrompt,
        contextLength: selectedProvider?.kind === 'ollama' ? node.data.contextLength : undefined,
        thinking: selectedProvider?.kind === 'ollama' && ollamaModelSupports(selectedProvider.modelDetails, selectedModel, 'thinking')
          ? node.data.thinking
          : undefined,
        context,
        assetIds,
        workflow: node.data.workflow,
        bindings: (node.data.bindings ?? []).map((binding) => {
          if (binding.assetId !== undefined) return binding
          const mediaIndex = binding.portId === undefined
            ? (binding.mediaIndex ?? 0)
            : mediaInputs
                .map((input, index) => ({ input, index }))
                .filter(candidate => candidate.input.targetPortId === binding.portId)
                .filter(candidate => binding.referenceKind === undefined || candidate.input.mediaType === binding.referenceKind)[binding.portIndex ?? 0]?.index
          const media = mediaIndex === undefined ? undefined : mediaInputs[mediaIndex]
          if (binding.from === 'asset' && media?.assetId !== undefined) return { ...binding, mediaIndex, assetId: media.assetId }
          if (binding.from === 'maskAsset' && media?.maskAssetId !== undefined) return { ...binding, mediaIndex, assetId: media.maskAssetId }
          return binding
        }),
        workflowId: node.data.workflowId,
        workflowValues: resolvedParameters.workflowValues,
        videoMode: node.data.videoMode,
        fieldInputModes,
        seed: submittedSeed,
        width: node.data.width,
        height: node.data.height,
        duration: node.data.duration,
        fps: node.data.fps,
        variant: node.data.variant,
        steps: node.data.steps,
        scheduler: node.data.scheduler,
        mediaInputs,
        workflowRunId: options.workflowRunId,
        workflowRunMode: options.workflowRunMode,
        batchIndex: options.batchIndex,
        batchSize: options.batchSize,
      })
    } catch (error) {
      this.updateSystemNode(nodeId, {
        status: 'failed',
        phase: 'validation-failed',
        progress: 0,
        error: errorMessage(error),
        jobId: undefined,
      })
      throw error
    }
    const activeRun: ActiveNodeRun = {
      projectId: project.id,
      projectGeneration,
      clientRunId,
      seedStateAtSubmission: {
        seed: node.data.seed,
        control: node.data.seedControlAfterGenerate,
      },
      workflowRunId: options.workflowRunId,
      completion: options.awaitCompletion === true ? activeRunCompletion() : undefined,
    }
    this.activeRuns.get(nodeId)?.completion?.reject(new Error(`${node.data.title} was superseded by a newer run.`))
    this.activeRuns.set(nodeId, activeRun)
    this.updateSystemNode(nodeId, { status: 'queued', phase: 'submitting', progress: 0, error: undefined, jobId: undefined })
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
      this.updateSystemNode(nodeId, { jobId: job.id, status: 'queued', phase: job.phase })
      this.scheduleJobPoll(job.id, nodeId, 0, activeRun)
      if (signalAborted(options.signal)) await this.cancelJob(job.id)
    } catch (error) {
      // A failed Cancel RPC does not undo a successful jobs/start. Preserve the
      // poller so the submitted job can still be observed and cancelled again.
      if (activeRun.jobId !== undefined && (error as RemoteFailure).code === 'video-director/cancel-request-failed') throw error
      if (this.isActiveRun(nodeId, activeRun)) {
        this.activeRuns.delete(nodeId)
        this.updateSystemNode(nodeId, {
          status: 'failed',
          phase: 'submission-failed',
          progress: 0,
          error: errorMessage(error),
        })
      }
      throw error
    }
    return activeRun
  }

  async cancelJob(jobId: string): Promise<void> {
    const project = this.requireProject()
    try {
      const { job } = await this.rpc<{ job: DirectorJob }>('jobs/cancel', { projectId: project.id, jobId })
      this.updateVisibleJob(job)
    } catch (cause) {
      throw Object.assign(new Error(`Could not request cancellation for job ${jobId}: ${errorMessage(cause)}`), {
        code: 'video-director/cancel-request-failed',
      })
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    const project = this.requireProject()
    await this.rpc<{ job: DirectorJob }>('jobs/delete', { projectId: project.id, jobId })
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
    const workflowRuns = this.snapshot.workflowRuns.filter(run => (
      run.status === 'running' || jobs.some(job => job.workflowRunId === run.id)
    ))
    this.updateProject({ ...project, graph, jobs, status }, 'system')
    this.patch({ workflowRuns })
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

    const id = crypto.randomUUID()
    const controller = new AbortController()
    this.vdRunControllers.set(id, controller)
    const startedAt = new Date().toISOString()
    const summary: VdRun = {
      id,
      projectId: project.id,
      mode: options.mode,
      batchSize,
      nodeIds: plan.nodeIds,
      completedJobs: 0,
      totalJobs: plan.nodeIds.length * batchSize,
      status: 'queued',
      startedAt,
    }
    this.storeVdRun(summary)
    const submitted = { name: executionSource.name, graph: executionSource.graph, settings: executionSource.settings }
    this.vdRunSnapshots.set(id, structuredClone(submitted))
    const previous = this.vdRunTail
    let release!: () => void
    const finished = new Promise<void>(resolve => { release = resolve })
    this.vdRunTail = previous.catch(() => {}).then(() => finished)
    const updateRun = async (patch: Partial<VdRun>): Promise<void> => {
      Object.assign(summary, patch)
      this.patchVdRun(id, patch)
      await this.persistVdRun(summary)
    }

    let completedJobs = 0
    let remoteCancellationFailed = false
    try {
      await this.persistVdRun(summary, submitted)
      await waitForRunTurn(previous, controller.signal)
      // A direct node job may have been started before this workflow was queued.
      while (plan.nodeIds.some(nodeId => this.activeRuns.has(nodeId))) {
        await waitForRunTurn(new Promise<void>(resolve => setTimeout(resolve, 100)), controller.signal)
      }
      controller.signal.throwIfAborted()
      await updateRun({ status: 'running' })
      for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
        if (controller.signal.aborted) throw new Error('vd-run was cancelled.')
        let executionProject = { ...executionSource, graph: structuredClone(executionSource.graph) }
        for (const stage of plan.stages) {
          if (controller.signal.aborted) throw new Error('vd-run was cancelled.')
          while (stage.some(nodeId => this.activeRuns.has(nodeId))) {
            await waitForRunTurn(new Promise<void>(resolve => setTimeout(resolve, 100)), controller.signal)
          }
          const outcomes = await Promise.allSettled(stage.map(async nodeId => {
            const node = executionProject.graph.nodes.find(candidate => candidate.id === nodeId)
            if (node === undefined) throw new Error(`Node ${nodeId} disappeared from the run snapshot.`)
            if (isTriggerNodeKind(node.data.kind)) {
              await this.submitTriggerRun(nodeId, {
                graph: executionProject.graph,
                workflowRunId: id,
                workflowRunMode: options.mode,
                batchIndex,
                batchSize,
                signal: controller.signal,
              })
              return { nodeId }
            }
            const configuredSeed = node.data.seed
            const seed = Number.isSafeInteger(configuredSeed)
              ? ((configuredSeed! + batchIndex) % 2_147_483_648)
              : undefined
            const activeRun = await this.submitNodeRun(nodeId, {
              graph: executionProject.graph,
              sourceRevision: executionSource.revision,
              workflowRunId: id,
              workflowRunMode: options.mode,
              batchIndex,
              batchSize,
              seed,
              awaitCompletion: true,
              signal: controller.signal,
            })
            const job = await activeRun.completion!.promise
            return { nodeId, job }
          }))

          const failures: string[] = []
          for (const outcome of outcomes) {
            completedJobs += 1
            if (outcome.status === 'rejected') {
              if (outcome.reason?.code === 'video-director/cancel-request-failed') remoteCancellationFailed = true
              failures.push(errorMessage(outcome.reason))
              continue
            }
            const { nodeId, job } = outcome.value
            if (job === undefined) continue
            if (job.errorCode === 'video-director/remote-cancel-failed') remoteCancellationFailed = true
            if (job.status !== 'completed' || job.result === undefined) {
              failures.push(job.error ?? `${job.status}: ${job.phase}`)
              continue
            }
            executionProject = this.projectWithJobResult(executionProject, nodeId, job.result, false)
          }
          await updateRun({ completedJobs })
          if (failures.length > 0) throw new Error(failures.join(' '))
        }
      }
      controller.signal.throwIfAborted()
      await updateRun({
        completedJobs,
        status: 'completed',
        completedAt: new Date().toISOString(),
      })
      return id
    } catch (error) {
      const cancelled = controller.signal.aborted && !remoteCancellationFailed
      const message = cancelled ? 'vd-run was cancelled.' : errorMessage(error)
      await updateRun({
        completedJobs,
        status: cancelled ? 'cancelled' : 'failed',
        completedAt: new Date().toISOString(),
        error: message,
      })
      if (!cancelled) this.patch({ error: message })
      throw error
    } finally {
      this.vdRunControllers.delete(id)
      this.vdRunWrites.delete(id)
      this.vdRunSnapshots.delete(id)
      release()
    }
  }

  async cancelVdRun(workflowRunId: string): Promise<void> {
    this.vdRunControllers.get(workflowRunId)?.abort('Cancelled by the Video Director user')
    const project = this.requireProject()
    const jobIds = new Set([...this.activeRuns.values()]
      .filter(run => run.workflowRunId === workflowRunId && run.jobId !== undefined)
      .map(run => run.jobId!))
    // Restored jobs may no longer have a node on the current canvas.
    for (const job of project.jobs) {
      if (job.workflowRunId === workflowRunId && (job.status === 'running' || job.status === 'queued')) jobIds.add(job.id)
    }
    const outcomes = await Promise.allSettled([...jobIds].map(jobId => this.cancelJob(jobId)))
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [errorMessage(outcome.reason)] : [])
    if (errors.length > 0) throw new Error(`Could not request cancellation for every job: ${errors.join(' ')}`)
    const saved = this.snapshot.workflowRuns.find(run => run.id === workflowRunId)
    if (saved !== undefined && !this.vdRunControllers.has(workflowRunId)
      && (saved.status === 'queued' || saved.status === 'running')) {
      const stopped = await Promise.all([...jobIds].map(async jobId => {
        while (true) {
          const { job } = await this.rpc<{ job: DirectorJob }>('jobs/get', { projectId: project.id, jobId })
          this.updateVisibleJob(job)
          if (job.status !== 'running' && job.status !== 'queued') return job
          await new Promise(resolve => setTimeout(resolve, JOB_POLL_MS))
        }
      }))
      const failure = stopped.find(job => job.errorCode === 'video-director/remote-cancel-failed')
      const cancelled: VdRun = { ...saved, status: failure ? 'failed' : 'cancelled',
        error: failure?.error, completedAt: new Date().toISOString() }
      this.patchVdRun(workflowRunId, cancelled)
      await this.persistVdRun(cancelled)
      if (failure) throw new Error(failure.error ?? 'Remote cancellation failed.')
    }
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
  ): Promise<void> {
    if (this.snapshot.phase === 'loading') {
      throw new Error('Wait for the current project transition to finish before importing a project.')
    }
    if (this.snapshot.saving) {
      throw new Error('Wait for the current save to finish before importing a project.')
    }
    if (this.snapshot.dirty) {
      throw new Error('Save the current project changes before importing or duplicating a project.')
    }
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
      const created = (await this.rpc<{ project: VideoProject }>('projects/create', { name, sessionId })).project
      createdProjectId = created.id

      const restoredAssets = new Map<string, AssetRef>()
      for (const asset of archive.assets) {
        const restored = (await this.rpc<{ asset: AssetRef }>('assets/put', {
          projectId: created.id,
          kind: asset.kind,
          name: asset.name,
          mimeType: asset.mimeType,
          dataBase64: asset.dataBase64,
        })).asset
        restoredAssets.set(asset.sourceId, restored)
      }
      const graph = rewriteArchiveAssets(archive.project.graph, restoredAssets) as DirectorGraph
      const saved = (await this.rpc<{ project: VideoProject }>('projects/save', {
        projectId: created.id,
        expectedRevision: created.revision,
        project: {
          ...created,
          name,
          status: 'draft',
          graph,
          settings: structuredClone(archive.project.settings),
          jobs: [],
        },
      })).project
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
      for (const timer of this.jobTimers.values()) clearTimeout(timer)
      this.jobTimers.clear()
      this.stopVdRunSchedulers()
      this.activeRuns.clear()
      this.baseProject = structuredClone(persisted)
      this.savedState = this.historyState(project)
      this.openedProject = { id: project.id, state: this.historyState(project) }
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      this.ctx.sessions.open(project.sessionId)
      createdProjectId = undefined
      this.patch({
        project,
        projects,
        dirty: false,
        saving: false,
        conflict: false,
        phase: 'ready',
        error: null,
        workflowRuns: [],
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
      const project = normalizeLoadedPromptValidation(this.restoreCompletedJobResults(persistedProject))
      this.baseProject = structuredClone(persistedProject)
      this.savedState = this.historyState(project)
      this.openedProject = { id: project.id, state: this.historyState(project) }
      this.resetHistory()
      this.editVersion = 0
      this.projectGeneration += 1
      for (const timer of this.jobTimers.values()) clearTimeout(timer)
      this.jobTimers.clear()
      this.stopVdRunSchedulers()
      this.activeRuns.clear()
      if (sessionReady && (openSession || this.ctx.sessions.list.getSnapshot().current !== project.sessionId)) {
        this.ctx.sessions.open(project.sessionId)
      }
      this.patch({ project, phase: 'ready', dirty: false, saving: false, conflict: false, error: sessionError, workflowRuns: [] })
      for (const job of project.jobs) {
        if ((job.status !== 'queued' && job.status !== 'running') || !project.graph.nodes.some(node => node.id === job.nodeId)) continue
        const activeRun: ActiveNodeRun = {
          projectId: project.id,
          projectGeneration: this.projectGeneration,
          clientRunId: job.clientRunId ?? job.id,
          jobId: job.id,
          workflowRunId: job.workflowRunId,
        }
        this.activeRuns.set(job.nodeId, activeRun)
        this.updateSystemNode(job.nodeId, {
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
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
    this.savePromise = this.performSave(local, editVersion).finally(() => {
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
    if (this.disposed || this.snapshot.project?.id !== activeRun.projectId || this.projectGeneration !== activeRun.projectGeneration) return false
    if (this.activeRuns.get(nodeId) !== activeRun) return false
    if (jobId !== undefined && activeRun.jobId !== jobId) return false
    return activeRun.workflowRunId !== undefined || this.snapshot.project.graph.nodes.some(node => node.id === nodeId)
  }

  private scheduleJobPoll(jobId: string, nodeId: string, delay = JOB_POLL_MS, activeRun = this.activeRuns.get(nodeId)): void {
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
    const project = this.snapshot.project
    if (project === null || !this.isActiveRun(nodeId, activeRun, jobId)) return
    try {
      const { job } = await this.rpc<{ job: DirectorJob }>('jobs/get', { projectId: project.id, jobId })
      if (!this.isActiveRun(nodeId, activeRun, jobId)) return
      activeRun.consecutivePollFailures = 0
      this.updateVisibleJob(job)
      if (job.status === 'queued' || job.status === 'running') {
        this.updateSystemNode(nodeId, { status: job.status, phase: job.phase, progress: job.progress, error: undefined, jobId })
        this.scheduleJobPoll(jobId, nodeId, JOB_POLL_MS, activeRun)
        return
      }
      if (job.status === 'completed' && job.result !== undefined) {
        this.applyJobResult(nodeId, job.result, activeRun)
      } else {
        this.updateSystemNode(nodeId, { status: 'failed', phase: job.phase, error: job.error ?? job.status, progress: job.progress })
      }
      if (this.activeRuns.get(nodeId) === activeRun) this.activeRuns.delete(nodeId)
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
        this.updateSystemNode(nodeId, {
          status: currentNode?.data.status === 'queued' ? 'queued' : 'running',
          phase: 'reconnecting',
          error: undefined,
          jobId,
        })
        this.scheduleJobPoll(jobId, nodeId, jobPollRetryDelay(failures), activeRun)
        return
      }
      this.updateSystemNode(nodeId, { status: 'failed', error: errorMessage(error) })
      this.activeRuns.delete(nodeId)
      activeRun.completion?.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private applyJobResult(nodeId: string, result: VdNodeResult, activeRun?: ActiveNodeRun): void {
    if (activeRun !== undefined && !this.isActiveRun(nodeId, activeRun, activeRun.jobId)) return
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
      if (latestJobIds.get(job.nodeId) !== job.id || job.status !== 'completed' || job.result === undefined) return current
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
    const controlledSeed = completedSeed === undefined || !seedStateUnchanged
      ? undefined
      : seedControl === 'randomize' && submittedSeedState !== undefined
        ? completedSeed
        : seedControl === 'increment'
          ? completedSeed >= Number.MAX_SAFE_INTEGER ? 0 : completedSeed + 1
          : seedControl === 'decrement'
            ? completedSeed === 0 ? Number.MAX_SAFE_INTEGER : completedSeed - 1
            : undefined
    const sourcePatch: Partial<DirectorNodeData> = {
      status: 'completed', progress: 1, phase: 'completed', result, ...payload,
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
      node.data.kind === 'preview'
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
    })
  }

  private isDirty(project: VideoProject): boolean {
    return this.savedState !== null && !sameJson(this.historyState(project), this.savedState)
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
      'status', 'phase', 'progress', 'jobId', 'error', 'result', 'derivedFrom', 'outputSeed',
    ]
    const currentNodes = new Map(current.graph.nodes.map(node => [node.id, node]))
    const nodes = state.graph.nodes.map(node => {
      const live = currentNodes.get(node.id)
      if (live === undefined) return node
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
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
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
