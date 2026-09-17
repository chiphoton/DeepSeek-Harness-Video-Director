import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { t, useLanguage } from './i18n'
import type { DirectorSnapshot } from './types'
import { ProjectActionsMenu, type ProjectAction } from './ProjectActionsMenu'

type PickerProps = {
  snapshot: DirectorSnapshot
  disabled: boolean
  onRefresh(): void
  onSelectProject(id: string): Promise<void>
  onSelectExample(id: string): Promise<void>
  onProjectAction(id: string, action: ProjectAction): void
  onReorder(ids: string[]): void
}

export function ProjectPicker({ snapshot, disabled, onRefresh, onSelectProject, onSelectExample, onProjectAction, onReorder }: PickerProps) {
  useLanguage()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [focused, setFocused] = useState('examples')
  const [rowMenu, setRowMenu] = useState<{ id: string; top: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const treeId = useId()
  const examplesId = `${treeId}-examples`
  const examples = snapshot.examples ?? []
  const unsavedCount = snapshot.projects.filter(project => project.unsaved).length
  const visible = ['examples', ...(expanded ? examples.map(example => `example:${example.id}`) : []), ...snapshot.projects.map(project => `project:${project.id}`)]
  const focus = (key: string): void => { setFocused(key); rows.current.get(key)?.focus() }
  const close = (): void => { setOpen(false); setRowMenu(null); trigger.current?.focus() }
  const show = (): void => { setOpen(true); setFocused('examples'); onRefresh() }

  useEffect(() => {
    if (!open) return
    rows.current.get('examples')?.focus()
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setRowMenu(null) }
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const choose = (key: string): void => {
    if (key === 'examples') { setExpanded(value => !value); focus(key); return }
    close()
    if (key.startsWith('example:')) void onSelectExample(key.slice('example:'.length))
    else void onSelectProject(key.slice('project:'.length))
  }
  const keyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    // Tree navigation must not reach canvas shortcuts (for example Delete or Space).
    event.stopPropagation()
    if ((event.target as HTMLElement).closest('button')) return
    const index = Math.max(0, visible.indexOf(focused))
    if (event.altKey && focused.startsWith('project:') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const ids = snapshot.projects.map(project => project.id)
      const from = ids.indexOf(focused.slice('project:'.length))
      const to = Math.max(0, Math.min(ids.length - 1, from + (event.key === 'ArrowDown' ? 1 : -1)))
      if (from !== to) { ids.splice(to, 0, ...ids.splice(from, 1)); onReorder(ids) }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focus(visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))])
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focus(event.key === 'Home' ? visible[0] : visible[visible.length - 1])
    } else if (event.key === 'ArrowRight' && focused === 'examples') {
      event.preventDefault()
      if (expanded && examples.length > 0) focus(`example:${examples[0].id}`)
      else setExpanded(true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (focused === 'examples') setExpanded(false)
      else if (focused.startsWith('example:')) focus('examples')
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); choose(focused)
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close()
    }
  }
  const rowProps = (key: string) => ({
    ref: (element: HTMLElement | null) => { if (element) rows.current.set(key, element); else rows.current.delete(key) },
    tabIndex: focused === key ? 0 : -1,
    onFocus: (event: React.FocusEvent) => { event.stopPropagation(); setFocused(key) },
    onClick: (event: React.MouseEvent) => { event.stopPropagation(); choose(key) },
  })

  return (
    <div ref={root} className="vd-project-picker" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setRowMenu(null) }
    }}>
      <button ref={trigger} type="button" className="vd-project-picker-trigger" aria-label={t('切换 Video Project')}
        aria-haspopup="tree" aria-expanded={open} aria-controls={open ? treeId : undefined} disabled={disabled}
        onClick={() => { if (open) close(); else show() }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() }
        }}>
        <span className={`vd-project-picker-name${snapshot.dirty ? ' vd-project-unsaved' : ''}`}>
          <span className="vd-project-name-text">{snapshot.project?.name ?? t('暂无工程')}</span>{snapshot.dirty ? <span className="vd-project-dirty-mark"> *</span> : null}
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open ? (
        <div className="vd-project-picker-popover">
          <ul id={treeId} role="tree" aria-label={t('Projects and examples')} onKeyDown={keyDown}>
            <li role="none">
              <div role="treeitem" aria-label="examples/" aria-expanded={expanded} aria-owns={expanded ? examplesId : undefined}
                className="vd-project-picker-row vd-project-picker-folder" {...rowProps('examples')}>
                <svg className={expanded ? 'is-expanded' : ''} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /></svg>
                <span>examples/</span>
              </div>
              {expanded ? (
                <ul id={examplesId} role="group">
                  {examples.map(example => (
                    <li key={example.id} role="treeitem" aria-label={t('Open example {0}', example.name)} aria-selected={false} {...rowProps(`example:${example.id}`)}>
                      <div className="vd-project-picker-row vd-project-picker-example" title={t('Open as an editable project')}>
                        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h7l4 4v12H5Zm7 0v5h4M8 11h5M8 14h5" /></svg>
                        <span>{example.name}</span>
                      </div>
                    </li>
                  ))}
                  {snapshot.examplesLoading && examples.length === 0 ? <li role="none" className="vd-project-picker-note">{t('Loading examples…')}</li> : null}
                  {!snapshot.examplesLoading && examples.length === 0 && !snapshot.examplesError ? <li role="none" className="vd-project-picker-note">{t('No examples found')}</li> : null}
                  {snapshot.examplesError ? <li role="none" className="vd-project-picker-note" title={snapshot.examplesError}>{t('Could not load examples. Reopen this list to retry.')}</li> : null}
                </ul>
              ) : null}
            </li>
            {snapshot.projects.map((project, index) => (
              <li key={project.id} role="treeitem" aria-label={project.name} aria-selected={project.id === snapshot.project?.id}
                className={`${index === 0 ? 'vd-project-picker-first-project' : ''} ${dropTarget?.id === project.id ? dropTarget.after ? 'vd-drop-after' : 'vd-drop-before' : ''}`}
                {...rowProps(`project:${project.id}`)} draggable={!disabled}
                title={t('Drag to reorder, or use Alt+Up / Alt+Down')}
                onDragStart={event => {
                  setRowMenu(null); setDragging(project.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', project.id)
                }}
                onDragOver={event => {
                  if (!dragging || dragging === project.id) return
                  event.preventDefault(); event.dataTransfer.dropEffect = 'move'
                  const box = event.currentTarget.getBoundingClientRect()
                  setDropTarget({ id: project.id, after: event.clientY > box.top + box.height / 2 })
                }}
                onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                onDrop={event => {
                  event.preventDefault(); event.stopPropagation()
                  if (dragging && dragging !== project.id) {
                    const ids = snapshot.projects.map(row => row.id).filter(id => id !== dragging)
                    const box = event.currentTarget.getBoundingClientRect()
                    ids.splice(ids.indexOf(project.id) + (event.clientY > box.top + box.height / 2 ? 1 : 0), 0, dragging)
                    onReorder(ids)
                  }
                  setDragging(null); setDropTarget(null)
                }}>
                <div className="vd-project-picker-row">
                  <span className="vd-project-picker-check" aria-hidden="true">{project.id === snapshot.project?.id ? '✓' : ''}</span>
                  <span className={`vd-project-picker-name${project.unsaved ? ' vd-project-unsaved' : ''}`}>
                    <span className="vd-project-name-text">{project.name}</span>{project.unsaved ? <span className="vd-project-dirty-mark"> *</span> : null}
                  </span>
                  <button type="button" className="vd-project-row-more" aria-label={t('Actions for {0}', project.name)} aria-haspopup="menu"
                    aria-expanded={rowMenu?.id === project.id} draggable={false}
                    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { setRowMenu(null); focus(`project:${project.id}`) } }}
                    onClick={event => {
                      event.stopPropagation()
                      const popover = event.currentTarget.closest('.vd-project-picker-popover')!.getBoundingClientRect()
                      const top = Math.max(4, Math.min(event.currentTarget.getBoundingClientRect().bottom - popover.top, popover.height - 244))
                      setRowMenu(rowMenu?.id === project.id ? null : { id: project.id, top })
                    }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="vd-project-picker-hint" role="status">{unsavedCount === 1 ? t('1 unsaved workflow') : t('{0} unsaved workflows', unsavedCount)}</div>
          {rowMenu ? <div className="vd-project-row-menu" style={{ top: rowMenu.top }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { setRowMenu(null); focus(`project:${rowMenu.id}`) } }}>
            <ProjectActionsMenu hasProject disabled={disabled}
              busy={snapshot.projects.find(project => project.id === rowMenu.id)?.status === 'running'}
              onAction={action => { const id = rowMenu.id; close(); onProjectAction(id, action) }} />
          </div> : null}
        </div>
      ) : null}
    </div>
  )
}
