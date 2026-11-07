import { digest } from './workspace-files.js'

export const draftOf = project => structuredClone(project.draft ?? {
  name: project.name, graph: project.graph, settings: project.settings,
  ...(project.mediaLibrary === undefined ? {} : { mediaLibrary: project.mediaLibrary }),
})

// Layout undo should survive framing or panning; the viewport is not part of a layout edit.
export const operationDigest = (draft, kind) => digest(kind === 'layout'
  ? { ...draft, graph: { ...draft.graph, viewport: null } }
  : draft)

export function changeSummary(before, after) {
  const changes = { added: [], removed: [], updated: [], edgesAdded: [], edgesRemoved: [], edgesUpdated: [], fields: [] }
  for (const [field, added, removed, updated] of [['nodes', 'added', 'removed', 'updated'], ['edges', 'edgesAdded', 'edgesRemoved', 'edgesUpdated']]) {
    const old = new Map(before.graph[field].map(row => [row.id, row]))
    const next = new Map(after.graph[field].map(row => [row.id, row]))
    for (const [id, row] of next) {
      if (!old.has(id)) changes[added].push(id)
      else if (digest(old.get(id)) !== digest(row)) changes[updated].push(id)
    }
    for (const id of old.keys()) if (!next.has(id)) changes[removed].push(id)
  }
  for (const field of ['name', 'settings', 'mediaLibrary']) if (digest(before[field] ?? null) !== digest(after[field] ?? null)) changes.fields.push(field)
  if (digest(before.graph.viewport) !== digest(after.graph.viewport)) changes.fields.push('viewport')
  return changes
}

export function receipt(row) {
  const { before, inverse, afterDigest, requestHash, parent, ...rest } = row
  return rest
}

export function inverseDraft(before, changes) {
  const restore = field => {
    const changed = new Set(field === 'nodes' ? [...changes.updated, ...changes.removed] : [...changes.edgesUpdated, ...changes.edgesRemoved])
    return { order: before.graph[field].map(row => row.id), rows: before.graph[field].filter(row => changed.has(row.id)) }
  }
  return { nodes: restore('nodes'), edges: restore('edges'), fields: Object.fromEntries(changes.fields.filter(field => field !== 'viewport').map(field => [field, before[field] ?? null])),
    ...(changes.fields.includes('viewport') ? { viewport: before.graph.viewport } : {}) }
}

export function applyInverse(draft, inverse) {
  const next = structuredClone(draft)
  for (const field of ['nodes', 'edges']) {
    const rows = new Map([...next.graph[field], ...inverse[field].rows].map(row => [row.id, row]))
    next.graph[field] = inverse[field].order.map(id => rows.get(id))
    if (next.graph[field].some(row => !row)) throw new Error('Undo history is incomplete.')
  }
  for (const [field, value] of Object.entries(inverse.fields)) { if (value === null) delete next[field]; else next[field] = value }
  if (inverse.viewport) next.graph.viewport = inverse.viewport
  return next
}
