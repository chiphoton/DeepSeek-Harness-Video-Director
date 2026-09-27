import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { t, useLanguage } from './i18n'
import { folderDescendants, folderPath } from './project-folders'
import { FolderDestinationTree } from './FolderDestinationTree'
import type { DirectorSnapshot, ProjectFolderChange, ProjectFolderLayout, ProjectShortcut, ProjectSummary } from './types'

export type FolderDialogAction = {
  action: 'create' | 'create-workflow' | 'rename' | 'move' | 'delete' | 'batch-move' | 'batch-delete'
  kind: 'folder' | 'project'; id?: string; name: string; parentId: string | null; revision: number; items?: ProjectShortcut[]
}

export function ProjectFolderDialog({ value, layout, snapshot, onSubmit, onCreateWorkflow, onClose }: {
  value: FolderDialogAction; layout: ProjectFolderLayout; snapshot: DirectorSnapshot
  onSubmit(change: ProjectFolderChange): Promise<void>
  onCreateWorkflow?(name: string, parentId: string | null, revision: number): Promise<void>
  onClose(): void
}) {
  useLanguage()
  const titleId = useId()
  const naming = ['create', 'create-workflow', 'rename'].includes(value.action)
  const moving = value.action === 'move' || value.action === 'batch-move'
  const deleting = value.action === 'delete' || value.action === 'batch-delete'
  const targets = value.items ?? (value.id ? [{ kind: value.kind, id: value.id }] : [])
  const folderIds = targets.filter(item => item.kind === 'folder').map(item => item.id)
  const projectIds = targets.filter(item => item.kind === 'project').map(item => item.id)
  const excluded = new Set(folderIds.flatMap(id => [...folderDescendants(layout, id)]))
  const affectedFolders = layout.folders.filter(folder => excluded.has(folder.id))
  const explicitProjects = snapshot.projects.filter(project => projectIds.includes(project.id))
  const children = snapshot.projects.filter(project => excluded.has(layout.projectParents[project.id] ?? '') && !projectIds.includes(project.id))
  const [name, setName] = useState(value.action === 'rename' ? value.name : '')
  const [destination, setDestination] = useState<string | null>(value.parentId)
  const [mode, setMode] = useState<'keep-workflows' | 'delete-workflows'>('keep-workflows')
  const [confirmProjects, setConfirmProjects] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null)
  const isRunning = (project: ProjectSummary) => project.status === 'running' || snapshot.workflowRuns.some(run => run.projectId === project.id && ['queued', 'running'].includes(run.status))
  const runningChildren = children.some(isRunning)
  const runningExplicit = explicitProjects.some(isRunning)
  const mixed = folderIds.length > 0 && projectIds.length > 0
  const blocked = deleting && (runningExplicit || (mode === 'delete-workflows' && runningChildren) || (mixed && !confirmProjects))
  const title = moving ? targets.length > 1 ? t('Move {0} items to…', targets.length) : t('Move “{0}” to…', value.name)
    : t(value.action === 'create-workflow' ? 'New Workflow' : value.action === 'create' ? 'New Folder' : value.action === 'rename' ? 'Rename Folder' : value.action === 'batch-delete' ? 'Delete selected items' : 'Delete Folder')
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLElement>('form input, form [role="treeitem"][tabindex="0"], form button:not([tabindex="-1"])')?.focus()
    return () => previous?.focus()
  }, [])
  const submit = async () => {
    if (busy || blocked) return
    setBusy(true); setError(null)
    try {
      const expectedRevision = value.revision
      if (value.action === 'create-workflow') {
        if (!onCreateWorkflow) throw new Error('Workflow creation is unavailable.')
        await onCreateWorkflow(name.trim(), value.parentId, expectedRevision)
      } else {
        const change: ProjectFolderChange = value.action === 'create' ? { action: 'create', name, parentId: value.parentId, expectedRevision }
          : value.action === 'rename' ? { action: 'rename', id: value.id!, name, expectedRevision }
          : value.action === 'move' ? { action: 'move', kind: value.kind, id: value.id!, parentId: destination, expectedRevision }
          : value.action === 'batch-move' ? { action: 'batch-move', items: targets, parentId: destination, expectedRevision }
          : value.action === 'batch-delete' ? { action: 'batch-delete', folderIds, projectIds, mode, expectedRevision }
          : { action: 'delete', id: value.id!, mode, expectedRevision }
        await onSubmit(change)
      }
      onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }
  const workflowList = (projects: ProjectSummary[]) => <ul className="vd-folder-affected-list">{projects.map(project => <li key={project.id}>{layout.projectParents[project.id] ? `/${folderPath(layout, layout.projectParents[project.id]!)}/` : '/'}{project.name}</li>)}</ul>
  return createPortal(<div className="vd-artifact-dialog-backdrop vd-folder-dialog-backdrop" onPointerDown={event => {
    event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <section ref={panel} className="vd-folder-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [role="treeitem"][tabindex="0"]')]
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
        if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
      }
    }}>
      <header><strong id={titleId}>{title}</strong><button type="button" aria-label={t('Close')} disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        {naming ? <label>{t(value.action === 'create-workflow' ? 'Workflow name' : 'Folder name')}<input autoFocus maxLength={120} required value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label> : null}
        {moving ? <FolderDestinationTree layout={layout} excluded={excluded} value={destination} disabled={busy} onChange={setDestination} /> : null}
        {deleting ? <div className="vd-folder-delete-options">
          {explicitProjects.length > 0 ? <fieldset><legend>{t('Selected workflows')}</legend>{workflowList(explicitProjects)}
            {mixed ? <label><input type="checkbox" checked={confirmProjects} disabled={busy || runningExplicit} onChange={event => setConfirmProjects(event.target.checked)} /><span>{t('Delete these workflows')}</span></label>
              : <p>{t('Delete these workflows and their assets?')}</p>}
            {runningExplicit ? <small>{t('Stop active jobs before deleting their workflows.')}</small> : null}
          </fieldset> : null}
          {affectedFolders.length > 0 ? <fieldset><legend>{t('Folders to remove')}</legend>
            <ul className="vd-folder-affected-list">{affectedFolders.map(folder => <li key={folder.id}>/{folderPath(layout, folder.id)}/</li>)}</ul>
            <p>{children.length === 1 ? t('1 child workflow') : t('{0} child workflows', children.length)}</p>
            {workflowList(children)}
            <label><input type="radio" name="folder-delete-mode" checked={mode === 'keep-workflows'} disabled={busy} onChange={() => setMode('keep-workflows')} /><span>{t('Move child workflows to /')}</span></label>
            <label><input type="radio" name="folder-delete-mode" checked={mode === 'delete-workflows'} disabled={busy || runningChildren} onChange={() => setMode('delete-workflows')} /><span>{t('Delete child workflows and their assets')}</span></label>
            {runningChildren ? <small>{t('Stop active jobs before deleting their workflows.')}</small> : null}
            {mixed ? <small>{t('The folder choice applies to child workflows not listed above.')}</small> : null}
          </fieldset> : null}
          {mode === 'delete-workflows' || explicitProjects.length > 0 ? <small>{t('This cannot be undone. Assets shared with other workflows are kept.')}</small> : null}
          {excluded.has(layout.examplesParentId ?? '') ? <small>{t('Bundled examples remain available at /.')}</small> : null}
        </div> : null}
        {error ? <p className="vd-folder-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button type="submit" className={deleting ? 'is-danger' : 'is-primary'} disabled={busy || (naming && !name.trim()) || blocked}>{t(busy ? 'Saving…' : deleting ? value.action === 'batch-delete' ? 'Delete' : 'Delete Folder' : moving ? 'Move' : value.action === 'create-workflow' ? 'Create' : 'Save')}</button></footer>
      </form>
    </section>
  </div>, document.body)
}
