import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArtifactPreviewDialog, ArtifactThumbnail, type PreviewArtifact } from './ArtifactPreview'
import { allProjectGalleries, filterGallery } from './gallery-artifacts'
import { CloseIcon } from './icons'
import { t, useLanguage } from './i18n'
import { useModalScrollLock } from './modal-scroll-lock'
import type { GalleryProject, VideoProject } from './types'

export function ArtifactGallery({ project, loadProjects, onClose }: {
  project: VideoProject | null
  loadProjects(signal: AbortSignal): Promise<GalleryProject[]>
  onClose(): void
}) {
  useLanguage()
  useModalScrollLock()
  const [tab, setTab] = useState<'input' | 'output'>('input')
  const [openArtifact, setOpenArtifact] = useState<PreviewArtifact | null>(null)
  const [projects, setProjects] = useState<GalleryProject[]>([])
  const [workflowId, setWorkflowId] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [limit, setLimit] = useState(60)
  const workflows = useMemo(() => {
    const rows = projects.map(row => row.id === project?.id ? project : row)
    if (project !== null && !rows.some(row => row.id === project.id)) rows.unshift(project)
    return rows
  }, [projects, project])
  const catalog = useMemo(() => allProjectGalleries(workflows), [workflows])
  const gallery = useMemo(() => ({
    input: filterGallery(catalog.input, workflowId, query),
    output: filterGallery(catalog.output, workflowId, query),
  }), [catalog, workflowId, query])
  const id = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const inputTabRef = useRef<HTMLButtonElement>(null)
  const outputTabRef = useRef<HTMLButtonElement>(null)
  const artifactTrigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void loadProjects(controller.signal).then(rows => {
      if (!controller.signal.aborted) setProjects(rows)
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load all workflows. Refresh to try again.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [loadProjects, refresh])

  useEffect(() => { setLimit(60) }, [tab, workflowId, query])
  useEffect(() => {
    if (!loading && workflowId !== '' && !workflows.some(row => row.id === workflowId)) setWorkflowId('')
  }, [loading, workflows, workflowId])

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    inputTabRef.current?.focus()
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (openArtifact !== null) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [openArtifact, onClose])

  const changeTab = (next: 'input' | 'output'): void => {
    setTab(next)
    const nextTab = next === 'input' ? inputTabRef : outputTabRef
    nextTab.current?.focus()
  }

  return createPortal(
    <>
      <div className="vd-artifact-dialog-backdrop vd-gallery-backdrop" onPointerDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <section ref={dialogRef} className="vd-artifact-dialog vd-gallery-dialog nodrag nowheel" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
          aria-hidden={openArtifact !== null || undefined}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            if (openArtifact !== null || event.key !== 'Tab') return
            const buttons = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input, select') ?? [])]
            const first = buttons[0], last = buttons.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }}>
          <header>
            <div><strong id={`${id}-title`}>{t('Gallery')}</strong><span className="vd-gallery-project-name">{workflowId === '' ? t('All workflows') : workflows.find(row => row.id === workflowId)?.name}</span></div>
            <div className="vd-artifact-dialog-actions">
              <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('Refresh')}</button>
              <button type="button" className="vd-artifact-dialog-close" aria-label={t('Close gallery')} onClick={onClose}><CloseIcon /></button>
            </div>
          </header>
          <div className="vd-gallery-filters">
            <label><span>{t('Workflow')}</span>
              <select aria-label={t('Filter by workflow')} value={workflowId} onChange={event => setWorkflowId(event.target.value)}>
                <option value="">{t('All workflows')}</option>
                {workflows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
            <label className="vd-gallery-search"><span>{t('Search resources')}</span>
              <input type="search" aria-label={t('Search resources')} placeholder={t('Filename, workflow, node, or text…')}
                value={query} onChange={event => setQuery(event.target.value)} />
            </label>
          </div>
          <div className="vd-gallery-tabs" role="tablist" aria-label={t('Artifact source')}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              changeTab(event.key === 'Home' ? 'input' : event.key === 'End' ? 'output' : tab === 'input' ? 'output' : 'input')
            }}>
            {(['input', 'output'] as const).map(source => (
              <button key={source} ref={source === 'input' ? inputTabRef : outputTabRef} type="button" role="tab" id={`${id}-${source}`}
                aria-selected={tab === source} aria-controls={`${id}-panel`} tabIndex={tab === source ? 0 : -1}
                onClick={() => changeTab(source)}>{t(source === 'input' ? 'Input' : 'Output')} <span>{gallery[source].length}</span></button>
            ))}
          </div>
          <div id={`${id}-panel`} className="vd-gallery-panel" role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={loading}>
            <div className="vd-gallery-status" role="status">{loading ? t('Loading resources…') : t('{0} resources', gallery[tab].length)}</div>
            {error !== null ? <p className="vd-gallery-error" role="alert">{t(error)}</p> : null}
            {gallery[tab].length === 0 && !loading ? (
              <div className="vd-gallery-empty">{t(workflowId !== '' || query.trim() !== '' ? 'No resources match your filters.' : tab === 'input' ? 'No input artifacts yet. Add text or media to an Input node.' : 'No output artifacts yet. Run a node to create results.')}</div>
            ) : (
              <div className="vd-gallery-grid">
                {gallery[tab].slice(0, limit).map(({ artifact, sources, createdAt, workflowId: ownerId, workflowName }) => (
                  <article key={`${tab}:${ownerId}:${artifact.id}`} className="vd-gallery-card">
                    <ArtifactThumbnail artifact={artifact} variant="gallery" onOpen={selected => {
                      artifactTrigger.current = document.activeElement as HTMLElement
                      setOpenArtifact(selected)
                    }} />
                    <strong title={artifact.name}>{artifact.name}</strong>
                    <span className="vd-gallery-workflow" title={workflowName}>{workflowName}</span>
                    <span title={sources.join(' · ')}>{sources.join(' · ')}</span>
                    <small>{t(artifact.kind)}{createdAt ? <> · <time dateTime={createdAt}>{new Date(createdAt).toLocaleString()}</time></> : null}</small>
                  </article>
                ))}
              </div>
            )}
            {gallery[tab].length > limit ? <button type="button" className="vd-gallery-show-more" onClick={() => setLimit(value => value + 60)}>{t('Show more resources')}</button> : null}
          </div>
        </section>
      </div>
      {openArtifact === null ? null : <ArtifactPreviewDialog artifact={openArtifact} onClose={() => {
        setOpenArtifact(null)
        artifactTrigger.current?.focus()
      }} />}
    </>, document.body,
  )
}
