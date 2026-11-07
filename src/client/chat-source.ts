import type { DirectorController } from './controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatAttachmentRegistry, type ChatAttachment } from './chat-attachments'
import { skillNames } from './chat-skills'
import type {
  ChatModelDirectory,
  ChatModelDirectoryState,
  ChatModelSelection,
  ChatMessage,
  ChatSnapshot,
  ClientContext,
  ObservableSource,
  SessionBinding,
  SessionReference,
} from './types'

/** Delimiters make canvas context removable from the transcript projection. */
export const DIRECTOR_CONTEXT_START = '<dsh-video-director-context version="1">'
export const DIRECTOR_CONTEXT_END = '</dsh-video-director-context>'

export type ProjectChatMessageKind = 'user' | 'assistant' | 'tool-call' | 'tool-result'
export type ProjectChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error'

export type ChatMessageImage = { name?: string; number?: number } & (
  { attachmentId: string; previewUrl?: never } | { previewUrl: string; attachmentId?: never }
)

type ReplyModel = Pick<ChatModelSelection, 'provider' | 'model'>

/** A compact transcript row derived only from the currently bound DSH Session. */
export interface ProjectChatMessage extends ChatMessage {
  kind: ProjectChatMessageKind
  status: ProjectChatMessageStatus
  callId?: string
  toolName?: string
  toolCommand?: string
  images?: ChatMessageImage[]
  model?: ReplyModel
}

/** Read model consumed by the Video Director's project-scoped chat panel. */
export interface ProjectChatSnapshot extends Omit<ChatSnapshot, 'messages'> {
  projectId: string | null
  messages: ProjectChatMessage[]
  models: ChatModelDirectoryState
  stopping: boolean
}

type JsonRecord = Record<string, unknown>

const EMPTY_MODEL_DIRECTORY: ChatModelDirectoryState = {
  current: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
  pending: null,
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

function transcriptContent(message: unknown, includeReasoning = false): { text: string; images: ChatMessageImage[] } {
  const images: ChatMessageImage[] = []
  const collect = (block: unknown): string[] => {
    if (!isRecord(block)) return []
    if (block.type === 'tool-result') return Array.isArray(block.content) ? block.content.flatMap(collect) : []
    if (block.type === 'image') {
      const attachment = isRecord(block.attachment) ? block.attachment : undefined
      const attachmentId = stringValue(attachment?.attachmentId)
      if (attachmentId === undefined) return ['[Image]']
      images.push({ attachmentId, name: stringValue(attachment?.name) })
      return []
    }
    if (block.type !== 'text' && !(includeReasoning && block.type === 'reasoning')) return []
    const text = stringValue(block.text)
    return text === undefined ? [] : [text]
  }
  return { text: messageContent(message).flatMap(collect).join('\n').trim(), images }
}

function pendingImages(item: JsonRecord): ChatMessageImage[] {
  if (!Array.isArray(item.attachments)) return []
  return item.attachments.flatMap(attachment => {
    if (!isRecord(attachment) || attachment.type !== 'image' || !isRecord(attachment.value)) return []
    const previewUrl = stringValue(attachment.value.previewUrl)
    return previewUrl === undefined ? [] : [{ previewUrl, name: stringValue(attachment.value.name) }]
  })
}

function sourceOf(message: unknown): JsonRecord | undefined {
  return isRecord(message) && isRecord(message.source) ? message.source : undefined
}

function replyModel(value: unknown): ReplyModel | undefined {
  if (!isRecord(value)) return undefined
  const provider = stringValue(value.provider)
  const model = stringValue(value.model)
  return provider && model ? { provider, model } : undefined
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
    const start = numberValue(op.startSeq)
    const end = numberValue(op.endSeq)
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

function displayArguments(value: unknown): { args: string; toolCommand?: string } {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return { args: value } }
  }
  const toolCommand = isRecord(parsed) ? stringValue(parsed.command) : undefined
  return { args: JSON.stringify(parsed, null, 2) ?? '', ...(toolCommand ? { toolCommand } : {}) }
}

function failureMessage(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (!isRecord(value)) return null
  const message = stringValue(value.message)
  if (message !== undefined) return message
  return value.error === value ? null : failureMessage(value.error)
}

function sessionError(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null
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
  const callId = (isRecord(message) ? stringValue(message.toolCallId) : undefined)
    ?? stringValue(source?.callId)
    ?? (isRecord(block) ? stringValue(block.toolCallId) : undefined)
  const isError = (isRecord(data) && data.error !== undefined)
    || (isRecord(message) && message.isError === true)
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

interface ImageLabels {
  aliases: Map<number, number>
  thumbnails: Map<number, number>
  local: boolean
}

/** Read the attachment manifest embedded by Director, including old global-only manifests. */
function readImageLabels(text: string): ImageLabels | undefined {
  const start = text.lastIndexOf(DIRECTOR_CONTEXT_START)
  const end = text.lastIndexOf(DIRECTOR_CONTEXT_END)
  if (start < 0 || end < start) return undefined
  const manifest = text.slice(start + DIRECTOR_CONTEXT_START.length, end).trimEnd().split('\n').at(-1)
  if (manifest === undefined) return undefined
  let data: unknown
  try { data = JSON.parse(manifest) } catch { return undefined }
  if (!isRecord(data) || !Array.isArray(data.attachments)) return undefined
  const aliases = new Map<number, number>()
  const thumbnails = new Map<number, number>()
  let local = false
  for (const entry of data.attachments) {
    if (!isRecord(entry) || entry.kind !== 'image') continue
    const match = /^<Image ([1-9]\d*)>$/.exec(stringValue(entry.alias) ?? '')
    if (!match) continue
    const number = aliases.size + 1
    aliases.set(Number(match[1]), number)
    local ||= typeof entry.label === 'string'
    const index = numberValue(entry.imageIndex)
    if (index !== undefined && Number.isSafeInteger(index) && index > 0) thumbnails.set(index, number)
  }
  return aliases.size > 0 ? { aliases, thumbnails, local } : undefined
}

function localizeImageLabels(text: string, labels: ImageLabels | undefined): string {
  if (labels === undefined) return text
  return text.replace(/\b(Image)([ \t]+)([1-9]\d*)\b/gi, (match, word, gap, digits) => {
    const alias = Number(digits)
    // A reply to a locally numbered prompt may already use the correct number.
    if (labels.local && alias <= labels.aliases.size) return match
    const local = labels.aliases.get(alias)
    return local === undefined ? match : `${word}${gap}${local}`
  })
}

function displayUserMessage(text: string, images: ChatMessageImage[], labels = readImageLabels(text)): Pick<ProjectChatMessage, 'text' | 'images'> {
  const visible = stripDirectorContext(text)
  return {
    text: labels?.local ? visible : localizeImageLabels(visible, labels),
    ...(images.length === 0 ? {} : {
      images: images.map((image, index) => ({ ...image, number: labels?.thumbnails.get(index + 1) ?? index + 1 })),
    }),
  }
}

function foldMessages(
  eventEntries: readonly unknown[],
  snapshot: unknown,
  inboxValue: unknown,
): ProjectChatMessage[] {
  const sessionSnapshot = isRecord(snapshot) ? snapshot : {}
  const events = eventEntries.flatMap(entry => {
    const event = eventRecord(entry)
    return event === undefined ? [] : [event]
  })
  const surface = surfaceState(events)
  const finalSteps = new Map<string, number>()
  const toolNames = new Map<string, string>()
  const completedCallIds = new Set<string>()
  const durableRpcIds = new Set<string>()

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventRecord
    const seq = eventSeq(event, index)
    if (event.type === 'assistant/message' && surface.active.has(seq)) {
      const step = eventStep(event.data)
      if (step !== undefined) finalSteps.set(step, seq)
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
  const streamRows = new Map<string, { index: number; labels: ImageLabels | undefined }>()
  let imageLabels: ImageLabels | undefined
  let requestModel: ReplyModel | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventRecord
    const seq = eventSeq(event, index)
    const time = numberValue(event.time)

    if (event.type === 'request/header' && isRecord(event.data) && isRecord(event.data.header)) {
      requestModel = replyModel(event.data.header.config) ?? requestModel
    } else if (event.type === 'request/context') {
      requestModel = replyModel(event.data) ?? requestModel
    }

    if (event.type === 'user/message') {
      const source = sourceOf(event.data)
      // DSH also logs plugin/skill/context injections as user-role messages.
      // The compact Director transcript intentionally keeps human prompts only.
      if (source?.kind !== 'user') continue
      const { text, images } = transcriptContent(event.data)
      imageLabels = readImageLabels(text)
      if (!surface.active.has(seq)) continue
      const content = displayUserMessage(text, images, imageLabels)
      if (content.text === '' && content.images === undefined) continue
      messages.push({
        id: idOf(event.data, `user:${seq}`),
        role: 'user',
        kind: 'user',
        status: 'complete',
        ...content,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'assistant/message') {
      if (!surface.active.has(seq)) continue
      const message = messageAt(event.data)
      const content = transcriptContent(message)
      const text = localizeImageLabels(stripDirectorContext(content.text), imageLabels)
      if (text === '' && content.images.length === 0) continue
      messages.push({
        id: idOf(message, `assistant:${seq}`),
        role: 'assistant',
        kind: 'assistant',
        status: 'complete',
        text,
        ...(content.images.length ? { images: content.images } : {}),
        model: replyModel(sourceOf(message)) ?? requestModel,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'tool/call') {
      if (isReplaced(seq, surface.replacements) || !isRecord(event.data)) continue
      const callId = stringValue(event.data.callId) ?? String(seq)
      const toolName = stringValue(event.data.name) ?? 'tool'
      const { args, toolCommand } = displayArguments(event.data.arguments)
      messages.push({
        id: `tool-call:${callId}`,
        role: 'assistant',
        kind: 'tool-call',
        status: completedCallIds.has(callId) ? 'complete' : 'streaming',
        callId,
        toolName,
        ...(toolCommand && toolName.startsWith('vd_') ? { toolCommand } : {}),
        text: args === '' ? toolName : `${toolName}\n${args}`,
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    if (event.type === 'tool/result') {
      if (!surface.active.has(seq)) continue
      const result = toolResultData(event.data)
      const toolName = result.callId === undefined ? undefined : toolNames.get(result.callId)
      const { text, images } = transcriptContent(result.message, true)
      messages.push({
        id: idOf(result.message, `tool-result:${result.callId ?? seq}`),
        role: 'assistant',
        kind: 'tool-result',
        status: result.isError ? 'error' : 'complete',
        ...(result.callId === undefined ? {} : { callId: result.callId }),
        ...(toolName === undefined ? {} : { toolName }),
        text: text === '' && images.length === 0 ? `${toolName ?? 'Tool'} finished.` : text,
        ...(images.length ? { images } : {}),
        ...(time === undefined ? {} : { time }),
      })
      continue
    }

    let step: string | undefined
    let delta = ''
    if (event.type === 'assistant/live-chunk' && isRecord(event.data) && isRecord(event.data.chunk)) {
      step = stringValue(event.data.attemptId)
      if (event.data.chunk.type === 'text-delta') delta = stringValue(event.data.chunk.text) ?? ''
    }
    // A normal settlement leaves live chunks in the native event window until
    // step/end. Hide that prefix without suppressing a later retry's attempt.
    const finalSeq = finalSteps.get(eventStep(event.data) ?? '')
    if (step === undefined || delta === '' || (finalSeq !== undefined && seq < finalSeq)
      || isReplaced(seq, surface.replacements)) continue
    const previous = streamRows.get(step)
    if (previous === undefined) {
      streamRows.set(step, { index: messages.length, labels: imageLabels })
      messages.push({
        id: `assistant-stream:${step}`,
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        text: delta,
        model: requestModel,
        ...(time === undefined ? {} : { time }),
      })
    } else {
      const current = messages[previous.index] as ProjectChatMessage
      messages[previous.index] = { ...current, text: current.text + delta }
    }
  }
  for (const { index, labels } of streamRows.values()) {
    const message = messages[index]!
    message.text = localizeImageLabels(message.text, labels)
  }

  const queueRpcIds = new Set<string>()
  const inbox = isRecord(inboxValue) ? inboxValue : {}
  const queue = ['next-turn', 'next-step'].flatMap(key => Array.isArray(inbox[key]) ? inbox[key] : [])
  for (const item of queue) {
    if (sourceOf(item)?.kind !== 'user') continue
    const rpcId = stringValue(sourceOf(item)?.rpcId)
    if (rpcId !== undefined && (durableRpcIds.has(rpcId) || queueRpcIds.has(rpcId))) continue
    if (rpcId !== undefined) queueRpcIds.add(rpcId)
    const { text, images } = transcriptContent(item)
    const content = displayUserMessage(text, images)
    if (content.text === '' && content.images === undefined) continue
    messages.push({
      id: `queue:${idOf(item, String(messages.length))}`,
      role: 'user',
      kind: 'user',
      status: 'pending',
      ...content,
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
    const content = displayUserMessage(stringValue(item.text) ?? '', pendingImages(item))
    if (content.text === '' && content.images === undefined) continue
    const pendingTime = numberValue(item.time)
    messages.push({
      id: `pending:${requestId ?? messages.length}`,
      role: 'user',
      kind: 'user',
      status: 'pending',
      ...content,
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
    stopping: false,
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
  private reference: SessionReference | undefined
  private inbox: ObservableSource<unknown> | undefined
  private opening = false
  private modelDirectory: ChatModelDirectory | undefined
  private projectId: string | null = null
  private sessionId: string | null = null
  private disposed = false
  private readonly attachmentRegistries = new Map<string, ChatAttachmentRegistry>()
  private disposeDirector: (() => void) | undefined
  private disposeSessions: (() => void) | undefined
  private disposeSession: (() => void) | undefined
  private disposeEvents: (() => void) | undefined
  private disposeInbox: (() => void) | undefined
  private disposeModels: (() => void) | undefined
  private readonly sending = new Map<string, number>()
  private readonly stopping = new Set<string>()
  private readonly localErrors = new Map<string, string>()
  private readonly ignoredNativeErrors = new Map<string, string>()
  private unboundError: string | null = null
  private modelDirectoryError: string | null = null
  private readonly promptControllers = new Set<AbortController>()
  private finishModelSettings: (() => void) | undefined

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

  readImage = async (sessionId: string, attachmentId: string): Promise<Blob> => {
    const binding = this.binding
    if (sessionId !== this.sessionId || binding === undefined) throw new Error('The chat session changed.')
    const result = await binding.session.readAttachment(attachmentId as Parameters<SessionBinding['session']['readAttachment']>[0])
    if (this.binding !== binding) throw new Error('The chat session changed.')
    if (!result.ok) throw new Error(result.error.message)
    const { data, attachment } = result.value
    return new Blob([Uint8Array.from(data).buffer], { type: attachment.mediaType })
  }

  /** Cancel only the running turn in the linked native session. */
  stop = async (): Promise<void> => {
    const sessionId = this.sessionId
    const binding = this.binding
    if (sessionId === null || binding === undefined || !this.snapshot.running || this.stopping.has(sessionId)) return
    this.stopping.add(sessionId)
    this.clearError()
    try {
      const result = await binding.session.cancel()
      if (!result.ok) throw new Error(result.error.message)
    } catch (error) {
      this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
    } finally {
      this.stopping.delete(sessionId)
      this.rebuild()
    }
  }

  attachments(): ChatAttachmentRegistry {
    const project = this.director.getSnapshot().project
    if (!project) throw new Error('Select a workflow first')
    const key = `${project.id}:${project.sessionId}`
    let registry = this.attachmentRegistries.get(key)
    if (!registry) {
      registry = new ChatAttachmentRegistry(input => this.director.chatReferences(input), project.id, project.sessionId)
      this.attachmentRegistries.set(key, registry)
    }
    return registry
  }

  async sendAttachments(text: string, automaticSkills = true): Promise<void> {
    const project = this.director.getSnapshot().project
    await this.director.prepareChatSkills(text)
    if (this.director.getSnapshot().project?.sessionId !== project?.sessionId) throw new Error('The chat session changed while selecting skills')
    await this.director.prepareChatContext()
    const registry = this.attachments()
    const selected = registry.getSnapshot().filter(item => !item.sent || (item.kind !== 'image' && text.includes(item.alias)))
    const prepared = await registry.prepare(selected)
    if (this.director.getSnapshot().project?.sessionId !== project?.sessionId) throw new Error('The chat session changed during upload')
    const files = await Promise.all(prepared.map(item => item.kind === 'image' ? registry.nativeImageFile(item) : undefined))
    if (this.director.getSnapshot().project?.sessionId !== project?.sessionId) throw new Error('The chat session changed while preparing images')
    const images: File[] = []
    let imageNumber = 0
    const references = prepared.map(({ alias, kind, name, nodeId }, index) => {
      const reference = { alias, kind, name, nodeId }
      if (kind !== 'image') return reference
      const label = `Image ${++imageNumber}`
      const file = files[index]
      if (!file) return { ...reference, label }
      images.push(file)
      return { ...reference, label, imageIndex: images.length }
    })
    const attachmentContext = JSON.stringify({
      attachments: references,
      ...(imageNumber === 0 ? {} : {
        imageLabels: 'Image labels restart at Image 1 in each user message. Match the inline images in this message by imageIndex (1-based). Use label in replies and the stable alias only for canvas tool arguments.',
      }),
    })
    await this.send(text || references.map(item => 'label' in item ? `<${item.label}>` : item.alias).join(' '), images, attachmentContext, automaticSkills)
    await registry.markSent(prepared)
  }

  /** Send through DSH's optimistic submission + identified native prompt path. */
  send = async (text: string, images: readonly File[] = [], attachmentContext = '', automaticSkills = true): Promise<void> => {
    const visibleText = text.trim()
    if (visibleText === '' && images.length === 0) return
    const project = this.director.getSnapshot().project
    const sessionId = project?.sessionId ?? null
    if (project === null || sessionId === null) {
      this.unboundError = 'Select a Video Project before sending a message.'
      this.rebuild()
      throw new Error(this.unboundError)
    }
    const binding = sessionId === this.sessionId ? this.binding : undefined
    if (binding === undefined) {
      const message = 'The project\'s DeepSeek session is still opening.'
      this.localErrors.set(sessionId, message)
      this.rebuild()
      throw new Error(message)
    }

    const context = this.director.currentContext(automaticSkills && skillNames(visibleText).length === 0)
    const payload = embedDirectorContext(visibleText, context + (attachmentContext ? `\n${attachmentContext}` : ''))
    const controller = new AbortController()
    this.promptControllers.add(controller)
    this.sending.set(sessionId, (this.sending.get(sessionId) ?? 0) + 1)
    this.localErrors.delete(sessionId)
    this.rebuild()

    const previews = images.map(file => ({ file, previewUrl: URL.createObjectURL(file) }))
    let sendReference: SessionReference | undefined
    let finishRetirement: ((retirement: { reason: 'observed' | 'failed' }) => void) | undefined
    const retirement = previews.length === 0
      ? undefined
      : new Promise<{ reason: 'observed' | 'failed' }>((resolve) => { finishRetirement = resolve })
    let submission: ReturnType<SessionBinding['session']['beginSubmission']> | undefined
    const abandon = () => submission?.abandon()
    controller.signal.addEventListener('abort', abandon, { once: true })
    try {
      // Switching projects releases the view, but must not retire an in-flight
      // submission or its object URLs before the native queue observes it.
      sendReference = this.ctx.sessions.retain(sessionId as SessionId, { source: 'videoDirector', signal: controller.signal })
      await sendReference.ready
      controller.signal.throwIfAborted()
      submission = binding.session.beginSubmission({
        mode: 'queue',
        text: payload,
        attachments: previews.map(({ file, previewUrl }) => ({
          type: 'image',
          value: { previewUrl, ...(file.name === '' ? {} : { name: file.name }) },
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
      controller.signal.removeEventListener('abort', abandon)
      sendReference?.release()
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
      const result = await this.modelDirectory.select(selection)
      if (!result.ok) throw new Error(result.error.message)
      this.localErrors.delete(sessionId)
    } catch (error) {
      this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (!this.disposed) this.rebuild()
    }
  }

  /** rc.2 exposes one shared settings shell store for its native entry points. */
  openModelSettings = async (): Promise<void> => {
    if (this.finishModelSettings) throw new Error('Model settings are already open.')
    const entries = this.ctx.slots?.entries?.('sidebar.settings') ?? []
    const instance = entries.find(entry => entry.store)?.store?.create() as {
      getSnapshot?(): { open: boolean }
      subscribe?(listener: () => void): () => void
      actions?: { openSection?(section: string): void }
    } | undefined
    if (!instance?.actions?.openSection || !instance.getSnapshot || !instance.subscribe) throw new Error('dsh model settings are unavailable. Open Models from dsh settings, then return to this chat.')
    await new Promise<void>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined
      const finish = (): void => { unsubscribe?.(); this.finishModelSettings = undefined; resolve() }
      this.finishModelSettings = finish
      try {
        instance.actions!.openSection!('models')
        unsubscribe = instance.subscribe!(() => { if (!instance.getSnapshot!().open) finish() })
        if (!instance.getSnapshot!().open) finish()
      } catch (error) { unsubscribe?.(); this.finishModelSettings = undefined; reject(error) }
    })
    if (!this.disposed && this.binding !== undefined) await this.refreshModels()
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
    this.finishModelSettings?.()
    this.detachBinding()
    this.detachModelDirectory()
    this.releaseReference()
    for (const registry of this.attachmentRegistries.values()) registry.dispose()
    this.attachmentRegistries.clear()
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
      return
    }

    this.detachBinding()
    this.detachModelDirectory()
    this.releaseReference()
    this.projectId = projectId
    this.sessionId = sessionId
    this.unboundError = null
    this.modelDirectoryError = null
    this.publish({
      projectId,
      sessionId,
      messages: [],
      running: false,
      stopping: false,
      sending: sessionId !== null && (this.sending.get(sessionId) ?? 0) > 0,
      error: sessionId === null ? null : this.localErrors.get(sessionId) ?? null,
      models: EMPTY_MODEL_DIRECTORY,
    })
    if (sessionId === null) return
    this.followBinding()
  }

  refreshModels = async (): Promise<void> => {
    const sessionId = this.sessionId
    const binding = this.binding
    if (this.disposed || sessionId === null) return
    this.modelDirectoryError = null
    try {
      if (binding === undefined) throw new Error('The linked chat session is unavailable.')
      if (this.modelDirectory === undefined) {
        const directory = this.ctx.modelDirectories.directoryFor(sessionId as SessionId)
        this.disposeModels = directory.store.subscribe(() => {
          this.modelDirectoryError = null
          this.rebuild()
        })
        this.modelDirectory = directory
      }
      await this.modelDirectory.load()
    } catch (error) {
      if (!this.disposed && this.sessionId === sessionId && this.binding === binding) {
        this.modelDirectoryError = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally {
      if (!this.disposed && this.sessionId === sessionId && this.binding === binding) this.rebuild()
    }
  }

  private readonly followBinding = (): void => {
    if (this.disposed || this.sessionId === null || this.reference !== undefined || this.opening) return
    // A catalog row does not own a generation. Retain publishes the row's
    // ownership synchronously, so guard against reentrant list notifications.
    const sessionId = this.sessionId
    if (this.ctx.sessions.list.getSnapshot().byId[sessionId as SessionId] === undefined) return
    this.opening = true
    try {
      const reference = this.ctx.sessions.retain(sessionId as SessionId, { source: 'videoDirector' })
      this.reference = reference
      void reference.ready.then(binding => {
        if (this.disposed || this.reference !== reference || this.sessionId !== sessionId) return
        this.binding = binding
        this.disposeSession = binding.session.subscribe(this.rebuild)
        this.disposeEvents = binding.eventSource.subscribe(this.rebuild)
        this.inbox = binding.session.projections.faceOf('inbox')
        this.disposeInbox = this.inbox.subscribe(this.rebuild)
        void this.refreshModels().catch(() => { /* The model picker shows the load error. */ })
        this.rebuild()
      }).catch((error: unknown) => {
        if (this.disposed || this.reference !== reference || this.sessionId !== sessionId) return
        this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
        this.rebuild()
      })
    } catch (error) {
      this.localErrors.set(sessionId, error instanceof Error ? error.message : String(error))
      this.rebuild()
    } finally {
      this.opening = false
    }
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
        stopping: false,
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
      messages: foldMessages(binding.eventSource.getSnapshot().entries, nativeSnapshot, this.inbox?.getSnapshot()),
      running: nativeSnapshot.running === true,
      stopping: this.stopping.has(sessionId),
      sending: (this.sending.get(sessionId) ?? 0) > 0,
      error: this.localErrors.get(sessionId) ?? visibleNativeError,
      models: this.modelSnapshot(),
    })
  }

  private modelSnapshot(): ChatModelDirectoryState {
    const current = this.modelDirectory?.store.getSnapshot()
    const snapshot = current ?? EMPTY_MODEL_DIRECTORY
    if (this.modelDirectoryError === null || snapshot.error !== null) return snapshot
    return { ...snapshot, status: 'error', error: this.modelDirectoryError }
  }

  private detachBinding(): void {
    this.disposeSession?.()
    this.disposeEvents?.()
    this.disposeInbox?.()
    this.disposeSession = undefined
    this.disposeEvents = undefined
    this.disposeInbox = undefined
    this.inbox = undefined
    this.binding = undefined
  }

  private releaseReference(): void {
    // Clear after release: release itself notifies the catalog synchronously.
    this.reference?.release()
    this.reference = undefined
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
