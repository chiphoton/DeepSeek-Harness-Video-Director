import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DirectorInputError, oneOf, string, uuid } from './validation.js'

export const EXAMPLES_FOLDER_ID = '00000000-0000-4000-8000-000000000001'
export const emptyProjectFolders = () => ({ version: 1, revision: 1,
  folders: [{ id: EXAMPLES_FOLDER_ID, name: 'examples', parentId: null }],
  projectParents: {}, projectOrder: [], examplesParentId: EXAMPLES_FOLDER_ID })

function folder(layout, id) {
  const found = layout.folders.find(item => item.id === uuid(id, 'folderId'))
  if (!found) throw new DirectorInputError('Folder no longer exists. Refresh the project list.')
  return found
}
function parent(layout, id) { return id === null ? null : folder(layout, id).id }
function descendants(layout, id) {
  const ids = new Set([id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of layout.folders) if (ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true }
  }
  return ids
}
function nameFor(layout, name, parentId, exceptId) {
  const result = string(name, 'folder name', { min: 1, max: 120 })
  if (/[/\\\x00-\x1f]/u.test(result) || result === '.' || result === '..') throw new DirectorInputError('Enter a folder name without slashes or control characters.')
  if (layout.folders.some(item => item.id !== exceptId && item.parentId === parentId && item.name.normalize('NFC').toLowerCase() === result.normalize('NFC').toLowerCase())) {
    throw new DirectorInputError('A folder with this name already exists in that location.')
  }
  return result
}
function selectionIds(values, label, exists) {
  if (!Array.isArray(values) || values.length > 10000) throw new DirectorInputError(`Invalid ${label} selection.`)
  const ids = values.map(id => uuid(id, label))
  if (new Set(ids).size !== ids.length || ids.some(id => !exists(id))) throw new DirectorInputError(`The ${label} selection changed. Refresh the list and try again.`)
  return ids
}
function moveShortcut(layout, projects, input) {
  const parentId = parent(layout, input.parentId)
  const kind = oneOf(input.kind, 'item kind', ['folder', 'project'])
  const id = uuid(input.id, 'itemId')
  const beforeId = input.beforeId == null ? null : uuid(input.beforeId, 'beforeId')
  if (id === beforeId) throw new DirectorInputError('An item cannot be moved before itself.')
  if (kind === 'folder') {
    const item = folder(layout, id)
    if (descendants(layout, id).has(parentId)) throw new DirectorInputError('A folder cannot be moved into itself or a subfolder.')
    nameFor(layout, item.name, parentId, id)
    if (beforeId && folder(layout, beforeId).parentId !== parentId) throw new DirectorInputError('The destination order changed. Try again.')
    item.parentId = parentId
    layout.folders = layout.folders.filter(row => row.id !== id)
    layout.folders.splice(beforeId ? layout.folders.findIndex(row => row.id === beforeId) : layout.folders.length, 0, item)
  } else {
    if (!projects.some(project => project.id === id)) throw new DirectorInputError('Workflow no longer exists.')
    if (beforeId && (!projects.some(project => project.id === beforeId) || (layout.projectParents[beforeId] ?? null) !== parentId)) throw new DirectorInputError('The destination order changed. Try again.')
    layout.projectParents[id] = parentId
    const ranks = new Map(layout.projectOrder.map((id, i) => [id, i]))
    const order = [...projects].sort((a, b) => (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1) || b.updatedAt.localeCompare(a.updatedAt)).map(row => row.id).filter(candidate => candidate !== id)
    order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, id)
    layout.projectOrder = order
  }
}
function validate(layout) {
  if (layout.version !== 1 || !Number.isSafeInteger(layout.revision) || layout.revision < 1
    || !Array.isArray(layout.folders) || layout.folders.length > 1000 || !Array.isArray(layout.projectOrder)
    || !layout.projectParents || typeof layout.projectParents !== 'object' || Array.isArray(layout.projectParents)) throw new DirectorInputError('Invalid project folder index.')
  if (new Set(layout.folders.map(item => item.id)).size !== layout.folders.length) throw new DirectorInputError('Duplicate folder IDs.')
  for (const item of layout.folders) {
    uuid(item.id, 'folderId'); parent(layout, item.parentId); nameFor(layout, item.name, item.parentId, item.id)
    const seen = new Set([item.id]); let next = item.parentId
    while (next !== null) {
      if (seen.has(next) || seen.size > 32) throw new DirectorInputError('Folders cannot contain themselves or exceed 32 levels.')
      seen.add(next); next = folder(layout, next).parentId
    }
  }
  for (const [id, parentId] of Object.entries(layout.projectParents)) { uuid(id, 'projectId'); parent(layout, parentId) }
  layout.projectOrder.forEach(id => uuid(id, 'projectId'))
  if (new Set(layout.projectOrder).size !== layout.projectOrder.length) throw new DirectorInputError('Duplicate workflow order entries.')
  parent(layout, layout.examplesParentId)
  return layout
}

/** Virtual membership only. No workflow or media path is derived from a folder. */
export class ProjectFolders {
  constructor(root) { this.path = join(root, 'project-folders.json'); this.root = root; this.tail = Promise.resolve() }
  async init() {
    try { this.value = validate(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const value = emptyProjectFolders()
      try { value.projectOrder = JSON.parse(await readFile(join(this.root, 'project-order.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await this.write(validate(value)); this.value = value
    }
  }
  snapshot() { return structuredClone(this.value) }
  sort(projects) {
    const ranks = new Map(this.value.projectOrder.map((id, i) => [id, i]))
    return [...projects].sort((a, b) => (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1) || b.updatedAt.localeCompare(a.updatedAt))
  }
  async write(value) {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, this.path) }
    finally { await rm(temporary, { force: true }) }
  }
  async change(input, projects, effect = async (_ids, commit) => commit()) {
    const operation = this.tail.then(async () => {
      if (input.expectedRevision !== this.value.revision) throw Object.assign(new Error('Folders changed in another tab. Review the updated list and try again.'), { code: 'video-director/folder-conflict' })
      const next = this.snapshot()
      const projectIds = projects.map(item => item.id)
      let deletedProjectIds = []
      const action = oneOf(input.action, 'folder action', ['create', 'rename', 'move', 'delete', 'batch-move', 'batch-delete', 'reorder'])
      if (action === 'create') {
        const parentId = parent(next, input.parentId)
        next.folders.push({ id: randomUUID(), parentId, name: nameFor(next, input.name, parentId) })
      } else if (action === 'rename') {
        const item = folder(next, input.id)
        item.name = nameFor(next, input.name, item.parentId, item.id)
      } else if (action === 'move') {
        moveShortcut(next, projects, input)
      } else if (action === 'batch-move') {
        if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 10000) throw new DirectorInputError('Select items to move.')
        for (const item of input.items) oneOf(item?.kind, 'item kind', ['folder', 'project'])
        const folderIds = selectionIds(input.items.filter(item => item.kind === 'folder').map(item => item.id), 'folder', id => next.folders.some(f => f.id === id))
        const selectedProjects = selectionIds(input.items.filter(item => item.kind === 'project').map(item => item.id), 'workflow', id => projectIds.includes(id))
        const covered = new Set(folderIds.flatMap(id => [...descendants(next, id)]))
        const parentId = parent(next, input.parentId)
        if (covered.has(parentId)) throw new DirectorInputError('A folder cannot be moved into itself or a subfolder.')
        // Selected descendants travel with their selected ancestor, preserving nesting.
        const roots = next.folders.filter(item => folderIds.includes(item.id) && !covered.has(item.parentId))
        const looseProjects = this.sort(projects).filter(item => selectedProjects.includes(item.id) && !covered.has(next.projectParents[item.id]))
        for (const item of roots) moveShortcut(next, projects, { kind: 'folder', id: item.id, parentId })
        for (const item of looseProjects) moveShortcut(next, projects, { kind: 'project', id: item.id, parentId })
      } else if (action === 'delete' || action === 'batch-delete') {
        const folderIds = action === 'delete' ? [folder(next, input.id).id]
          : selectionIds(input.folderIds, 'folder', id => next.folders.some(item => item.id === id))
        const selectedProjects = action === 'delete' ? [] : selectionIds(input.projectIds, 'workflow', id => projectIds.includes(id))
        if (folderIds.length + selectedProjects.length === 0) throw new DirectorInputError('Select items to delete.')
        const mode = oneOf(input.mode, 'delete mode', ['keep-workflows', 'delete-workflows'])
        const removed = new Set(folderIds.flatMap(id => [...descendants(next, id)]))
        const contained = projectIds.filter(id => removed.has(next.projectParents[id]))
        deletedProjectIds = [...new Set([...selectedProjects, ...(mode === 'delete-workflows' ? contained : [])])]
        for (const [id, parentId] of Object.entries(next.projectParents)) if (removed.has(parentId) || deletedProjectIds.includes(id)) delete next.projectParents[id]
        next.folders = next.folders.filter(item => !removed.has(item.id))
        next.projectOrder = next.projectOrder.filter(id => !deletedProjectIds.includes(id))
        // Bundled examples remain read-only templates and stay accessible at root.
        if (removed.has(next.examplesParentId)) next.examplesParentId = null
      } else {
        if (!Array.isArray(input.projectIds) || new Set(input.projectIds).size !== input.projectIds.length
          || input.projectIds.some(id => !projectIds.includes(id))) throw new DirectorInputError('Cannot reorder an unknown workflow.')
        next.projectOrder = [...input.projectIds, ...projectIds.filter(id => !input.projectIds.includes(id))]
      }
      next.revision++
      validate(next)
      await effect(deletedProjectIds, async () => { await this.write(next); this.value = next })
      return { projectFolders: this.snapshot(), deletedProjectIds }
    })
    this.tail = operation.catch(() => {})
    return operation
  }
}
