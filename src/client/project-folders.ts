import type { ProjectFolderLayout, ProjectSummary } from './types'

export const DEFAULT_PROJECT_FOLDERS: ProjectFolderLayout = { version: 1, revision: 1,
  folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'examples', parentId: null }],
  projectParents: {}, projectOrder: [], examplesParentId: '00000000-0000-4000-8000-000000000001' }
export type PickerItem = { kind: 'folder' | 'project' | 'example'; id: string; name: string; parentId: string | null; depth: number; key: string }
export type PickerMove = { kind: 'folder' | 'project'; id: string; parentId: string | null; beforeId: string | null }

export function folderDescendants(layout: ProjectFolderLayout, id: string): Set<string> {
  const result = new Set([id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of layout.folders) if (item.parentId && result.has(item.parentId) && !result.has(item.id)) { result.add(item.id); changed = true }
  }
  return result
}

export function pickerItems(layout: ProjectFolderLayout, projects: ProjectSummary[], examples: Array<{ id: string; name: string }>, expanded?: Set<string>): PickerItem[] {
  const result: PickerItem[] = []
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of layout.folders.filter(row => row.parentId === parentId)) {
      result.push({ ...folder, kind: 'folder', depth, key: `folder:${folder.id}` })
      if (!expanded || expanded.has(folder.id)) visit(folder.id, depth + 1)
    }
    if (layout.examplesParentId === parentId) for (const example of examples) result.push({ ...example, kind: 'example', parentId, depth, key: `example:${example.id}` })
    for (const project of projects.filter(row => (layout.projectParents[row.id] ?? null) === parentId)) result.push({ id: project.id, name: project.name, kind: 'project', parentId, depth, key: `project:${project.id}` })
  }
  visit(null, 0)
  return result
}

export function folderPath(layout: ProjectFolderLayout, id: string): string {
  const names: string[] = []
  let current: string | null = id
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder = layout.folders.find(row => row.id === current)
    if (!folder) break
    names.unshift(folder.name); current = folder.parentId
  }
  return names.join('/')
}

export function pickerDrop(layout: ProjectFolderLayout, projects: ProjectSummary[], source: PickerItem, target: PickerItem | null, fraction = .5): (PickerMove & { zone: 'inside' | 'before' | 'after' }) | null {
  if (source.kind === 'example' || source.key === target?.key || target?.kind === 'example') return null
  const zone = target?.kind === 'folder' && (source.kind === 'project' || (fraction >= .25 && fraction <= .75)) ? 'inside' : fraction < .5 ? 'before' : 'after'
  const parentId = target ? zone === 'inside' ? target.id : target.parentId : null
  if (source.kind === 'folder' && parentId && folderDescendants(layout, source.id).has(parentId)) return null
  let beforeId: string | null = null
  if (target && zone !== 'inside' && source.kind === target.kind) {
    const siblings = source.kind === 'folder' ? layout.folders.filter(row => row.parentId === parentId && row.id !== source.id)
      : projects.filter(row => (layout.projectParents[row.id] ?? null) === parentId && row.id !== source.id)
    const index = siblings.findIndex(row => row.id === target.id)
    beforeId = siblings[index + (zone === 'after' ? 1 : 0)]?.id ?? null
  }
  return { kind: source.kind, id: source.id, parentId, beforeId, zone: target ? zone : 'inside' }
}

export function pickerScrollSpeed(y: number, top: number, bottom: number): number {
  const edge = Math.min(48, (bottom - top) / 3)
  if (y < top - 12 || y > bottom + 12 || edge <= 0) return 0
  if (y < top + edge) return -Math.ceil(16 * Math.min(1, (top + edge - y) / edge))
  if (y > bottom - edge) return Math.ceil(16 * Math.min(1, (y - bottom + edge) / edge))
  return 0
}
