import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirectorController } from './controller'
import type { DirectorJob, DirectorSnapshot, VdRun } from './types'
import { t, useLanguage } from './i18n'
import { CloseIcon } from './icons'
import { ArtifactPreviewDialog, ArtifactThumbnail, previewArtifactsFromResult, type PreviewArtifact } from './ArtifactPreview'
import { folderPath } from './project-folders'
import { downloadBlob, downloadJobArtifacts } from './job-artifacts'

interface JobGroup { id: string; projectId: string; run?: VdRun; jobs: DirectorJob[]; submitted: string }

export function jobStatus(group: JobGroup): DirectorJob['status'] {
  if (group.run) return group.run.status
  return group.jobs[0]?.status ?? 'queued'
}

export function jobDate(value: string | undefined): string {
  const date = new Date(value ?? '')
  if (!Number.isFinite(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function elapsedTime(start: string, now: number): string {
  const total = Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000)) || 0
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60
  return `${hours ? `${hours} h ` : ''}${minutes} min ${seconds} s`
}

function StatusIcon({ status }: { status: DirectorJob['status'] }) {
  const kind = status === 'completed' ? 'completed' : status === 'running' ? 'running' : status === 'queued' ? 'queued' : 'stopped'
  return <svg className={`vd-run-status-icon is-${kind}`} viewBox="0 0 20 20" fill="none" aria-label={status} role="img">
    {kind === 'running' ? <><circle cx="10" cy="10" r="7" opacity=".2" /><path d="M10 3a7 7 0 0 1 7 7" /></>
      : <><circle cx="10" cy="10" r="8" fill="currentColor" stroke="none" opacity=".13" />
        <path d={kind === 'completed' ? 'm6 10 2.5 2.5L14 7' : kind === 'queued' ? 'M6 10h8' : 'm7 7 6 6m0-6-6 6'} /></>}
  </svg>
}

const MoreIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
const FileIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h4" /></svg>

export function JobDrawer({ snapshot, director, onClose }: { snapshot: DirectorSnapshot; director: DirectorController; onClose(): void }) {
  useLanguage()
  const [filter, setFilter] = useState('')
  const [clock, setClock] = useState(Date.now())
  const [artifact, setArtifact] = useState<PreviewArtifact | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [inspected, setInspected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inspectedJobs, setInspectedJobs] = useState<{ id: string; jobs: DirectorJob[] } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inspectRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let refreshing = false
    const refresh = async () => { if (refreshing) return; refreshing = true; try { await director.refreshVdRuns() } catch (error) { setError(String(error)) } finally { refreshing = false } }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1400)
    const clock = setInterval(() => setClock(Date.now()), 1000)
    return () => { clearInterval(timer); clearInterval(clock) }
  }, [director])
  useEffect(() => {
    if (!menu) return
    const dismiss = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', key)
    document.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', key)
      document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [menu])
  useEffect(() => {
    if (!inspected) return
    const previous = document.activeElement as HTMLElement | null
    inspectRef.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setInspected(null) }
      if (event.key === 'Tab') {
        const buttons = [...(inspectRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]
        if (next) { event.preventDefault(); next.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [inspected])
  const groups = useMemo(() => {
    const groups = new Map<string, JobGroup>()
    const parents = new Set(snapshot.workflowRuns.filter(run => run.batchRunId).map(run => run.batchRunId))
    const hidden = new Set(snapshot.workflowRuns.filter(run => run.hidden || (run.kind === 'batch' && parents.has(run.id))).map(run => run.id))
    for (const run of snapshot.workflowRuns) if (!hidden.has(run.id)) groups.set(run.id, { id: run.id, projectId: run.projectId, run, jobs: [], submitted: run.queuedAt ?? run.startedAt })
    for (const job of snapshot.jobs ?? snapshot.project?.jobs ?? []) {
      if (job.workflowRunId && hidden.has(job.workflowRunId)) continue
      const id = job.workflowRunId ?? `job:${job.id}`
      const group = groups.get(id) ?? { id, projectId: job.projectId, jobs: [], submitted: job.createdAt }
      group.jobs.push(job); groups.set(id, group)
    }
    return [...groups.values()].sort((a, b) => b.submitted.localeCompare(a.submitted))
  }, [snapshot.workflowRuns, snapshot.jobs, snapshot.project])
  const visible = groups.filter(group => !filter || group.projectId === filter)
  const name = (group: JobGroup) => snapshot.projects.find(project => project.id === group.projectId)?.name ?? group.run?.workflowName ?? 'Workflow'
  const path = (group: JobGroup) => {
    const parent = snapshot.projectFolders?.projectParents[group.projectId]
    return `/${parent && snapshot.projectFolders ? `${folderPath(snapshot.projectFolders, parent)}/` : ''}${name(group)}`
  }
  const artifacts = (group: JobGroup) => {
    const seen = new Set<string>()
    const items = [...group.jobs].reverse().flatMap(job => previewArtifactsFromResult(job.result).map(item => item.asset ? item : { ...item, id: `${job.id}:${item.id}` }))
      .filter(item => { const key = item.asset?.id ?? item.id; if (seen.has(key)) return false; seen.add(key); return true })
    return items.length ? items : previewArtifactsFromResult(group.run?.previewResult)
  }
  useEffect(() => {
    const group = groups.find(group => group.id === inspected)
    if (!group?.run || !director.getVdRunJobs) return
    let disposed = false
    void director.getVdRunJobs(group.id).then(jobs => { if (!disposed) setInspectedJobs({ id: group.id, jobs }) }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true }
  }, [inspected, director, snapshot.jobs])
  const timing = (group: JobGroup) => {
    const status = jobStatus(group)
    if (status === 'running') return `running of ${elapsedTime(group.run?.executionStartedAt ?? group.jobs.find(job => job.startedAt)?.startedAt ?? group.submitted, clock)}`
    if (status === 'queued') return `queued at ${jobDate(group.submitted)}`
    const ended = group.run?.completedAt ?? group.jobs.map(job => job.completedAt ?? job.updatedAt).filter(Boolean).sort().at(-1)
    return `${status === 'completed' ? 'completed' : 'canceled'} at ${jobDate(ended)}`
  }
  const act = async (action: () => Promise<unknown>) => { setMenu(null); setBusy(true); setError(''); try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  const menuGroup = groups.find(group => group.id === menu?.id)
  const selectedGroup = groups.find(group => group.id === inspected)
  const inspectedGroup = selectedGroup && inspectedJobs?.id === selectedGroup.id ? { ...selectedGroup, jobs: inspectedJobs.jobs } : selectedGroup
  return <aside className="vd-job-drawer" aria-label={t('任务列表')}>
    <header><div><strong>{t('Jobs')} <span className="vd-job-count">{visible.length}</span></strong><small>{t('Workflow runs')}</small></div>
      <button type="button" className="vd-close-icon-button" aria-label={t('关闭任务列表')} onClick={onClose}><CloseIcon /></button></header>
    <div className="vd-job-toolbar"><label className="vd-job-filter"><span>{t('Workflow')}</span>
      <select aria-label={t('Filter by workflow')} value={filter} onChange={event => { setFilter(event.target.value); setMenu(null) }}>
        <option value="">{t('All workflows')}</option>
        {snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>{error ? <p className="vd-job-error" role="alert">{error}</p> : null}</div>
    <div className="vd-job-list">
      {!visible.length ? <p className="vd-job-empty">{t('尚无运行记录。')}</p> : visible.map(group => {
        const media = artifacts(group), status = jobStatus(group), count = group.run?.artifactCount ?? media.length
        return <article key={group.id} className={`vd-job-card is-${status}`} aria-label={`${name(group)}: ${status}`}>
          <div className="vd-job-cover">{media[0] ? <ArtifactThumbnail artifact={media[0]} variant="job" onOpen={item => {
            if (item.kind === 'text' && !group.jobs.length && group.run) void act(async () => {
              const jobs = await director.getVdRunJobs(group.id)
              setArtifact(previewArtifactsFromResult(jobs.find(job => job.id === group.run?.previewJobId)?.result)[0] ?? item)
            }); else setArtifact(item)
          }} /> : <span className="vd-job-cover-empty"><FileIcon /></span>}
            {count > 1 ? <button type="button" className="vd-job-artifact-count" title={t('Inspect all artifacts')} onClick={() => setInspected(group.id)}>+{count - 1}</button> : null}</div>
          <div className="vd-job-card-content"><strong title={path(group)}>{name(group)}</strong>
            <div className="vd-job-card-time"><StatusIcon status={status} /><span>{timing(group)}</span></div></div>
          <button type="button" className="vd-job-more" aria-label={`Actions for ${name(group)}`} aria-haspopup="menu" aria-expanded={menu?.id === group.id} disabled={busy}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu?.id === group.id ? null : { id: group.id,
              x: Math.max(8, Math.min(rect.right - 218, window.innerWidth - 226)), y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 224)) }) }}><MoreIcon /></button>
        </article>
      })}
    </div>
    {menu && menuGroup ? createPortal(<div ref={menuRef} className="vd-job-menu" role="menu" aria-label={t('Job actions')} style={{ left: menu.x, top: menu.y }}
      onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } }}>
      <button role="menuitem" disabled={!artifacts(menuGroup).length} onClick={() => void act(async () => {
        const jobs = menuGroup.run ? await director.getVdRunJobs(menuGroup.id) : menuGroup.jobs
        await downloadJobArtifacts(artifacts({ ...menuGroup, jobs }), name(menuGroup))
      })}>{t('Download artifacts')}</button>
      <button role="menuitem" onClick={() => void act(async () => { const file = menuGroup.run ? await director.exportVdWorkflow(menuGroup.id) : await director.exportProject(menuGroup.projectId); downloadBlob(new Blob([file.text], { type: 'application/json' }), file.filename) })}>{t('Download Workflow')}</button>
      <button role="menuitem" onClick={() => void act(() => menuGroup.run ? director.openVdWorkflow(menuGroup.id) : director.selectProject(menuGroup.projectId))}>{t('Open Workflow')}</button>
      <button role="menuitem" className="is-danger" disabled={['queued', 'running'].includes(jobStatus(menuGroup))} title={['queued', 'running'].includes(jobStatus(menuGroup)) ? 'Cancel this run in Inspect Property before deleting it.' : undefined}
        onClick={() => { if (window.confirm(`Delete this run of “${name(menuGroup)}” from the Job List? Its assets will be kept.`)) void act(() => menuGroup.run ? director.deleteVdRun(menuGroup.id) : director.deleteJob(menuGroup.jobs[0].id)) }}>{t('Delete from Job List')}</button>
      <button role="menuitem" onClick={() => { setInspected(menuGroup.id); setMenu(null) }}>{t('Inspect Property')}</button>
    </div>, document.body) : null}
    {inspectedGroup ? createPortal(<div className="vd-job-inspector-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) setInspected(null) }}>
      <div ref={inspectRef} className="vd-job-inspector" role="dialog" aria-modal="true" aria-label={t('Inspect Property')} tabIndex={-1}>
        <header><div><strong>{name(inspectedGroup)}</strong><small>{path(inspectedGroup)}</small></div><button className="vd-close-icon-button" aria-label={t('Close properties')} onClick={() => setInspected(null)}><CloseIcon /></button></header>
        <div className="vd-job-inspector-body"><p className="vd-job-card-time"><StatusIcon status={jobStatus(inspectedGroup)} />{timing(inspectedGroup)}</p>
          {error ? <p className="vd-job-error" role="alert">{error}</p> : null}
          {inspectedGroup.run?.error ? <p className="vd-job-error">{inspectedGroup.run.error}</p> : null}
          <dl><dt>Run ID</dt><dd>{inspectedGroup.id}</dd><dt>Scope</dt><dd>{inspectedGroup.run?.mode ?? 'Single node'}</dd>
            <dt>Submitted</dt><dd>{jobDate(inspectedGroup.submitted)}</dd><dt>Tasks</dt><dd>{inspectedGroup.run?.completedJobs ?? inspectedGroup.jobs.filter(job => job.status === 'completed').length} / {inspectedGroup.run?.totalJobs ?? inspectedGroup.jobs.length}</dd></dl>
          {artifacts(inspectedGroup).length ? <div className="vd-job-inspector-artifacts">{artifacts(inspectedGroup).map(item => <ArtifactThumbnail key={item.id} artifact={item} variant="job" onOpen={setArtifact} />)}</div> : null}
          {inspectedGroup.jobs.map(job => <details key={job.id}><summary>{snapshot.project?.graph.nodes.find(node => node.id === job.nodeId)?.data.title ?? job.operation} · {job.status} · {Math.round(job.progress * 100)}%</summary><pre>{JSON.stringify(job, null, 2)}</pre></details>)}
        </div>
        {['queued', 'running'].includes(jobStatus(inspectedGroup)) ? <footer><button type="button" className="vd-button is-danger" disabled={busy || inspectedGroup.run?.cancelRequested}
          onClick={() => void act(() => inspectedGroup.run ? director.cancelVdRun(inspectedGroup.id) : director.cancelJob(inspectedGroup.jobs[0].id))}>{inspectedGroup.run?.cancelRequested ? t('Canceling…') : t('Cancel run')}</button></footer> : null}
      </div></div>, document.body) : null}
    {artifact ? <ArtifactPreviewDialog artifact={artifact} onClose={() => setArtifact(null)} /> : null}
  </aside>
}
