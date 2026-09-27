import { useRef, useState } from 'react'
import { t } from './i18n'
import { folderDescendants, pickerItems } from './project-folders'
import type { ProjectFolderLayout } from './types'

/** A directory-only destination picker; the empty key represents virtual root. */
export function FolderDestinationTree({ layout, excluded, value, disabled, onChange }: {
  layout: ProjectFolderLayout; excluded: Set<string>; value: string | null; disabled: boolean
  onChange(value: string | null): void
}) {
  const [expanded, setExpanded] = useState(() => {
    const ids = new Set([''])
    let current = value
    while (current) { ids.add(current); current = layout.folders.find(folder => folder.id === current)?.parentId ?? null }
    return ids
  })
  const [focused, setFocused] = useState(value ?? '')
  const rows = useRef(new Map<string, HTMLLIElement>())
  const folders = pickerItems(layout, [], [], expanded).filter(item => !excluded.has(item.id)).map(item => ({ ...item, depth: item.depth + 1, parentId: item.parentId ?? '' }))
  const items = [{ id: '', name: '/', parentId: null, depth: 0 }, ...(expanded.has('') ? folders : [])]
  const toggle = (id: string) => {
    if (expanded.has(id) && (id === '' || folderDescendants(layout, id).has(focused))) focus(id)
    setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const focus = (id: string) => { setFocused(id); rows.current.get(id)?.focus() }
  const hasChildren = (id: string) => layout.folders.some(folder => (folder.parentId ?? '') === id && !excluded.has(folder.id))
  return <ul className="vd-folder-destination-tree" role="tree" aria-label={t('Destination')} aria-disabled={disabled} onKeyDown={event => {
    if (disabled) return
    const index = Math.max(0, items.findIndex(item => item.id === focused)); const item = items[index]
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); focus(items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].id)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focus(items[event.key === 'Home' ? 0 : items.length - 1].id)
    } else if (event.key === 'ArrowRight' && hasChildren(item.id)) {
      event.preventDefault(); if (!expanded.has(item.id)) toggle(item.id); else if (items[index + 1]) focus(items[index + 1].id)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (hasChildren(item.id) && expanded.has(item.id)) toggle(item.id); else if (item.parentId !== null) focus(item.parentId)
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChange(item.id || null) }
  }}>
    {items.map(item => <li key={item.id} ref={element => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id) }} role="treeitem" aria-label={item.name}
      aria-level={item.depth + 1} aria-selected={(value ?? '') === item.id} aria-expanded={hasChildren(item.id) ? expanded.has(item.id) : undefined}
      tabIndex={!disabled && focused === item.id ? 0 : -1} onFocus={() => setFocused(item.id)} onClick={() => { if (!disabled) { focus(item.id); onChange(item.id || null) } }}
      style={{ paddingLeft: 8 + item.depth * 18 }}>
      {hasChildren(item.id) ? <button type="button" tabIndex={-1} disabled={disabled} aria-label={t(expanded.has(item.id) ? 'Collapse {0}' : 'Expand {0}', item.name)}
        onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); toggle(item.id) }}><svg className={expanded.has(item.id) ? 'is-expanded' : ''} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button> : <span className="vd-folder-tree-spacer" />}
      <svg className="vd-folder-tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /></svg><span>{item.name}</span>
    </li>)}
  </ul>
}
