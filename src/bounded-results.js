import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import { digest, fault } from './workspace-files.js'

const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? 'null')
const segment = key => key.replaceAll('~', '~0').replaceAll('/', '~1')
export const responseBudget = args => Math.max(1024, Math.min(16384, Number.isSafeInteger(args?.maxBytes) ? args.maxBytes : 8192))

/** Bounded previews hold opaque references, never malformed or silently cut JSON. */
export class ResultViews {
  entries = new Map()
  bytes = 0
  key = randomBytes(32)
  cursor(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`
  }
  decodeCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw fault('invalid-cursor', 'Invalid query cursor.')
    const [body, signature] = cursor.split('.')
    if (signature !== createHmac('sha256', this.key).update(body).digest('base64url')) throw fault('invalid-cursor', 'Cursor expired or was modified. Restart the query.')
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()) } catch { throw fault('invalid-cursor', 'Invalid query cursor.') }
  }
  pack(value, scope, maxBytes = 8192) {
    // Match the HTTP JSON envelope. DSH's native tool registry rejects
    // undefined properties, even when the renderer would omit them.
    const wire = JSON.stringify(value) ?? 'null'
    const size = Buffer.byteLength(wire)
    if (size > 32 * 1024 * 1024) throw fault('result-too-large', 'Request a narrower projection.')
    const result = JSON.parse(wire)
    if (size <= maxBytes) return result
    const id = randomUUID()
    while (this.entries.size && (this.entries.size >= 32 || this.bytes + size > 64 * 1024 * 1024)) this.remove(this.entries.keys().next().value)
    this.entries.set(id, { value: result, scope, createdAt: Date.now(), size }); this.bytes += size
    return this.preview(result, id, '', maxBytes)
  }
  remove(id) { const entry = this.entries.get(id); if (entry) this.bytes -= entry.size; this.entries.delete(id) }
  reference(value, id, path, budget) {
    const reference = { kind: 'vd-result-reference', resultId: id, path, type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
      ...(Array.isArray(value) ? { count: value.length } : typeof value === 'string' ? { characters: value.length } : value && typeof value === 'object' ? { keys: Object.keys(value).slice(0, 5).map(key => key.slice(0, 80)), keyCount: Object.keys(value).length } : {}),
      read: 'read-result {resultId,path,offset?,limit?,fields?}' }
    while (reference.keys?.length && bytes(reference) > budget) reference.keys.pop()
    if (bytes(reference) > budget) throw fault('result-too-large', 'Increase maxBytes or request a shallower result path.')
    return reference
  }
  preview(value, id, path, budget) {
    if (bytes(value) <= budget) return value
    if (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length <= 30) {
      try {
        const projected = Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
          bytes(child) < 256 ? child : this.reference(child, id, `${path}/${segment(key)}`, budget)]))
        if (bytes(projected) <= budget) return projected
      } catch (error) { if (error.code !== 'video-director/result-too-large') throw error }
    }
    return this.reference(value, id, path, budget)
  }
  read(args, scope) {
    const entry = this.entries.get(args.resultId)
    if (!entry || Date.now() - entry.createdAt > 5 * 60_000) { this.remove(args.resultId); throw fault('result-expired', 'Result expired; repeat the original narrow query.') }
    if (entry.scope.projectId !== scope.projectId || entry.scope.sessionId !== scope.sessionId) throw fault('result-not-found', 'Result is not in this chat.')
    if (entry.scope.sensitive && !scope.allowContent) throw fault('content-not-shared', 'Workflow content sharing is disabled in the sidebar context settings.')
    if (entry.scope.draftRevision !== scope.draftRevision) throw fault('stale-cursor', 'The canvas changed. Repeat the query at its current revision.')
    let value = entry.value
    const path = args.path ?? ''
    if (typeof path !== 'string' || path.length > 2048 || (path && !path.startsWith('/'))) throw fault('invalid-query', 'Use a JSON pointer path from the result reference.')
    for (const key of path ? path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')) : []) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw fault('invalid-query', 'Unknown result field.')
      value = value[key]
    }
    const budget = responseBudget(args)
    const finish = value => {
      if (bytes(value) > budget) throw fault('result-too-large', 'Increase maxBytes or request a shallower result path.')
      return value
    }
    const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0)
    const limit = Math.max(1, Math.min(50, Number.isSafeInteger(args.limit) ? args.limit : 20))
    if (typeof value === 'string') {
      let text = value.slice(offset, offset + Math.min(value.length, budget))
      const result = () => ({ resultId: args.resultId, path, text, offset, offsetUnit: 'utf16', nextOffset: offset + text.length < value.length ? offset + text.length : null })
      finish({ ...result(), text: '' })
      while (bytes(result()) > budget) text = text.slice(0, Math.floor(text.length * .8))
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
      if (!text.length && offset < value.length) throw fault('result-too-large', 'Increase maxBytes or request a shallower result path.')
      return finish(result())
    }
    const keys = value && !Array.isArray(value) && typeof value === 'object' ? Object.keys(value) : null
    if (Array.isArray(value) || keys) {
      const selection = args.fields ?? (keys ?? value.map((_, index) => index)).slice(offset, offset + limit)
      if (!Array.isArray(selection) || selection.length > 50) throw fault('invalid-query', 'Choose at most 50 fields.')
      const items = []
      for (const key of selection) {
        if (!Object.hasOwn(value, key)) throw fault('invalid-query', 'Unknown result field.')
        const pointer = `${path}/${segment(String(key))}`
        items.push({ key, value: this.preview(value[key], args.resultId, pointer, Math.min(1024, budget / 2)) })
        if (bytes({ items, nextOffset: offset + items.length }) > budget - 256) { items.pop(); break }
      }
      if (!items.length && selection.length) throw fault('result-too-large', 'Request a narrower field with a shorter path.')
      return finish({ resultId: args.resultId, path, items, nextOffset: args.fields || offset + items.length >= (keys ?? value).length ? null : offset + items.length })
    }
    return { value }
  }
  query(project, args) {
    const graph = (project.draft ?? project).graph
    const revision = project.draftRevision
    const fields = args.fields ?? ['id', 'kind', 'title', 'status']
    if (!Array.isArray(fields) || !fields.length || fields.length > 20 || fields.some(field => typeof field !== 'string' || field.length > 128)) throw fault('invalid-query', 'Choose 1–20 node fields.')
    if (args.atDraftRevision !== undefined && args.atDraftRevision !== revision) throw fault('stale-cursor', 'The canvas revision changed.')
    const selector = args.selector ?? {}
    const ids = selector.ids ?? []
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw fault('invalid-query', 'Choose at most 50 node IDs.')
    const hops = selector.hops ?? 0
    if (!Number.isSafeInteger(hops) || hops < 0 || hops > 3) throw fault('invalid-query', 'Neighborhood depth must be 0–3.')
    const direction = selector.direction ?? 'both'
    if (!['upstream', 'downstream', 'both'].includes(direction)) throw fault('invalid-query', 'Choose upstream, downstream, or both.')
    const selected = new Set(ids)
    for (let hop = 0; hop < hops; hop++) {
      const previous = new Set(selected)
      for (const edge of graph.edges) {
        if (direction !== 'downstream' && previous.has(edge.target)) selected.add(edge.source)
        if (direction !== 'upstream' && previous.has(edge.source)) selected.add(edge.target)
      }
    }
    const rows = graph.nodes.filter(node => (!ids.length || selected.has(node.id)) && (!args.query || `${node.data.title} ${node.data.kind}`.toLowerCase().includes(String(args.query).toLowerCase())))
    const fingerprint = digest({ projectId: project.id, sessionId: project.sessionId, selector, fields, query: args.query })
    let offset = 0
    if (args.cursor) {
      const cursor = this.decodeCursor(args.cursor)
      if (cursor.fingerprint !== fingerprint || cursor.revision !== revision) throw fault('stale-cursor', 'Cursor scope, query, or revision changed.')
      offset = cursor.offset
    }
    const limit = Math.max(1, Math.min(50, Number.isSafeInteger(args.limit) ? args.limit : 20))
    const items = rows.slice(offset, offset + limit).map(node => Object.fromEntries(fields.map(field => {
      const key = field.startsWith('data.') ? field.slice(5) : field
      const value = field === 'id' || field === 'position' ? node[field] : Object.hasOwn(node.data, key) ? node.data[key] : undefined
      return [field, value ?? null]
    })))
    return { protocol: 'vd/1', draftRevision: revision, items, total: rows.length,
      nextCursor: offset + items.length < rows.length ? this.cursor({ fingerprint, revision, offset: offset + items.length }) : null }
  }
}
