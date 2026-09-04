import type { DirectorController } from './controller'
import type {
  ChatModelDirectory,
  ChatModelDirectoryState,
  ChatModelSelection,
  ChatMessage,
  ChatSnapshot,
  ClientContext,
  ObservableSource,
  SessionBinding,
} from './types'

/** Delimiters make canvas context removable from the transcript projection. */
export const DIRECTOR_CONTEXT_START = '<dsh-video-director-context version="1">'
export const DIRECTOR_CONTEXT_END = '</dsh-video-director-context>'

export type ProjectChatMessageKind = 'user' | 'assistant' | 'tool-call' | 'tool-result'
export type ProjectChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error'

/** A compact transcript row derived only from the currently bound DSH Session. */
export interface ProjectChatMessage extends ChatMessage {
  kind: ProjectChatMessageKind
  status: ProjectChatMessageStatus
  callId?: string
  toolName?: string
}

/** Read model consumed by the Video Director's project-scoped chat panel. */
export interface ProjectChatSnapshot extends Omit<ChatSnapshot, 'messages'> {
  projectId: string | null
  messages: ProjectChatMessage[]
  models: ChatModelDirectoryState
}

type JsonRecord = Record<string, unknown>

const EMPTY_MODEL_DIRECTORY: ChatModelDirectoryState = {
  current: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

type ChatImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

function chatImageMediaType(value: string): ChatImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new Error(`Unsupported chat image type: ${value || 'unknown'}`)
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function serializeChatImage(file: File): Promise<{
  type: 'image'
  mediaType: ChatImageMediaType
  data: string
  name?: string
}> {
  return {
    type: 'image',
    mediaType: chatImageMediaType(file.type),
    data: bytesBase64(new Uint8Array(await file.arrayBuffer())),
    ...(file.name === '' ? {} : { name: file.name }),
  }
}

interface SessionEventRecord extends JsonRecord {
  type: string
  seq?: number
  time?: number
  data?: unknown
  surfaceOp?: unknown
}

interface SurfaceState {
  active: Set<number>
  replacements: Array<{ start: number; end: number }>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventRecord(entry: unknown): SessionEventRecord | undefined {
  if (!isRecord(entry) || !isRecord(entry.event)) return undefined
  const type = stringValue(entry.event.type)
  return type === undefined ? undefined : { ...entry.event, type }
}

function messageContent(message: unknown): unknown[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content
}

function blockText(block: unknown, includeReasoning = false): string[] {
  if (!isRecord(block)) return []
  switch (block.type) {
    case 'text': {
      const text = stringValue(block.text)
      return text === undefined ? [] : [text]
    }
    case 'reasoning': {
      const text = includeReasoning ? stringValue(block.text) : undefined
      return text === undefined ? [] : [text]
    }
    case 'image':
      return ['[Image]']
    case 'tool-result':
      return Array.isArray(block.content)
        ? block.content.flatMap(child => blockText(child, includeReasoning))
        : []
    default:
      return []
  }
}

function contentText(message: unknown, includeReasoning = false): string {
  return messageContent(message)
    .flatMap(block => blockText(block, includeReasoning))
    .join('\n')
    .trim()
}

function sourceOf(message: unknown): JsonRecord | undefined {
  return isRecord(message) && isRecord(message.source) ? message.source : undefined
}

function idOf(message: unknown, fallback: string): string {
  return isRecord(message) ? stringValue(message.id) ?? fallback : fallback
}

function messageAt(data: unknown): unknown {
  return isRecord(data) ? data.message : undefined
}

function eventStep(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const turn = numberValue(data.turn)
  const step = numberValue(data.step)
  return turn === undefined || step === undefined ? undefined : `${turn}:${step}`
}

function eventSeq(event: SessionEventRecord, fallback: number): number {
  return numberValue(event.seq) ?? fallback
}

function isSurfaceType(type: string): boolean {
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
}

/**
 * Fold DSH's append/replace surface operations before projecting rows. This
 * keeps compacted source messages from leaking back into the small sidebar.
 */
function surfaceState(events: readonly SessionEventRecord[]): SurfaceState {
  const surface: number[] = []
  const replacements: Array<{ start: number; end: number }> = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventRecord
    if (!isSurfaceType(event.type)) continue
    const seq = eventSeq(event, index)
    const op = event.surfaceOp
    if (!isRecord(op) || op.op !== 'replace') {
      surface.push(seq)
      continue
    }
    const start = numberValue(op.start)
    const end = numberValue(op.end)
    if (start === undefined || end === undefined) {
      surface.push(seq)
      continue
    }
    replacements.push({ start: Math.min(start, end), end: Math.max(start, end) })
    const first = surface.indexOf(start)
    const last = surface.indexOf(end)
    if (first < 0 || last < first) surface.push(seq)
    else surface.splice(first, last - first + 1, seq)
  }
  return { active: new Set(surface), replacements }
}

function isReplaced(seq: number, replacements: SurfaceState['replacements']): boolean {
  return replacements.some(range => seq >= range.start && seq <= range.end)
}

function prettyArguments(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function failureMessage(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (!isRecord(value)) return null
  const message = stringValue(value.message)
  if (message !== undefined) return message
  return value.error === value ? null : failureMessage(value.error)
}

function sessionError(snapshot: JsonRecord): string | null {
  return failureMessage(snapshot.openError)
    ?? failureMessage(snapshot.promptError)
    ?? failureMessage(snapshot.lastAgentError)
    ?? (snapshot.removed === true ? 'The bound DeepSeek session was removed.' : null)
}

function toolResultData(data: unknown): {
  message: unknown
  callId?: string
  isError: boolean
} {
  const message = messageAt(data)
  const source = sourceOf(message)
  const block = messageContent(message).find(candidate => isRecord(candidate) && candidate.type === 'tool-result')
  const callId = stringValue(source?.callId)
    ?? (isRecord(block) ? stringValue(block.toolCallId) : undefined)
  const isError = (isRecord(data) && data.error !== undefined)
    || (isRecord(block) && block.isError === true)
  return { message, callId, isError }
}

/** Remove the private graph block before displaying a submitted user message. */
export function stripDirectorContext(text: string): string {
  const marker = text.lastIndexOf(DIRECTOR_CONTEXT_START)
  if (marker < 0) return text
  return text.slice(0, marker).trimEnd()
}

/** Attach the latest project graph to a native DSH text submission. */
export function embedDirectorContext(text: string, context: string): string {
  if (context === '') return text
  return `${text.trimEnd()}\n\n${DIRECTOR_CONTEXT_START}\n${context}\n${DIRECTOR_CONTEXT_END}`
}

function foldMessages(
  eventEntries: readonly unknown[],
  sessionSnapshot: JsonRecord,
): ProjectChatMessage[] {
  const events = eventEntries.flatMap(entry => {
    const event = eventRecord(entry)
    return event === undefined ? [] : [event]
  })
  const surface = surfaceState(events)
  const finalSteps = new Set<string>()
  const toolNames = new Map<string, string>()
  const completedCallIds = new Set<string>()
  const durableRpcIds = new Set<string>()

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventRecord
    const seq = eventSeq(event, index)
    if (event.type === 'assistant/message' && surface.active.has(seq)) {
      const step = eventStep(event.data)
      if (step !== undefined) finalSteps.add(step)
    }
    if (event.type === 'tool/call' && isRecord(event.data)) {
      const callId = stringValue(event.data.callId)
      const name = stringValue(event.data.name)
      if (callId !== undefined && name !== undefined) toolNames.set(callId, name)
    }
    if (event.type === 'tool/result' && surface.active.has(seq)) {
      const callId = toolResultData(event.data).callId
      if (callId !== undefined) completedCallIds.add(callId)
    }
    if (event.type === 'user/message' && surface.active.has(seq)) {
      const source = sourceOf(event.data)
      const rpcId = stringValue(source?.rpcId)
      if (rpcId !== undefined) durableRpcIds.add(rpcId)
    }
  }

  const messages: ProjectChatMessage[] = []
  const streamRows = new Map<string, number>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventRecord
    const seq = eventSeq(event, index)
    const time = numberValue(event.time)

    if (event.type === 'user/message') {
      if (!surface.active.has(seq)) continue
      const source = sourceOf(event.data)
      // DSH also logs plugin/skill/context injections as user-role messages.
      // The compact Director transcript intentionally keeps human prompts only.
      if (source?.kind !== 'user') continue
      const text = stripDirectorContext(contentText(event.data))
      if (text === '') continue
      messages.push({
        id: idOf(event.data, `user:${seq}`),
        role: 'user',
        kind: 'user',
        status: 'complete',
        text,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'assistant/message') {
      if (!surface.active.has(seq)) continue
      const message = messageAt(event.data)
      const text = stripDirectorContext(contentText(message))
      if (text === '') continue
      messages.push({
        id: idOf(message, `assistant:${seq}`),
        role: 'assistant',
        kind: 'assistant',
        status: 'complete',
        text,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'tool/call') {
      if (isReplaced(seq, surface.replacements) || !isRecord(event.data)) continue
      const callId = stringValue(event.data.callId) ?? String(seq)
      const toolName = stringValue(event.data.name) ?? 'tool'
      const args = prettyArguments(event.data.arguments)
      messages.push({
        id: `tool-call:${callId}`,
        role: 'assistant',
        kind: 'tool-call',
        status: completedCallIds.has(callId) ? 'complete' : 'streaming',
        callId,
        toolName,
        text: args === '' ? toolName : `${toolName}\n${args}`,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'tool/result') {
      if (!surface.active.has(seq)) continue
      const result = toolResultData(event.data)
      const toolName = result.callId === undefined ? undefined : toolNames.get(result.callId)
      const body = contentText(result.message, true)
      messages.push({
        id: idOf(result.message, `tool-result:${result.callId ?? seq}`),
        role: 'assistant',
        kind: 'tool-result',
        status: result.isError ? 'error' : 'complete',
        ...(result.callId === undefined ? {} : { callId: result.callId }),
        ...(toolName === undefined ? {} : { toolName }),
        text: body === '' ? `${toolName ?? 'Tool'} finished.` : body,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    let step: string | undefined
    let delta = ''
    if (event.type === 'assistant/chunk' && isRecord(event.data) && isRecord(event.data.chunk)) {
      step = eventStep(event.data)
      if (event.data.chunk.type === 'text-delta') delta = stringValue(event.data.chunk.text) ?? ''
    } else if (event.type === 'chunkrow/text-chunks' && isRecord(event.data)) {
      step = eventStep(event.data)
      if (Array.isArray(event.data.texts)) {
        delta = event.data.texts.filter((part): part is string => typeof part === 'string').join('')
      }
    }
    if (step === undefined || delta === '' || finalSteps.has(step)
      || isReplaced(seq, surface.replacements)) continue
    const previous = streamRows.get(step)
    if (previous === undefined) {
      streamRows.set(step, messages.length)
      messages.push({
        id: `assistant-stream:${step}`,
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        text: delta,
        ...(time === undefined ? {} : { time }),
      })
    } else {
      const current = messages[previous] as ProjectChatMessage
      messages[previous] = { ...current, text: current.text + delta }
    }
  }

  const queueRpcIds = new Set<string>()
  const queue = Array.isArray(sessionSnapshot.queue) ? sessionSnapshot.queue : []
  for (const item of queue) {
    if (!isRecord(item) || item.placement === 'context') continue
    const rpcId = stringValue(item.rpcId)
    if (rpcId !== undefined) queueRpcIds.add(rpcId)
    const text = stripDirectorContext(stringValue(item.text) ?? stringValue(item.preview) ?? '')
    if (text === '') continue
    messages.push({
      id: `queue:${stringValue(item.id) ?? messages.length}`,
      role: 'user',
      kind: 'user',
      status: 'pending',
      text,
    })
  }

  const pending = Array.isArray(sessionSnapshot.pendingSubmissions)
    ? sessionSnapshot.pendingSubmissions
    : []
  for (const item of pending) {
    if (!isRecord(item)) continue
    const requestId = stringValue(item.requestId)
    if (requestId !== undefined
      && (durableRpcIds.has(requestId) || queueRpcIds.has(requestId))) continue
    const text = stripDirectorContext(stringValue(item.text) ?? '')
    if (text === '') continue
    const pendingTime = numberValue(item.time)
    messages.push({
      id: `pending:${requestId ?? messages.length}`,
      role: 'user',
      kind: 'user',
      status: 'pending',
      text,
      ...(pendingTime === undefined ? {} : { time: pendingTime }),
    })
  }

  return messages
}

function emptySnapshot(): ProjectChatSnapshot {
  return {
    projectId: null,
    sessionId: null,
    messages: [],
    running: false,
    sending: false,
    error: null,
    models: EMPTY_MODEL_DIRECTORY,
  }
}

/**
 * Project-aware DSH Session read model. It follows DirectorController's active
 * project, attaches only to that project's native Session binding, and drops
 * stale notifications whenever the project changes.
 */
export class ProjectChatSource implements ObservableSource<ProjectChatSnapshot> {
  private snapshot = emptySnapshot()
  private readonly listeners = new Set<() => void>()
  private binding: SessionBinding | undefined
  private modelDirectory: ChatModelDirectory | undefined
  private projectId: string | null = null
  private sessionId: string | null = null
  private disposed = false
  private disposeDirector: (() => void) | undefined
  private disposeSessions: (() => void) | undefined
  private disposeSession: (() => void) | undefined
  private disposeEvents: (() => void) | undefined
  private disposeModels: (() => void) | undefined
  private readonly sending = new Map<string, number>()
  private readonly localErrors = new Map<string, string>()
  private readonly ignoredNativeErrors = new Map<string, string>()
  private unboundError: string | null = null
  private modelDirectoryError: string | null = null
  private readonly promptControllers = new Set<AbortController>()

  constructor(
    private readonly ctx: ClientContext,
    private readonly director: DirectorController,
  ) {
    this.disposeDirector = director.subscribe(this.followProject)
    this.disposeSessions = ctx.sessions.list.subscribe(this.followBinding)
    this.followProject()
  }

  getSnapshot = (): ProjectChatSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Send through DSH's optimistic submission + identified native prompt path. */
  send = async (text: string, images: readonly File[] = []): Promise<void> => {
    const visibleText = text.trim()
    if (visibleText === '' && images.length === 0) return
    const project = this.director.getSnapshot().project
    const sessionId = project?.sessionId ?? null
    if (project === null || sessionId === null) {
      this.unboundError = 'Select a Video Project before sending a message.'
      this.rebuild()
      return
    }
    const binding = sessionId === this.sessionId ? this.binding : undefined
    if (binding === undefined) {
      this.localErrors.set(sessionId, 'The project\'s DeepSeek session is still opening.')
      this.rebuild()
      return
    }

    const payload = embedDirectorContext(visibleText, this.director.currentContext())
    const controller = new AbortController()
    this.promptControllers.add(controller)
    this.sending.set(sessionId, (this.sending.get(sessionId) ?? 0) + 1)
    this.localErrors.delete(sessionId)
    this.rebuild()

    const previews = images.map(file => ({ file, previewUrl: URL.createObjectURL(file) }))
    let finishRetirement: ((retirement: { reason: 'observed' | 'failed' }) => void) | undefined
    const retirement = previews.length === 0
      ? undefined
      : new Promise<{ reason: 'observed' | 'failed' }>((resolve) => { finishRetirement = resolve })
    let submission: ReturnType<SessionBinding['session']['beginSubmission']> | undefined
    try {
      submission = binding.session.beginSubmission({
        mode: 'queue',
        text: payload,
        images: previews.map(({ file, previewUrl }) => ({
          previewUrl,
          ...(file.name === '' ? {} : { name: file.name }),
        })),
        onRetire: (settlement) => {
          for (const preview of previews) URL.revokeObjectURL(preview.previewUrl)
          finishRetirement?.({ reason: settlement.reason })
        },
      })
      const encodedImages = await Promise.all(images.map(serializeChatImage))
      const result = await binding.session.prompt(
        [...encodedImages, { type: 'text', text: payload }],
        'queue',
        controller.signal,
        submission.requestId,
      )
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      if (retirement !== undefined && (await retirement).reason !== 'observed') {
        throw new Error('The image submission was not added to the project session.')
      }
    } catch (error) {
      if (submission === undefined) {
        for (const preview of previews) URL.revokeObjectURL(preview.previewUrl)
      } else {
        submission.abandon()
      }
      if (!controller.signal.aborted || !this.disposed) {
        this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
      }
      throw error
    } finally {
      this.promptControllers.delete(controller)
      const remaining = (this.sending.get(sessionId) ?? 1) - 1
      if (remaining <= 0) this.sending.delete(sessionId)
      else this.sending.set(sessionId, remaining)
      if (!this.disposed) this.rebuild()
    }
  }

  selectModel = async (selection: ChatModelSelection): Promise<void> => {
    const sessionId = this.sessionId
    if (sessionId === null || this.modelDirectory === undefined) return
    try {
      await this.modelDirectory.select(selection)
      this.localErrors.delete(sessionId)
    } catch (error) {
      this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (!this.disposed) this.rebuild()
    }
  }

  clearError = (): void => {
    if (this.sessionId === null) {
      this.unboundError = null
      this.rebuild()
      return
    }
    this.localErrors.delete(this.sessionId)
    const native = this.binding === undefined
      ? null
      : sessionError(this.binding.session.getSnapshot())
    if (native === null) this.ignoredNativeErrors.delete(this.sessionId)
    else this.ignoredNativeErrors.set(this.sessionId, native)
    this.rebuild()
  }

  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.detachBinding()
    this.detachModelDirectory()
    this.disposeDirector?.()
    this.disposeSessions?.()
    this.disposeDirector = undefined
    this.disposeSessions = undefined
    for (const controller of this.promptControllers) controller.abort()
    this.promptControllers.clear()
    this.listeners.clear()
  }

  private readonly followProject = (): void => {
    if (this.disposed) return
    const project = this.director.getSnapshot().project
    const projectId = project?.id ?? null
    const sessionId = project?.sessionId ?? null
    if (projectId === this.projectId && sessionId === this.sessionId) {
      if (sessionId !== null && this.binding === undefined) this.followBinding()
      if (sessionId !== null && this.modelDirectory === undefined) this.followModelDirectory()
      return
    }

    this.detachBinding()
    this.detachModelDirectory()
    this.projectId = projectId
    this.sessionId = sessionId
    this.unboundError = null
    this.modelDirectoryError = null
    this.publish({
      projectId,
      sessionId,
      messages: [],
      running: false,
      sending: sessionId !== null && (this.sending.get(sessionId) ?? 0) > 0,
      error: sessionId === null ? null : this.localErrors.get(sessionId) ?? null,
      models: EMPTY_MODEL_DIRECTORY,
    })
    if (sessionId === null) return
    if (this.ctx.sessions.list.getSnapshot().current !== sessionId) {
      this.ctx.sessions.open(sessionId)
    }
    this.followModelDirectory()
    this.followBinding()
  }

  private readonly followModelDirectory = (): void => {
    if (this.disposed || this.sessionId === null || this.modelDirectory !== undefined) return
    try {
      const sessionId = this.sessionId
      const directory = this.ctx.modelDirectories.directoryFor(sessionId)
      this.modelDirectory = directory
      this.disposeModels = directory.store.subscribe(this.rebuild)
      void directory.load().catch((error: unknown) => {
        if (this.modelDirectory !== directory || this.sessionId !== sessionId) return
        this.modelDirectoryError = error instanceof Error ? error.message : String(error)
        if (!this.disposed) this.rebuild()
      })
    } catch (error) {
      this.modelDirectoryError = error instanceof Error ? error.message : String(error)
    }
    this.rebuild()
  }

  private readonly followBinding = (): void => {
    if (this.disposed || this.sessionId === null) return
    const next = this.ctx.sessions.binding(this.sessionId)
    if (next === this.binding) {
      if (next !== undefined) this.rebuild()
      return
    }
    this.detachBinding()
    this.binding = next
    if (next !== undefined) {
      this.disposeSession = next.session.subscribe(this.rebuild)
      this.disposeEvents = next.eventSource.subscribe(this.rebuild)
    }
    this.rebuild()
  }

  private readonly rebuild = (): void => {
    if (this.disposed) return
    const sessionId = this.sessionId
    const binding = this.binding
    if (sessionId === null || binding === undefined) {
      this.publish({
        projectId: this.projectId,
        sessionId,
        messages: [],
        running: false,
        sending: sessionId !== null && (this.sending.get(sessionId) ?? 0) > 0,
        error: sessionId === null
          ? this.unboundError
          : this.localErrors.get(sessionId) ?? null,
        models: this.modelSnapshot(),
      })
      return
    }

    const nativeSnapshot = binding.session.getSnapshot()
    const nativeError = sessionError(nativeSnapshot)
    if (nativeError === null) this.ignoredNativeErrors.delete(sessionId)
    const visibleNativeError = nativeError !== null
      && this.ignoredNativeErrors.get(sessionId) !== nativeError
      ? nativeError
      : null
    this.publish({
      projectId: this.projectId,
      sessionId,
      messages: foldMessages(binding.eventSource.getSnapshot().entries, nativeSnapshot),
      running: nativeSnapshot.running === true,
      sending: (this.sending.get(sessionId) ?? 0) > 0,
      error: this.localErrors.get(sessionId) ?? visibleNativeError,
      models: this.modelSnapshot(),
    })
  }

  private modelSnapshot(): ChatModelDirectoryState {
    const current = this.modelDirectory?.store.getSnapshot()
    if (current !== undefined) return current
    if (this.modelDirectoryError === null) return EMPTY_MODEL_DIRECTORY
    return { ...EMPTY_MODEL_DIRECTORY, status: 'error', error: this.modelDirectoryError }
  }

  private detachBinding(): void {
    this.disposeSession?.()
    this.disposeEvents?.()
    this.disposeSession = undefined
    this.disposeEvents = undefined
    this.binding = undefined
  }

  private detachModelDirectory(): void {
    this.disposeModels?.()
    this.disposeModels = undefined
    this.modelDirectory = undefined
  }

  private publish(snapshot: ProjectChatSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/** Alternate descriptive name for hosts that do not use the Project prefix. */
export { ProjectChatSource as DirectorChatSource }
