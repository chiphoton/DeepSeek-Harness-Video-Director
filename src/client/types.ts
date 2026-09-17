import type { Edge, Node, Viewport } from '@xyflow/react'
import type { ComponentType } from 'react'

// Source vocabulary: ComfyWorkflow* belongs to the ComfyUI execution graph;
// DirectorNode/DirectorGraph and Vd* belong to Video Director. See docs/TERMINOLOGY.md.
// Serialized field names remain stable even where their historical wording overlaps.
export type MediaKind = 'text' | 'image' | 'audio' | 'video' | 'sketch' | 'mask' | 'flow'
export type ComfyWorkflowKind = 'image-generation' | 'image-edit' | 'video-generation' | 'audio-generation'
export type FieldInputMode = { mode: 'input' }
export type VramTriggerAction = 'skip' | 'ollama-eject' | 'comfyui-clear'
export type DirectorNodeKind =
  | 'load-text'
  | 'load-image'
  | 'load-audio'
  | 'load-video'
  | 'load-sketch'
  | 'prompt-enhancer'
  | 'image-generation'
  | 'image-edit'
  | 'video-generation'
  | 'audio-generation'
  | 'vram-trigger'
  | 'ollama-eject'
  | 'comfyui-clear'
  | 'output-text'
  | 'output-image'
  | 'output-audio'
  | 'output-video'
  | 'preview'
  | 'save'

export interface AssetRef {
  id: string
  projectId: string
  kind: Exclude<MediaKind, 'text' | 'flow'>
  name: string
  mimeType: string
  size: number
  sha256: string
  createdAt: string
  url: string
}

export type SketchTool = 'brush' | 'rectangle' | 'circle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser'

export interface SketchPoint {
  x: number
  y: number
}

export interface SketchPathElement {
  id: string
  type: 'brush' | 'eraser'
  color: string
  width: number
  points: SketchPoint[]
}

export interface SketchShapeElement {
  id: string
  type: 'rectangle' | 'circle' | 'ellipse' | 'line' | 'arrow'
  color: string
  width: number
  start: SketchPoint
  end: SketchPoint
}

export interface SketchTextElement {
  id: string
  type: 'text'
  color: string
  fontSize: number
  point: SketchPoint
  text: string
}

export type SketchElement = SketchPathElement | SketchShapeElement | SketchTextElement

export interface SketchRasterBase {
  asset: AssetRef
  x: number
  y: number
  width: number
  height: number
}

export interface SketchDocument {
  version: 1
  width: number
  height: number
  background: string
  base?: SketchRasterBase
  elements: SketchElement[]
}

export interface ComfyWorkflowBinding {
  /** Target comfyui-node ID inside the API graph; never a canvas vd-node ID. */
  nodeId: string
  input: string
  from: 'prompt' | 'negativePrompt' | 'seed' | 'width' | 'height' | 'duration' | 'frames' | 'fps' | 'steps' | 'scheduler' | 'variant' | 'asset' | 'maskAsset' | 'trimStart' | 'trimEnd' | 'inputWidth' | 'inputHeight' | 'aspectRatio' | 'includeAudio' | 'referenceRole' | 'literal'
  assetId?: string
  mediaIndex?: number
  portId?: string
  portIndex?: number
  value?: unknown
  optional?: boolean
  omitNodeWhenMissing?: boolean
  frameRole?: 'first' | 'last'
  referenceKind?: 'image' | 'audio' | 'video'
  omitNodeIdsWhenMissing?: string[]
}

export interface ComfyWorkflowParameter {
  id: string
  /** Target comfyui-node ID inside the registered comfyui-workflow. */
  nodeId: string
  input: string
  label: string
  group: string
  type: 'text' | 'number' | 'boolean'
  default: string | number | boolean
  placement: 'primary' | 'advanced'
  control?: 'input' | 'textarea' | 'select' | 'slider' | 'checkbox'
  description?: string
  order?: number
  choices?: string[]
}

/** Redacted ComfyUI registry entry selected by a vd-node, not the canvas vd-workflow. */
export interface ComfyWorkflowDescriptor {
  id: string
  name: string
  kind: ComfyWorkflowKind
  description: string
  builtIn: boolean
  modelFamily?: string
  nodeType?: string
  nodeVersion?: string
  nodeDigest?: string
  defaults: Partial<DirectorNodeData>
  parameters: ComfyWorkflowParameter[]
  createdAt: string
  updatedAt: string
}

export interface DirectorNodeData extends Record<string, unknown> {
  kind: DirectorNodeKind
  title: string
  mediaKind?: MediaKind
  text?: string
  prompt?: string
  negativePrompt?: string
  providerId?: string
  modelId?: string
  imageMode?: 'generate' | 'edit'
  videoMode?: 'text-to-video' | 'first-frame-locked' | 'last-frame-locked' | 'first-to-last-frame'
  frozen?: boolean
  modelFamily?: string
  systemPrompt?: string
  contextLength?: number
  thinking?: boolean
  asset?: AssetRef
  sketchDocument?: SketchDocument
  assets?: AssetRef[]
  maskAsset?: AssetRef
  trim?: { start: number; end?: number }
  transform?: { width?: number; height?: number; aspectRatio?: string }
  /** Legacy inline comfyui-workflow; the containing vd-workflow lives at project.graph. */
  workflow?: Record<string, unknown>
  bindings?: ComfyWorkflowBinding[]
  /** ComfyUI registry entry ID; unrelated to a vd-run's workflowRunId. */
  workflowId?: string
  workflowValues?: Record<string, string | number | boolean>
  fieldInputModes?: Record<string, FieldInputMode>
  seed?: number
  seedControlAfterGenerate?: 'fixed' | 'increment' | 'decrement' | 'randomize'
  outputSeed?: number
  duration?: number
  width?: number
  height?: number
  fps?: number
  variant?: 'standard' | 'turbo'
  steps?: number
  scheduler?: 'simple'
  status?: 'idle' | 'queued' | 'running' | 'completed' | 'failed'
  phase?: string
  progress?: number
  jobId?: string
  /** Wall-clock execution times for the latest node run, distinct from media duration. */
  runStartedAt?: string
  runCompletedAt?: string
  error?: string
  result?: unknown
  derivedFrom?: string
  /** Keep a cleared Preview empty until a new upstream result or connection arrives. */
  previewCleared?: boolean
  includeAudio?: boolean
  referenceRole?: 'visual' | 'motion' | 'camera' | 'voice' | 'music' | 'sound'
  nodeType?: string
  nodeVersion?: string
  nodeDigest?: string
  outputName?: string
  vramAction?: VramTriggerAction
  vramReleaseWaitSeconds?: number
  /** Legacy persisted field migrated to vramReleaseWaitSeconds on load. */
  vramTimeoutSeconds?: number
  vramActionInitialized?: boolean
}

/** Canvas vd-node. The renderer key 'director' is part of the persisted project format. */
export type DirectorNode = Node<DirectorNodeData, 'director'>
export type DirectorEdge = Edge<{
  role?: string
  includeAudio?: boolean
  sourcePortId?: string
  targetPortId?: string
}>

/** The vd-workflow's canvas graph, including its viewport. */
export interface DirectorGraph {
  nodes: DirectorNode[]
  edges: DirectorEdge[]
  viewport: Viewport
}

export interface ProjectSummary {
  id: string
  name: string
  sessionId: string
  status: 'draft' | 'running' | 'ready' | 'error'
  revision: number
  nodeCount: number
  createdAt: string
  updatedAt: string
  unsaved?: boolean
  hasSavedVersion?: boolean
}

export type ProjectDraft = Pick<VideoProject, 'name' | 'graph' | 'settings'>

export interface VideoProject extends Omit<ProjectSummary, 'nodeCount'> {
  schemaVersion: 1
  graph: DirectorGraph
  settings: Record<string, unknown>
  jobs: DirectorJob[]
  draft?: ProjectDraft
}

/** Gallery payload omits canvas layout, provider configuration, and job requests. */
export interface GalleryProject {
  id: string
  name: string
  graph: { nodes: Array<{
    id: string
    data: Pick<DirectorNodeData, 'kind' | 'title' | 'asset' | 'assets' | 'text' | 'maskAsset' | 'runCompletedAt'> & {
      sketchDocument?: Pick<SketchDocument, 'base'>
    }
  }> }
  jobs: Array<Pick<DirectorJob, 'nodeId' | 'operation' | 'createdAt' | 'completedAt' | 'result'>>
}

export interface ProviderDescriptor {
  id: string
  label: string
  kind: 'ollama' | 'openai-compatible' | 'codex-plan' | 'comfyui' | 'comfyui-mcp'
  baseUrl?: string
  model?: string
  fastMode?: boolean
  codexModels?: Array<{
    id: string
    displayName: string
    defaultReasoningEffort: string
    inputModalities: string[]
    fastServiceTier: string | null
    isDefault: boolean
  }>
  codexCatalog?: { source: 'live' | 'cache' | 'unavailable'; fetchedAt: number | null; error: string | null }
  imageModel?: string
  mcpTool?: string
  requiresApiKey: boolean
  apiKeySet: boolean
  capabilities: string[]
  configured: boolean
  minimaxH3Unlocked: boolean
  availableModels?: string[]
  loadedModels?: string[]
  modelDetails?: Array<{
    id: string
    capabilities: string[]
    contextLength?: number
  }>
  modelDiscovery?: { state: 'loading' | 'ready' | 'error'; message?: string }
  workflowModels?: Array<{
    workflowId: string
    parameterId: string
    models: string[]
  }>
}

export interface VdPortDescriptor {
  id: string
  label: string
  types: MediaKind[]
  required?: boolean
  multiple?: boolean
  maxByType?: Partial<Record<MediaKind, number>>
}

export interface VdFieldDescriptor {
  id: string
  label: string
  type: 'text' | 'number' | 'boolean'
  default: string | number | boolean
  placement: 'primary' | 'advanced'
  control?: 'input' | 'textarea' | 'select' | 'slider' | 'checkbox'
  description?: string
  order?: number
  choices?: string[]
  min?: number
  max?: number
  step?: number
  integer?: boolean
  minLength?: number
  maxLength?: number
}

/** Reusable vd-node definition; instance identity and connections live in DirectorNode. */
export interface VdNodeDefinitionDescriptor {
  type: string
  version: string
  digest: string
  title: string
  description: string
  category: 'input' | 'text' | 'image' | 'audio' | 'video' | 'utility' | 'output'
  builtIn: boolean
  behavior: 'workflow' | 'preview' | 'save' | 'trigger'
  execution?: 'comfyui.workflow' | 'system.trigger'
  triggerAction?: 'vram-trigger' | 'ollama-eject' | 'comfyui-clear'
  operation?: 'image-generation' | 'image-edit' | 'video-generation' | 'audio-generation'
  workflowKind?: ComfyWorkflowKind
  workflowId?: string
  modelFamily?: string
  inputs: VdPortDescriptor[]
  outputs: VdPortDescriptor[]
  fields: VdFieldDescriptor[]
  parameterInputs?: Array<{ id: string; label: string; type: 'text' }>
}

export interface DirectorJob {
  id: string
  /** Correlates one vd-node request with its result, not an entire vd-run. */
  clientRunId?: string
  /** Persisted name for the grouped vd-run ID. */
  workflowRunId?: string
  workflowRunMode?: VdRunMode
  batchIndex?: number
  batchSize?: number
  runSequence?: number
  sourceRevision?: number
  nodeDigest?: string
  projectId: string
  /** Canvas vd-node ID; workflow bindings use the same spelling for comfyui-node IDs. */
  nodeId: string
  operation: string
  providerId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'orphaned'
  phase: string
  progress: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  /** Recorded when the Host starts execution, after its job queue wait. */
  startedAt?: string
  /** ComfyUI submission ID (provider prompt_id), not generation prompt text. */
  promptId?: string
  seed?: number
  compiledWorkflowHash?: string
  error?: string
  errorCode?: string
  result?: VdNodeResult
}

export type VdRunMode = 'all' | 'selected' | 'from-selection' | 'dependencies'

/** One orchestration run of a vd-workflow scope, potentially containing several vd-jobs. */
export interface VdRun {
  id: string
  projectId: string
  mode: VdRunMode
  batchSize: number
  nodeIds: string[]
  completedJobs: number
  totalJobs: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  error?: string
}

/** Result of a vd-node execution through any provider, not specifically ComfyUI. */
export type VdNodeResult =
  | { kind: 'text'; text: string; providerId: string }
  | { kind: 'assets'; assets: AssetRef[]; providerId: string; seed?: number; promptId?: string; frameCount?: number; actualDuration?: number; experimentalDuration?: boolean }
  | { kind: 'mcp-result'; result: unknown; providerId: string; seed?: number; promptId?: string; frameCount?: number; actualDuration?: number; experimentalDuration?: boolean }

export interface DirectorSnapshot {
  open: boolean
  phase: 'idle' | 'loading' | 'ready' | 'error'
  projects: ProjectSummary[]
  examples: Array<{ id: string; name: string }>
  examplesLoading: boolean
  examplesError: string | null
  project: VideoProject | null
  providers: ProviderDescriptor[]
  /** ComfyUI registry entries; the canvas vd-workflow is project.graph. */
  workflows: ComfyWorkflowDescriptor[]
  nodeDefinitions: VdNodeDefinitionDescriptor[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /** Changes when the canvas must reset its viewport, selection, and open tools. */
  canvasResetVersion: number
  saving: boolean
  conflict: boolean
  error: string | null
  providerChecks: Record<string, { state: 'checking' | 'ok' | 'error'; latencyMs?: number; message?: string; transport?: 'rest' | 'mcp' }>
  /** Existing snapshot key for grouped vd-runs. */
  workflowRuns: VdRun[]
}

// Compatibility aliases for existing type consumers. New code uses the qualified names.
/** @deprecated Use ComfyWorkflowKind. */
export type WorkflowKind = ComfyWorkflowKind
/** @deprecated Use ComfyWorkflowBinding. */
export type WorkflowBinding = ComfyWorkflowBinding
/** @deprecated Use ComfyWorkflowParameter. */
export type WorkflowParameter = ComfyWorkflowParameter
/** @deprecated Use ComfyWorkflowDescriptor. */
export type WorkflowDescriptor = ComfyWorkflowDescriptor
/** @deprecated Use VdNodeDefinitionDescriptor. */
export type NodeDefinitionDescriptor = VdNodeDefinitionDescriptor
/** @deprecated Use VdPortDescriptor. */
export type NodePortDescriptor = VdPortDescriptor
/** @deprecated Use VdFieldDescriptor. */
export type NodeFieldDescriptor = VdFieldDescriptor
/** @deprecated Use VdRunMode. */
export type WorkflowRunMode = VdRunMode
/** @deprecated Use VdRun. */
export type DirectorWorkflowRun = VdRun
/** @deprecated Use VdNodeResult. */
export type WorkflowResult = VdNodeResult

export interface ObservableSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export type RuntimeHook<T> = <S>(selector: (snapshot: T) => S) => S

export interface RemoteFailure {
  code: string
  message: string
  details: Record<string, unknown>
}

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

export interface SessionBinding {
  session: ObservableSource<Record<string, unknown>> & {
    beginSubmission(input: {
      mode: 'queue' | 'steer'
      text: string
      images: Array<{ previewUrl: string; name?: string; width?: number; height?: number }>
      onRetire?: (retirement: { reason: 'observed'; attachments: unknown[] } | { reason: 'failed' }) => void
    }): { requestId: string; abandon(): void }
    prompt(content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
    >, mode: 'queue' | 'steer', signal?: AbortSignal, requestId?: string): Promise<RemoteResult<{ accepted: true }>>
    rename(title: string): Promise<RemoteResult<{ title: string; seq: number }>>
  }
  eventSource: ObservableSource<{
    entries: Array<{ type: string; event: Record<string, unknown> }>
  }>
}

export interface ChatModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ChatModelDirectoryState {
  current: ChatModelSelection | null
  routable: boolean | null
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      description?: string
      reasoning?: { defaultEffort?: string }
    }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

export interface ChatModelDirectory {
  store: ObservableSource<ChatModelDirectoryState>
  load(): Promise<ChatModelDirectoryState>
  select(selection: ChatModelSelection): Promise<void>
}

export interface ClientContext {
  effect(factory: () => void | (() => void | Promise<void>), label?: string): () => void
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  }
  slots: {
    register(options: Record<string, unknown>, component: ComponentType<any>): () => void
    inject(name: string, factory: () => void | (() => void)): () => void
  }
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RemoteResult<unknown>>
    }
  }
  sessions: {
    list: ObservableSource<{ current?: string; byId: Record<string, { id: string; title?: string }> }>
    create(options?: Record<string, unknown>): Promise<string>
    open(sessionId: string): void
    binding(sessionId: string): SessionBinding | undefined
  }
  modelDirectories: {
    directoryFor(sessionId: string): ChatModelDirectory
  }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  time?: number
}

export interface ChatSnapshot {
  sessionId: string | null
  messages: ChatMessage[]
  running: boolean
  sending: boolean
  error: string | null
}
