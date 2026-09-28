import { fileKind, inferredMimeType, isTextFile, acceptsInputFile } from './input-files'
import type { AssetRef, DirectorNode } from './types'
import type { PreviewArtifact } from './ArtifactPreview'

export type ChatAttachmentKind = 'image' | 'audio' | 'video' | 'folder' | 'node'
export interface ChatAttachment {
  id: string
  alias: string
  kind: ChatAttachmentKind
  name: string
  file?: File
  files?: File[]
  nodeId?: string
  projectId: string
  previewUrl?: string
  asset?: AssetRef
  manifest?: ChatFileMetadata[]
  ready?: boolean
  sent?: boolean
}
export const CHAT_NODE_MIME = 'application/x-video-director-node'
export const CHAT_ALIAS_MIME = 'application/x-video-director-alias'

export interface ChatFileMetadata { name: string; path: string; mimeType: string; size: number; uploaded?: boolean; assetId?: string }
type Transport = (input: Record<string, unknown>) => Promise<any>

/** One registry per conversation, with durable aliases allocated atomically on the Host. */
export class ChatAttachmentRegistry {
  private entries: ChatAttachment[] = []
  private listeners = new Set<() => void>()
  private loaded?: Promise<void>
  private disposed = false
  constructor(private transport: Transport, private projectId: string, private sessionId: string) {}
  getSnapshot = (): ChatAttachment[] => this.entries
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(): void { for (const listener of this.listeners) listener() }
  private call(input: Record<string, unknown>): Promise<any> { return this.transport({ ...input, projectId: this.projectId, sessionId: this.sessionId }) }
  private fromRemote(entry: any): ChatAttachment {
    const local = this.entries.find(item => item.id === entry.id)
    return { ...local, ...entry, files: local?.files, file: local?.file, manifest: entry.files, previewUrl: local?.previewUrl ?? entry.asset?.url }
  }
  load(): Promise<void> {
    return this.loaded ??= this.call({ action: 'list' }).then(({ entries }) => {
      if (!this.disposed) { this.entries = entries.map((entry: any) => this.fromRemote(entry)); this.publish() }
    }).catch(error => { this.loaded = undefined; throw error })
  }
  private async add(kind: ChatAttachmentKind, name: string, extra: Partial<ChatAttachment>): Promise<ChatAttachment> {
    await this.load()
    const files = extra.files ?? (extra.file ? [extra.file] : [])
    const manifest = files.map(file => {
      let mimeType = isTextFile(file) ? 'text/plain' : file.type || 'application/octet-stream'
      try { mimeType = inferredMimeType(file, fileKind(file)) } catch {}
      return { name: file.name, path: file.webkitRelativePath || file.name, size: file.size, mimeType }
    })
    const { entry } = await this.call({ action: 'reserve', id: crypto.randomUUID(), kind, name, nodeId: extra.nodeId, files: manifest })
    const item = { ...entry, ...extra, files: extra.files, manifest, projectId: this.projectId }
    if (!this.disposed) { this.entries = [...this.entries, item]; this.publish() }
    return item
  }
  async addFile(file: File): Promise<ChatAttachment> {
    const kind = fileKind(file)
    if (!acceptsInputFile(file, kind)) throw new Error(`Unsupported ${kind} format: ${file.name}`)
    const item = await this.add(kind, file.name, { file })
    item.previewUrl = URL.createObjectURL(file)
    this.entries = [...this.entries]; this.publish()
    return item
  }
  addFolder(files: File[]): Promise<ChatAttachment> {
    if (files.length > 5000) return Promise.reject(new Error('A folder can contain at most 5000 files.'))
    return this.add('folder', files[0]?.webkitRelativePath.split('/')[0] || 'Folder', { files })
  }
  async addNode(node: DirectorNode): Promise<ChatAttachment> {
    await this.load()
    return this.entries.find(item => item.kind === 'node' && item.nodeId === node.id)
      ?? this.add('node', node.data.title, { nodeId: node.id })
  }
  async prepare(items: ChatAttachment[]): Promise<ChatAttachment[]> {
    for (const item of items) {
      if (item.ready) continue
      const files = item.files ?? (item.file ? [item.file] : [])
      if (!files.length && item.manifest?.length) throw new Error(`${item.alias} needs to be reattached: its local upload was interrupted.`)
      for (const [fileIndex, file] of files.entries()) {
        if (item.manifest?.[fileIndex]?.uploaded) continue
        let binary = ''
        const bytes = new Uint8Array(await file.arrayBuffer())
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
          if (offset > 0 && offset % (2 * 1024 * 1024) === 0) await new Promise(resolve => setTimeout(resolve, 0))
        }
        const { entry, file: acknowledgedFile } = await this.call({ action: 'upload', id: item.id, fileIndex, dataBase64: btoa(binary) })
        const current = this.entries.find(row => row.id === item.id) ?? item
        const updated = { ...current, ...entry, files: current.files, manifest: (current.manifest ?? []).map((file, index) => index === fileIndex ? acknowledgedFile : file) }
        this.entries = this.entries.map(current => current.id === item.id ? updated : current)
        this.publish()
      }
    }
    return items.map(item => this.entries.find(current => current.id === item.id) ?? item)
  }
  async markSent(items: ChatAttachment[]): Promise<void> {
    const ids = new Set(items.map(item => item.id))
    this.entries = this.entries.map(item => ids.has(item.id) ? { ...item, sent: true } : item)
    this.publish()
    // Delivery is already accepted; a metadata acknowledgement cannot turn it into a failed send.
    for (const id of ids) await this.call({ action: 'sent', id }).catch(() => {})
  }
  async remove(id: string): Promise<void> {
    const { entries } = await this.call({ action: 'hide', id })
    const item = this.entries.find(item => item.id === id)
    if (item?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl)
    this.entries = entries.map((entry: any) => this.fromRemote(entry)); this.publish()
  }
  dispose(): void {
    this.disposed = true
    for (const item of this.entries) if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl)
    this.entries = []; this.listeners.clear()
  }
}

/** Replace by stable identity in one pass so renumbering cannot cascade. */
export function updateChatAliases(text: string, before: ChatAttachment[], after: ChatAttachment[]): string {
  const aliases = new Map(after.map(item => [item.id, item.alias]))
  const replacements = new Map(before.map(item => [item.alias, aliases.get(item.id) ?? '']))
  return text.replace(/<(?:Image|Audio|Video|Folder|Node) [1-9]\d*>/g, alias => replacements.get(alias) ?? alias)
}

export function chatAttachmentPreview(item: ChatAttachment): PreviewArtifact | null {
  if (!item.previewUrl || item.kind === 'folder' || item.kind === 'node') return null
  if (item.asset) return { id: item.id, kind: item.kind, name: item.name, asset: item.asset }
  if (!item.file) return null
  return { id: item.id, kind: item.kind, name: item.name, asset: item.asset ?? {
    id: item.id, projectId: item.projectId, name: item.name, kind: item.kind,
    mimeType: inferredMimeType(item.file, item.kind), size: item.file.size,
    sha256: '', createdAt: new Date(item.file.lastModified).toISOString(), url: item.previewUrl,
  } }
}

interface DroppedEntry {
  isFile: boolean; isDirectory: boolean; name: string
  file(success: (file: File) => void, failure: (error: DOMException) => void): void
  createReader(): { readEntries(success: (entries: DroppedEntry[]) => void, failure: (error: DOMException) => void): void }
}

/** Read directory entries in batches; browsers can return only 100 per call. */
export async function chatDroppedFiles(data: DataTransfer): Promise<Array<{ directory: boolean; files: File[] }>> {
  // Snapshot the drop before any await: browsers protect the transfer after dispatch.
  const droppedFiles = Array.from(data.files)
  const roots = Array.from(data.items ?? []).filter(item => item.kind === 'file').map((item, index) => ({
    entry: item.webkitGetAsEntry?.() as DroppedEntry | null, file: item.getAsFile() ?? droppedFiles[index],
  }))
  if (!roots.length) return [{ directory: false, files: droppedFiles }]
  const collect = async (entry: DroppedEntry, parent: string, files: File[]): Promise<void> => {
    if (files.length >= 5000) throw new Error('A folder can contain at most 5000 files.')
    const path = `${parent}${entry.name}`
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject))
      Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
      files.push(file)
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      while (true) {
        const entries = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!entries.length) break
        for (const child of entries) await collect(child, `${path}/`, files)
      }
    }
  }
  const groups = []
  for (const root of roots) {
    if (root.entry?.isDirectory) { const files: File[] = []; await collect(root.entry, '', files); groups.push({ directory: true, files }) }
    else if (root.file) groups.push({ directory: false, files: [root.file] })
    else if (root.entry?.isFile) { const files: File[] = []; await collect(root.entry, '', files); groups.push({ directory: false, files }) }
  }
  return groups
}
