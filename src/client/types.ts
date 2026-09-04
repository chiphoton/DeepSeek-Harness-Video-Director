import type { Edge, Node, Viewport } from '@xyflow/react'
import type { ComponentType } from 'react'

export type MediaKind = 'text' | 'image' | 'audio' | 'video' | 'sketch' | 'mask' | 'flow'
export type WorkflowKind = 'image-generation' | 'image-edit' | 'video-generation' | 'audio-generation'
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

export interface WorkflowBinding {
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

export interface WorkflowParameter {
  id: string
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

export interface WorkflowDescriptor {
  id: string
  name: string
  kind: WorkflowKind
  description: string
  builtIn: boolean
  modelFamily?: string
  nodeType?: string
  nodeVersion?: string
  nodeDigest?: string
  defaults: Partial<DirectorNodeData>
  parameters: WorkflowParameter[]
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
  workflow?: Record<string, unknown>
  bindings?: WorkflowBinding[]
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

export type DirectorNode = Node<DirectorNodeData, 'director'>
export type DirectorEdge = Edge<{
  role?: string
  includeAudio?: boolean
  sourcePortId?: string
  targetPortId?: string
}>

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
}

export interface VideoProject extends Omit<ProjectSummary, 'nodeCount'> {
  schemaVersion: 1
  graph: DirectorGraph
  settings: Record<string, unknown>
  jobs: DirectorJob[]
}

export interface ProviderDescriptor {
  id: string
  label: string
  kind: 'ollama' | 'openai-compatible' | 'codex-plan' | 'comfyui' | 'comfyui-mcp'
  baseUrl?: string
  model?: string
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

export interface NodePortDescriptor {
  id: string
  label: string
  types: MediaKind[]
  required?: boolean
  multiple?: boolean
  maxByType?: Partial<Record<MediaKind, number>>
}

export interface NodeFieldDescriptor {
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

export interface NodeDefinitionDescriptor {
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
  workflowKind?: WorkflowKind
  workflowId?: string
  modelFamily?: string
  inputs: NodePortDescriptor[]
  outputs: NodePortDescriptor[]
  fields: NodeFieldDescriptor[]
  parameterInputs?: Array<{ id: string; label: string; type: 'text' }>
}

export interface DirectorJob {
  id: string
  clientRunId?: string
  workflowRunId?: string
  workflowRunMode?: WorkflowRunMode
  batchIndex?: number
  batchSize?: number
  runSequence?: number
  sourceRevision?: number
  nodeDigest?: string
  projectId: string
  nodeId: string
  operation: string
  providerId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'orphaned'
  phase: string
  progress: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  promptId?: string
  seed?: number
  compiledWorkflowHash?: string
  error?: string
  errorCode?: string
  result?: WorkflowResult
}

export type WorkflowRunMode = 'all' | 'selected' | 'from-selection' | 'dependencies'

export interface DirectorWorkflowRun {
  id: string
  projectId: string
  mode: WorkflowRunMode
  batchSize: number
  nodeIds: string[]
  completedJobs: number
  totalJobs: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  error?: string
}

export type WorkflowResult =
  | { kind: 'text'; text: string; providerId: string }
  | { kind: 'assets'; assets: AssetRef[]; providerId: string; seed?: number; promptId?: string; frameCount?: number; actualDuration?: number; experimentalDuration?: boolean }
  | { kind: 'mcp-result'; result: unknown; providerId: string; seed?: number; promptId?: string; frameCount?: number; actualDuration?: number; experimentalDuration?: boolean }

export interface DirectorSnapshot {
  open: boolean
  phase: 'idle' | 'loading' | 'ready' | 'error'
  projects: ProjectSummary[]
  project: VideoProject | null
  providers: ProviderDescriptor[]
  workflows: WorkflowDescriptor[]
  nodeDefinitions: NodeDefinitionDescriptor[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  saving: boolean
  conflict: boolean
  error: string | null
  providerChecks: Record<string, { state: 'checking' | 'ok' | 'error'; latencyMs?: number; message?: string; transport?: 'rest' | 'mcp' }>
  workflowRuns: DirectorWorkflowRun[]
}

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
