import { type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { t, useLanguage } from './i18n'
import type { DirectorSnapshot, ProjectFolderChange, ProjectShortcut } from './types'
import { ProjectActionsMenu, type ProjectAction } from './ProjectActionsMenu'
import { ProjectFolderDialog, type FolderDialogAction } from './ProjectFolderDialog'
import { DEFAULT_PROJECT_FOLDERS, pickerDrop, pickerItems, pickerScrollSpeed, type PickerItem } from './project-folders'

type PickerProps = {
  snapshot: DirectorSnapshot
  disabled: boolean
  onRefresh(): void
  onSelectProject(id: string): Promise<void>
  onSelectExample(id: string): Promise<void>
  onProjectAction(id: string, action: ProjectAction): void
  onReorder(ids: string[]): void
  onOrganize?(change: ProjectFolderChange): Promise<void>
  onCreateWorkflow?(name: string, parentId: string | null, revision: number): Promise<void>
}

function MoreIcon() {
  return <svg className="vd-picker-more-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
}

export function ProjectPicker({ snapshot, disabled, onRefresh, onSelectProject, onSelectExample, onProjectAction, onReorder, onOrganize, onCreateWorkflow }: PickerProps) {
  useLanguage()
  const layout = snapshot.projectFolders ?? DEFAULT_PROJECT_FOLDERS
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set([DEFAULT_PROJECT_FOLDERS.examplesParentId!]))
  const [focused, setFocused] = useState(`folder:${layout.folders[0]?.id}`)
  const [rowMenu, setRowMenu] = useState<{ item: PickerItem | null; top: number } | null>(null)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState(() => new Set<string>())
  const [dialog, setDialog] = useState<FolderDialogAction | null>(null)
  const [dragging, setDragging] = useState<PickerItem | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; zone: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const tree = useRef<HTMLUListElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const drag = useRef<{ item: PickerItem; revision: number } | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const treeId = useId()
  const items = pickerItems(layout, snapshot.projects, snapshot.examples ?? [], expanded)
  const selectableItems = pickerItems(layout, snapshot.projects, []).filter((item): item is PickerItem & ProjectShortcut => item.kind !== 'example')
  const selectedItems = selectableItems.filter(item => selected.has(item.key))
  const unsavedCount = snapshot.projects.filter(project => project.unsaved).length
  const focus = (key: string): void => { setFocused(key); rows.current.get(key)?.focus() }
  const stopHover = (): void => { if (hover.current) clearTimeout(hover.current.timer); hover.current = null }
  const stopDrag = (): void => { drag.current = null; pointer.current = null; stopHover(); setDragging(null); setDropTarget(null) }
  const close = (): void => { stopDrag(); setOpen(false); setRowMenu(null); trigger.current?.focus() }
  const show = (): void => { setOpen(true); setFocused(items[0]?.key ?? ''); setNotice(null); onRefresh() }

  useEffect(() => {
    if (!open) return
    rows.current.get(items[0]?.key)?.focus()
    const outside = (event: PointerEvent | FocusEvent): void => {
      if (!(event.target instanceof Node)) return
      if (!root.current?.contains(event.target)) { setOpen(false); setRowMenu(null); stopDrag() }
      else if (event.type === 'pointerdown' && !menu.current?.contains(event.target) && !(event.target as HTMLElement).closest?.('.vd-project-row-more, .vd-project-batch-more')) setRowMenu(null)
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('focusin', outside, true)
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('focusin', outside, true) }
  }, [open])
  useEffect(() => { if (disabled) { setOpen(false); stopDrag() } }, [disabled])
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [rowMenu])
  useEffect(() => {
    if (!open || !dragging) return
    let frame = 0
    const track = (event: globalThis.DragEvent) => { pointer.current = { x: event.clientX, y: event.clientY } }
    const leave = (event: globalThis.DragEvent) => {
      if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) { pointer.current = null; stopHover() }
    }
    const tick = () => {
      const element = tree.current; const point = pointer.current
      if (element && point) {
        const box = element.getBoundingClientRect()
        if (point.x >= box.left - 12 && point.x <= box.right + 12) element.scrollTop += pickerScrollSpeed(point.y, box.top, box.bottom)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    window.addEventListener('dragover', track, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('dragend', stopDrag)
    window.addEventListener('blur', stopDrag)
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('dragover', track, true); window.removeEventListener('dragleave', leave, true); window.removeEventListener('dragend', stopDrag); window.removeEventListener('blur', stopDrag); stopHover() }
  }, [open, dragging])

  const toggle = (id: string, force?: boolean) => setExpanded(previous => {
    const next = new Set(previous)
    if (force ?? !next.has(id)) next.add(id); else next.delete(id)
    return next
  })
  const toggleSelected = (key: string): void => setSelected(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const choose = (item: PickerItem): void => {
    if (multiSelect) { if (item.kind !== 'example') toggleSelected(item.key); return }
    if (item.kind === 'folder') { toggle(item.id); focus(item.key); return }
    close()
    if (item.kind === 'example') void onSelectExample(item.id)
    else void onSelectProject(item.id)
  }
  const organize = async (change: ProjectFolderChange): Promise<void> => {
    if (!onOrganize) return
    setBusy(true)
    try { await onOrganize(change) }
    finally { setBusy(false) }
  }
  const applyMove = (source: PickerItem, target: PickerItem | null, fraction: number, revision: number): void => {
    const move = pickerDrop(layout, snapshot.projects, source, target, fraction)
    if (!move) return
    if (onOrganize) {
      const { zone: _, ...location } = move
      void organize({ action: 'move', ...location, expectedRevision: revision }).then(() => { if (move.parentId) toggle(move.parentId, true) }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
    } else if (source.kind === 'project') {
      const ids = snapshot.projects.map(row => row.id).filter(id => id !== source.id)
      ids.splice(move.beforeId ? ids.indexOf(move.beforeId) : ids.length, 0, source.id); onReorder(ids)
    }
  }
  const folderAction = (action: FolderDialogAction['action'], item?: PickerItem): void => {
    close()
    const creating = action === 'create' || action === 'create-workflow'
    setDialog({ action, kind: action === 'create-workflow' || item?.kind === 'project' ? 'project' : 'folder', id: creating ? undefined : item?.id,
      name: item?.name ?? '', parentId: creating ? item?.id ?? null : item?.parentId ?? null, revision: layout.revision })
  }
  const batchAction = (action: 'batch-move' | 'batch-delete'): void => {
    if (!selectedItems.length) return
    close()
    setDialog({ action, kind: 'folder', name: selectedItems.length === 1 ? selectedItems[0].name : '', parentId: null, revision: layout.revision,
      items: selectedItems.map(({ kind, id }) => ({ kind, id })) })
  }
  const keyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    event.stopPropagation()
    if ((event.target as HTMLElement).closest('button, input')) return
    const index = Math.max(0, items.findIndex(item => item.key === focused))
    const item = items[index]
    if (!item) return
    if (!multiSelect && event.altKey && item.kind !== 'example' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const siblings = pickerItems(layout, snapshot.projects, []).filter(row => row.kind === item.kind && row.parentId === item.parentId)
      const target = siblings[siblings.findIndex(row => row.key === item.key) + (event.key === 'ArrowDown' ? 1 : -1)]
      if (target) applyMove(item, target, event.key === 'ArrowDown' ? 1 : 0, layout.revision)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focus(items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].key)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focus(event.key === 'Home' ? items[0].key : items.at(-1)!.key)
    } else if (event.key === 'ArrowRight' && item.kind === 'folder') {
      event.preventDefault(); if (!expanded.has(item.id)) toggle(item.id, true); else if (items[index + 1]?.parentId === item.id) focus(items[index + 1].key)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (item.kind === 'folder' && expanded.has(item.id)) toggle(item.id, false); else if (item.parentId) focus(`folder:${item.parentId}`)
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(item) }
    else if (event.key === 'Escape') { event.preventDefault(); if (drag.current) stopDrag(); else close() }
  }
  const over = (event: DragEvent<HTMLElement>, target: PickerItem | null): void => {
    if (!drag.current) return
    event.stopPropagation()
    pointer.current = { x: event.clientX, y: event.clientY }
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = box.height ? (event.clientY - box.top) / box.height : event.clientY < 0 ? 0 : 1
    const move = pickerDrop(layout, snapshot.projects, drag.current.item, target, fraction)
    if (!move) { setDropTarget(null); stopHover(); return }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'
    setDropTarget({ key: target?.key ?? 'root', zone: move.zone })
    if (target?.kind === 'folder' && move.zone === 'inside' && !expanded.has(target.id)) {
      if (hover.current?.id !== target.id) { stopHover(); hover.current = { id: target.id, timer: setTimeout(() => toggle(target.id, true), 650) } }
    } else stopHover()
  }
  const drop = (event: DragEvent<HTMLElement>, target: PickerItem | null): void => {
    event.preventDefault(); event.stopPropagation()
    const source = drag.current
    const box = event.currentTarget.getBoundingClientRect()
    if (source) applyMove(source.item, target, box.height ? (event.clientY - box.top) / box.height : event.clientY < 0 ? 0 : 1, source.revision)
    stopDrag()
  }

  return <div ref={root} className="vd-project-picker">
    <button ref={trigger} type="button" className="vd-project-picker-trigger" aria-label={t('切换 Video Project')} aria-haspopup="tree" aria-expanded={open} aria-controls={open ? treeId : undefined} disabled={disabled}
      onClick={() => { if (open) close(); else show() }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } }}>
      <span className={`vd-project-picker-name${snapshot.dirty ? ' vd-project-unsaved' : ''}`}><span className="vd-project-name-text">{snapshot.project?.name ?? t('暂无工程')}</span>{snapshot.dirty ? <span className="vd-project-dirty-mark"> *</span> : null}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open ? <div className="vd-project-picker-popover">
      <div className="vd-project-picker-toolbar"><span>{t('Workflows')}</span><div className="vd-project-picker-tools">
        {multiSelect ? <button type="button" className="vd-project-batch-more" disabled={busy} aria-label={t('Batch operations')} title={t('Batch operations')} aria-haspopup="menu" aria-expanded={rowMenu?.item === null}
          onClick={() => setRowMenu(rowMenu?.item === null ? null : { item: null, top: 38 })}><MoreIcon /></button> : null}
        <button type="button" disabled={busy} aria-label={t('Multi-Select')} title={t('Multi-Select')} aria-pressed={multiSelect} onClick={() => { stopDrag(); setRowMenu(null); setSelected(new Set()); setMultiSelect(!multiSelect) }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="3" /><path d="m6 10 2.5 2.5L14 7" /></svg>
        </button>
        <button type="button" disabled={busy} onClick={() => folderAction('create')} aria-label={t('New Folder')} title={t('New Folder')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2ZM10 9v6M7 12h6" /></svg></button>
      </div></div>
      <ul ref={tree} id={treeId} role="tree" aria-label={t('Projects and examples')} aria-multiselectable={multiSelect || undefined} onKeyDown={keyDown} onDragOver={event => over(event, null)} onDrop={event => drop(event, null)} onScroll={() => setRowMenu(null)}>
        {items.map((item, index) => {
          const project = item.kind === 'project' ? snapshot.projects.find(row => row.id === item.id) : undefined
          const dropClass = dropTarget?.key === item.key ? ` vd-drop-${dropTarget.zone}` : ''
          const rootStart = item.parentId === null && item.kind !== 'folder' && (index === 0 || items[index - 1].kind === 'folder' || items[index - 1].parentId !== null)
          return <li key={item.key} role="treeitem" aria-label={item.kind === 'folder' ? `${item.name}/` : item.kind === 'example' ? t('Open example {0}', item.name) : item.name}
            aria-level={item.depth + 1} aria-expanded={item.kind === 'folder' ? expanded.has(item.id) : undefined} aria-selected={multiSelect && item.kind !== 'example' ? selected.has(item.key) : item.kind === 'project' ? item.id === snapshot.project?.id : undefined}
            className={`${rootStart ? 'vd-project-picker-first-project' : ''}${dropClass}`} data-picker-key={item.key}
            ref={element => { if (element) rows.current.set(item.key, element); else rows.current.delete(item.key) }} tabIndex={focused === item.key ? 0 : -1}
            onFocus={event => { event.stopPropagation(); setFocused(item.key) }} onClick={event => { event.stopPropagation(); choose(item) }}
            draggable={item.kind !== 'example' && !disabled && !busy && !multiSelect} title={multiSelect ? undefined : item.kind === 'example' ? t('Open as an editable project') : t('Drag to move, or use Alt+Up / Alt+Down to reorder')}
            onDragStart={event => {
              if (item.kind === 'example' || multiSelect) { event.preventDefault(); return }
              event.stopPropagation(); setRowMenu(null); drag.current = { item, revision: layout.revision }; setDragging(item)
              event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-vd-shortcut', item.key); event.dataTransfer.setData('text/plain', item.key)
            }} onDragOver={event => over(event, item)} onDragEnd={stopDrag} onDrop={event => drop(event, item)}>
            <div className={`vd-project-picker-row${item.kind === 'folder' ? ' vd-project-picker-folder' : ''}`} style={{ paddingLeft: 9 + item.depth * 18 }}>
              {item.kind === 'folder' ? <><button type="button" className="vd-project-folder-toggle" tabIndex={-1} aria-label={t(expanded.has(item.id) ? 'Collapse {0}' : 'Expand {0}', item.name)} onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); toggle(item.id) }}><svg className={expanded.has(item.id) ? 'is-expanded' : ''} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /></svg></>
                : item.kind === 'example' ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h7l4 4v12H5Zm7 0v5h4M8 11h5M8 14h5" /></svg> : <span className="vd-project-picker-check" aria-hidden="true">{item.id === snapshot.project?.id ? '✓' : ''}</span>}
              <span className={`vd-project-picker-name${project?.unsaved ? ' vd-project-unsaved' : ''}`}><span className="vd-project-name-text">{item.name}{item.kind === 'folder' ? '/' : ''}</span>{project?.unsaved ? <span className="vd-project-dirty-mark"> *</span> : null}</span>
              {item.kind !== 'example' && multiSelect ? <input type="checkbox" className="vd-project-row-select" aria-label={t(item.kind === 'folder' ? 'Select folder {0}' : 'Select workflow {0}', item.name)} checked={selected.has(item.key)} disabled={busy}
                onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onChange={() => toggleSelected(item.key)} /> : item.kind !== 'example' ? <button type="button" className="vd-project-row-more" aria-label={t(item.kind === 'folder' ? 'Folder actions for {0}' : 'Actions for {0}', item.name)} aria-haspopup="menu" aria-expanded={rowMenu?.item?.key === item.key} draggable={false}
                onDragStart={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()} onClick={event => {
                  event.stopPropagation(); const box = event.currentTarget.closest('.vd-project-picker-popover')!.getBoundingClientRect()
                  const top = Math.max(4, Math.min(event.currentTarget.getBoundingClientRect().bottom - box.top, box.height - (item.kind === 'folder' ? 208 : 244)))
                  setRowMenu(rowMenu?.item?.key === item.key ? null : { item, top })
                }}><MoreIcon /></button> : null}
            </div>
          </li>
        })}
        {snapshot.examplesLoading ? <li role="none" className="vd-project-picker-note">{t('Loading examples…')}</li> : null}
        {snapshot.examplesError ? <li role="none" className="vd-project-picker-note">{t('Could not load examples. Reopen this list to retry.')}</li> : null}
        <li role="none" className={`vd-project-root-drop${dropTarget?.key === 'root' ? ' vd-drop-inside' : ''}`} onDragOver={event => over(event, null)} onDrop={event => drop(event, null)} title={t('Root folder')}>/{dragging ? <small>{t('Drop here to move to the top level')}</small> : null}</li>
      </ul>
      <div className="vd-project-picker-hint" role={notice ? 'alert' : 'status'}>{notice ?? (multiSelect ? t('{0} selected', selectedItems.length) : unsavedCount === 1 ? t('1 unsaved workflow') : t('{0} unsaved workflows', unsavedCount))}</div>
      {rowMenu ? <div ref={menu} className="vd-project-row-menu" style={{ top: rowMenu.top }} onKeyDown={event => {
        event.stopPropagation()
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'Escape') { event.preventDefault(); setRowMenu(null); if (rowMenu.item) focus(rowMenu.item.key); else root.current?.querySelector<HTMLButtonElement>('.vd-project-batch-more')?.focus() }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus() }
      }}>
        {rowMenu.item === null ? <div className="vd-project-menu" role="menu" aria-label={t('Batch operations')}>
          {(['Select all', 'Deselect all', 'Invert selection'] as const).map(label => <button key={label} type="button" role="menuitem" disabled={busy} onClick={() => {
            setSelected(new Set(label === 'Deselect all' ? [] : selectableItems.filter(item => label === 'Select all' || !selected.has(item.key)).map(item => item.key))); setRowMenu(null)
          }}>{t(label)}</button>)}
          <button type="button" role="menuitem" disabled={busy || !selectedItems.length} onClick={() => batchAction('batch-move')}>{t('Move to…')}</button>
          <button type="button" role="menuitem" className="vd-project-delete" disabled={busy || !selectedItems.length} onClick={() => batchAction('batch-delete')}>{t('Delete')}</button>
        </div> : rowMenu.item.kind === 'folder' ? <div className="vd-project-menu" role="menu" aria-label={t('Folder menu')}>
          {([['create-workflow', 'New Workflow'], ['create', 'New Folder'], ['move', 'Move to…'], ['rename', 'Rename Folder'], ['delete', 'Delete Folder']] as const).map(([action, label]) => <button key={action} type="button" role="menuitem" disabled={busy} className={action === 'delete' ? 'vd-project-delete' : ''} onClick={() => folderAction(action, rowMenu.item!)}>{t(label)}</button>)}
        </div> : <ProjectActionsMenu hasProject disabled={disabled || busy} includeMove busy={snapshot.projects.find(project => project.id === rowMenu.item?.id)?.status === 'running'}
          onAction={action => { const item = rowMenu.item!; if (action === 'move') folderAction('move', item); else { close(); onProjectAction(item.id, action) } }} />}
      </div> : null}
    </div> : null}
    {dialog ? <ProjectFolderDialog value={dialog} layout={layout} snapshot={snapshot} onSubmit={async change => {
      await organize(change)
      if ((change.action === 'create' || change.action === 'move' || change.action === 'batch-move') && change.parentId) toggle(change.parentId, true)
      if (change.action === 'batch-move' || change.action === 'batch-delete') setSelected(new Set())
    }} onCreateWorkflow={onCreateWorkflow ? async (name, parentId, revision) => { await onCreateWorkflow(name, parentId, revision); if (parentId) toggle(parentId, true) } : undefined} onClose={() => { setDialog(null); trigger.current?.focus() }} /> : null}
  </div>
}
