import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { supportsAssetMimeType } from './project-store.js'
import { DirectorInputError, record, string, uuid } from './validation.js'

const labels = { image: 'Image', audio: 'Audio', video: 'Video', folder: 'Folder', node: 'Node' }
const textFile = file => file.mimeType?.startsWith('text/') || /\.(txt|md|markdown|csv|json|srt|vtt|log)$/i.test(file.name)

/** Draft aliases stay compact; published aliases keep their historical meaning. */
function compactDraftAliases(state) {
  let changed = false
  state.entries = state.entries.filter(entry => {
    if (entry.hidden && !entry.sent) { changed = true; return false }
    return true
  })
  const used = new Set(state.entries.filter(entry => entry.sent).map(entry => entry.alias))
  const next = {}
  for (const entry of state.entries) {
    if (entry.sent) continue
    let index = next[entry.kind] ?? 1
    while (used.has(`<${labels[entry.kind]} ${index}>`)) index++
    const alias = `<${labels[entry.kind]} ${index}>`
    if (entry.alias !== alias) { entry.alias = alias; changed = true }
    used.add(alias); next[entry.kind] = index + 1
  }
  return changed
}

/** Durable, session-scoped references. Manifests contain metadata, never file bytes. */
export class ChatReferences {
  constructor(store, registerAsset) { this.store = store; this.registerAsset = registerAsset; this.tails = new Map() }
  async withSession(projectId, sessionId, operation) {
    const project = await this.store.getProject(uuid(projectId, 'projectId'))
    if (project.sessionId !== sessionId) throw new DirectorInputError('Reference belongs to a different chat session')
    const directory = join(this.store.projectsDir, projectId, 'chat', createHash('sha256').update(sessionId).digest('hex'))
    const previous = this.tails.get(directory) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true })
      let state
      try { state = JSON.parse(await readFile(join(directory, 'references.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { entries: [] } }
      let changed = false
      const result = await operation(state, directory, () => { changed = true })
      if (changed) {
        const temporary = join(directory, `${randomUUID()}.tmp`)
        await writeFile(temporary, JSON.stringify(state)); await rename(temporary, join(directory, 'references.json'))
      }
      return structuredClone(result)
    })
    this.tails.set(directory, pending)
    try { return await pending } finally { if (this.tails.get(directory) === pending) this.tails.delete(directory) }
  }
  async call(input) {
    return this.withSession(input.projectId, input.sessionId, async (state, directory, changed) => {
      if (compactDraftAliases(state)) changed()
      if (input.action === 'list') return { entries: state.entries.filter(item => !item.hidden) }
      if (input.action === 'reserve') {
        const id = uuid(input.id, 'reference id')
        const old = state.entries.find(item => item.id === id)
        if (old) return { entry: old }
        if (state.entries.length >= 5000) throw new DirectorInputError('A chat can contain at most 5000 attachments')
        const kind = input.kind
        if (!Object.hasOwn(labels, kind)) throw new DirectorInputError('Unsupported attachment kind')
        const name = string(input.name, 'name', { min: 1, max: 240 })
        const entry = { id, kind, name, projectId: input.projectId, alias: '', ready: kind === 'node' }
        if (kind === 'node') {
          entry.nodeId = string(input.nodeId, 'nodeId', { min: 1, max: 256 })
          const project = await this.store.getProject(input.projectId)
          if (!(project.draft?.graph ?? project.graph).nodes.some(node => node.id === entry.nodeId)) throw new DirectorInputError('Node no longer exists')
        } else {
          if (!Array.isArray(input.files) || input.files.length > 5000 || (kind !== 'folder' && input.files.length !== 1)) throw new DirectorInputError('Invalid attachment manifest')
          entry.files = input.files.map(file => {
            record(file, 'file')
            if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.store.maxAssetBytes) throw new DirectorInputError('Attachment exceeds the file size limit')
            return { name: string(file.name, 'filename', { min: 1, max: 240 }), path: string(file.path ?? file.name, 'relative path', { min: 1, max: 2048 }),
              mimeType: string(file.mimeType || 'application/octet-stream', 'mimeType', { max: 128 }), size: file.size }
          })
          entry.ready = entry.files.length === 0
        }
        state.entries.push(entry); compactDraftAliases(state); changed(); return { entry }
      }
      const entry = state.entries.find(item => item.id === input.id)
      if (!entry) throw new DirectorInputError('Unknown attachment')
      if (input.action === 'sent') { entry.sent = true; changed(); return { entry } }
      if (input.action === 'hide') {
        entry.hidden = true; compactDraftAliases(state); changed()
        return { entries: state.entries.filter(item => !item.hidden) }
      }
      if (input.action !== 'upload') throw new DirectorInputError('Unknown reference action')
      const file = entry.files?.[input.fileIndex]
      if (!file || !Number.isSafeInteger(input.fileIndex)) throw new DirectorInputError('Invalid file index')
      const receipt = () => {
        const { files: _files, ...metadata } = entry
        return { entry: metadata, fileIndex: input.fileIndex, file }
      }
      if (file.uploaded) return receipt()
      const encoded = string(input.dataBase64, 'dataBase64', { trim: false, max: Math.ceil(this.store.maxAssetBytes * 4 / 3) + 8 })
      const data = Buffer.from(encoded, 'base64')
      if (data.length !== file.size || data.toString('base64') !== encoded) throw new DirectorInputError('File size or encoding does not match its manifest')
      const kind = file.mimeType.split('/')[0]
      if (['image', 'audio', 'video'].includes(kind) && supportsAssetMimeType(kind, file.mimeType)) {
        const asset = await this.store.putAsset({ projectId: input.projectId, kind, name: file.name, mimeType: file.mimeType, dataBase64: encoded })
        await this.registerAsset(asset)
        file.assetId = asset.id
        if (entry.kind !== 'folder') entry.asset = asset
      } else {
        await writeFile(join(directory, `${entry.id}-${input.fileIndex}.bin`), data)
      }
      file.uploaded = true
      entry.ready = entry.files.every(file => file.uploaded)
      changed(); return receipt()
    })
  }
  async query(projectId, sessionId, alias) {
    return this.withSession(projectId, sessionId, state => {
      if (alias === undefined) return state.entries.map(({ alias, kind, name, ready, nodeId, files }) => ({ alias, kind, name, ready, nodeId, fileCount: files?.length }))
      const entry = state.entries.find(item => item.alias === alias)
      if (!entry) throw new DirectorInputError('Unknown chat alias')
      return entry
    })
  }
  async readText(projectId, sessionId, alias, index, offset = 0, limit = 8000) {
    return this.withSession(projectId, sessionId, async (state, directory) => {
      const entry = state.entries.find(item => item.alias === alias)
      const file = entry?.files?.[index]
      if (!file?.uploaded || !textFile(file)) throw new DirectorInputError('Choose an uploaded text file')
      if (file.size > 2 * 1024 * 1024) throw new DirectorInputError('Text inspection is limited to files up to 2 MB')
      const text = await readFile(join(directory, `${entry.id}-${index}.bin`), 'utf8')
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      const size = Math.max(1, Math.min(16000, Number.isSafeInteger(limit) ? limit : 8000))
      return { name: file.name, text: text.slice(start, start + size), nextOffset: start + size < text.length ? start + size : null }
    })
  }
}
