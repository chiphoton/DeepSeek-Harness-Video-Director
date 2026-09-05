import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  type CSSProperties,
  type FormEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import type { DirectorController } from './controller'
import type { ProjectChatSource } from './chat-source'
import {
  DirectorNodeView,
  DirectorRuntimeProvider,
  type DirectorRuntimeValue,
} from './DirectorNode'
import { MaskModal } from './MaskModal'
import { CanvasContextMenu, CanvasModeControl, isCanvasTextInput, scrollableCanvasField, type CanvasInteractionMode } from './canvas-controls'
import { CloseIcon, JobsIcon, PlayIcon, RedoIcon, SaveIcon, SettingsIcon, UndoIcon } from './icons'
import {
  fieldInputModeEnabled,
  fieldInputPortId,
  parameterInputCandidates,
} from './parameter-inputs'
import { SettingsDrawer } from './SettingsDrawer'
import { SketchModal } from './SketchModal'
import { referencePreviewsByTarget } from './reference-previews'
import {
  ArtifactPreviewDialog,
  ArtifactThumbnail,
  type PreviewArtifact,
  previewArtifactFromAsset,
  previewArtifactsFromResult,
} from './ArtifactPreview'
import {
  implicitInputPortForKind,
  inputPortsFor,
  nodeDefinition,
  portHandleId,
  portsFor,
  preferredCompatibleInputPort,
  resolveConnectionPorts,
  resolveNodePort,
} from './ports'
import type {
  AssetRef,
  DirectorEdge,
  DirectorJob,
  DirectorNode,
  DirectorNodeData,
  DirectorSnapshot,
  VdRun,
  MediaKind,
  VdNodeDefinitionDescriptor,
  VdPortDescriptor,
  SketchDocument,
} from './types'
import xyflowStyles from '@xyflow/react/dist/style.css'
import styles from './styles.css'

export interface DirectorInjectedProps {
  director: DirectorController
  chat: ProjectChatSource
}

export interface DirectorLauncherProps extends DirectorInjectedProps {
  wide: boolean
}

function useSource<T>(source: {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}): T {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}

function kindColor(kind: DirectorNodeData['kind']): string {
  if (kind === 'vram-trigger' || kind === 'ollama-eject' || kind === 'comfyui-clear') return '#0891b2'
  if (kind.includes('video')) return '#fb923c'
  if (kind.includes('image')) return '#8b5cf6'
  if (kind.includes('sketch')) return '#d97706'
  if (kind.includes('audio')) return '#10b981'
  if (kind.includes('prompt') || kind.includes('text')) return '#3b82f6'
  return '#64748b'
}

function swallow(error: unknown): void {
  // Controller methods publish actionable errors through their observable
  // snapshot. This helper keeps event handlers from creating unhandled rejections.
  if (error instanceof DOMException && error.name === 'AbortError') return
}

function downloadAsset(asset: AssetRef): void {
  const anchor = document.createElement('a')
  anchor.href = asset.url
  anchor.download = asset.name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

export function DirectorLauncher({ director, wide }: DirectorLauncherProps) {
  const snapshot = useSource(director)
  return (
    <button
      type="button"
      title="打开 Video Director"
      aria-label="打开 Video Director"
      onClick={director.open}
      style={{
        width: wide ? '100%' : 38,
        minHeight: 38,
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 9,
        padding: wide ? '0 11px' : 0,
        color: 'var(--dsh-fg, currentColor)',
        background: snapshot.open ? 'color-mix(in srgb, #4f7cff 18%, transparent)' : 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        borderRadius: 10,
        cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{ color: '#4f7cff', fontSize: 17 }}>◆</span>
      {wide ? <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Video Director</span> : null}
    </button>
  )
}

function EmptyProject({ onCreate }: { onCreate(name: string): Promise<void> }) {
  const [name, setName] = useState('Untitled Video')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '' || busy) return
    setBusy(true)
    try { await onCreate(name.trim()) } finally { setBusy(false) }
  }
  return (
    <div className="vd-empty">
      <div className="vd-empty-mark" aria-hidden>◆</div>
      <h1>开始一个 Video Project</h1>
      <p>每个工程拥有独立画布、素材、任务历史和 DeepSeek 对话上下文。</p>
      <form onSubmit={submit} className="vd-create-form">
        <input value={name} maxLength={120} onChange={event => setName(event.target.value)} aria-label="工程名" />
        <button type="submit" disabled={busy}>{busy ? '创建中…' : '创建工程'}</button>
      </form>
    </div>
  )
}

function TopBar({
  snapshot,
  director,
  onSettings,
  selectedNodeIds,
  onJobs,
}: {
  snapshot: DirectorSnapshot
  director: DirectorController
  onSettings(): void
  selectedNodeIds: ReadonlySet<string>
  onJobs(): void
}) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('Untitled Video')
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [runMenuOpen, setRunMenuOpen] = useState(false)
  const [batchSize, setBatchSize] = useState(1)
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null)
  const projectImportRef = useRef<HTMLInputElement | null>(null)
  const runMenuRef = useRef<HTMLDivElement | null>(null)
  const project = snapshot.project
  const projectTransitioning = snapshot.phase === 'loading'
  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && projectSwitcherRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])
  useEffect(() => {
    if (!runMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && runMenuRef.current?.contains(target)) return
      setRunMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setRunMenuOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [runMenuOpen])
  const create = async () => {
    if (newName.trim() === '' || snapshot.saving || projectTransitioning) return
    try {
      if (snapshot.dirty) {
        const discard = window.confirm('当前工程有未保存更改。放弃这些更改并创建新工程？')
        if (!discard) return
        await director.discardChanges()
      }
      await director.createProject(newName.trim())
      setCreating(false)
      setNewName('Untitled Video')
    } catch (error) { swallow(error) }
  }
  const selectProject = async (projectId: string): Promise<void> => {
    if (projectId === project?.id || snapshot.saving || projectTransitioning) return
    const discard = snapshot.dirty
      ? window.confirm('当前工程有未保存更改。放弃这些更改并切换工程？')
      : false
    if (snapshot.dirty && !discard) return
    try { await director.selectProject(projectId, { discard }) } catch (error) { swallow(error) }
  }
  const beginRename = (): void => {
    if (project === null) return
    setRenameDraft(project.name)
    setMenuOpen(false)
    setRenaming(true)
  }
  const applyRename = (): void => {
    if (renameDraft.trim() === '') return
    director.renameProject(renameDraft.trim())
    setRenaming(false)
  }
  const deleteProject = async (): Promise<void> => {
    if (project === null || snapshot.saving || projectTransitioning) return
    setMenuOpen(false)
    const confirmed = window.confirm(`确定删除工程“${project.name}”？\n\n工程画布、任务历史与素材将被删除，此操作无法撤销。绑定的 DSH 对话会保留。`)
    if (!confirmed) return
    try { await director.deleteProject(project.id) } catch (error) { swallow(error) }
  }
  const saveBeforeProjectCopy = async (action: '复制' | '导入'): Promise<boolean> => {
    if (!snapshot.dirty) return true
    const confirmed = window.confirm(`当前工程有未保存更改。是否先保存，再${action}工程？`)
    if (!confirmed) return false
    try {
      await director.saveProject()
      return true
    } catch (error) {
      swallow(error)
      return false
    }
  }
  const duplicateProject = async (): Promise<void> => {
    setMenuOpen(false)
    if (project === null || !await saveBeforeProjectCopy('复制')) return
    try { await director.duplicateProject() } catch (error) { swallow(error) }
  }
  const exportProject = async (): Promise<void> => {
    setMenuOpen(false)
    if (project === null) return
    try {
      const exported = await director.exportProject()
      const url = URL.createObjectURL(new Blob([exported.text], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exported.filename
      anchor.style.display = 'none'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) { swallow(error) }
  }
  const clearPreviews = (): void => {
    setMenuOpen(false)
    director.clearPreviews()
  }
  const restoreOpenedProject = (): void => {
    if (project === null || snapshot.saving || projectTransitioning) return
    setMenuOpen(false)
    if (!window.confirm(`确定放弃工程“${project.name}”的更改？\n\n工作流将恢复到本次打开时的状态，撤销和重做记录将清空。期间保存过的更改也会从画布中还原；如需将恢复结果写入工程，请点击“保存”。`)) return
    try { director.restoreOpenedProject() } catch (error) { window.alert(error instanceof Error ? error.message : String(error)) }
  }
  const importProject = async (file: File): Promise<void> => {
    if (!await saveBeforeProjectCopy('导入')) return
    try { await director.importProject(await file.text()) } catch (error) { swallow(error) }
  }
  const workflowBusy = snapshot.workflowRuns.some(run => run.projectId === project?.id && run.status === 'running')
  const runnableCount = project?.graph.nodes.filter(node => REMOTE_NODE_KINDS.has(node.data.kind)).length ?? 0
  const canRunWorkflow = project !== null && runnableCount > 0 && !snapshot.saving && !projectTransitioning
  const activeJobCount = (project?.jobs.filter(job => job.status === 'queued' || job.status === 'running').length ?? 0)
    + snapshot.workflowRuns.filter(run => run.projectId === project?.id && run.status === 'queued').length
  const runVdWorkflow = (mode: 'all' | 'selected' | 'from-selection'): void => {
    setRunMenuOpen(false)
    void director.runVdWorkflow({
      mode,
      selectedNodeIds: mode === 'all' ? undefined : [...selectedNodeIds],
      batchSize,
    }).catch(swallow)
  }
  return (
    <header className="vd-topbar">
      <div className="vd-brand">
        <span className="vd-brand-mark" aria-hidden>◆</span>
        <span>Video Director</span>
      </div>
      <div ref={projectSwitcherRef} className="vd-project-switcher">
        <input
          ref={projectImportRef}
          type="file"
          hidden
          accept="application/json,.json"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file !== undefined) void importProject(file)
          }}
        />
        <select
          value={project?.id ?? ''}
          aria-label="切换 Video Project"
          disabled={snapshot.saving || projectTransitioning}
          onChange={event => { void selectProject(event.target.value) }}
        >
          {snapshot.projects.length === 0 ? <option value="">暂无工程</option> : null}
          {snapshot.projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <button type="button" className="vd-icon-button" title={snapshot.saving || projectTransitioning ? '请等待当前操作完成' : '新建工程'} disabled={snapshot.saving || projectTransitioning} onClick={() => setCreating(value => !value)}>＋</button>
        {creating ? (
          <div className="vd-create-popover">
            <input
              autoFocus
              value={newName}
              maxLength={120}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape') setCreating(false)
              }}
            />
            <button type="button" onClick={() => { void create() }}>创建</button>
          </div>
        ) : null}
        <div className="vd-project-more-anchor">
          <button type="button" className="vd-icon-button vd-more-button" title={snapshot.saving || projectTransitioning ? '请等待当前操作完成' : '工程菜单'} aria-label="工程菜单" aria-expanded={menuOpen} disabled={snapshot.saving || projectTransitioning} onClick={() => setMenuOpen(value => !value)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="vd-project-menu" role="menu">
              <button type="button" disabled={project === null} onClick={beginRename}>重命名工程</button>
              <button type="button" disabled={project === null || snapshot.saving || projectTransitioning} onClick={() => { void duplicateProject() }}>复制工程</button>
              <button type="button" disabled={snapshot.saving || projectTransitioning} onClick={() => { setMenuOpen(false); projectImportRef.current?.click() }}>导入工程</button>
              <button type="button" disabled={project === null || projectTransitioning} onClick={() => { void exportProject() }}>导出工程</button>
              <button type="button" disabled={project === null || snapshot.saving || projectTransitioning} onClick={clearPreviews}>清除预览</button>
              <button type="button" disabled={project === null || snapshot.saving || projectTransitioning || workflowBusy || activeJobCount > 0}
                title={workflowBusy || activeJobCount > 0 ? '请等待任务结束或取消任务后再放弃更改' : '恢复到本次打开时的工作流'}
                onClick={restoreOpenedProject}>放弃更改</button>
              <button
                type="button"
                className="vd-project-delete"
                disabled={project === null || snapshot.saving || projectTransitioning}
                onClick={() => { void deleteProject() }}
              >删除工程</button>
            </div>
          ) : null}
          {renaming ? (
            <div className="vd-rename-popover">
              <label>重命名工程</label>
              <div>
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={120}
                  onChange={event => setRenameDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') applyRename()
                    if (event.key === 'Escape') setRenaming(false)
                  }}
                />
                <button type="button" onClick={applyRename}>确定</button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="vd-history-actions" role="group" aria-label="画布历史">
          <button
            type="button"
            className="vd-icon-button"
            aria-label="撤销"
            title="撤销"
            disabled={!snapshot.canUndo || projectTransitioning}
            onClick={() => director.undo()}
          ><UndoIcon /></button>
          <button
            type="button"
            className="vd-icon-button"
            aria-label="重做"
            title="重做"
            disabled={!snapshot.canRedo || projectTransitioning}
            onClick={() => director.redo()}
          ><RedoIcon /></button>
        </div>
      </div>
      <div className="vd-topbar-spacer" />
      <div className="vd-topbar-actions">
        <div ref={runMenuRef} className="vd-run-menu-anchor">
          <button
            type="button"
            className="vd-run-button"
            disabled={!canRunWorkflow}
            aria-haspopup="menu"
            aria-expanded={runMenuOpen}
            title={workflowBusy ? '将当前工作流加入队列' : '运行画布工作流'}
            onClick={() => setRunMenuOpen(open => !open)}
          >
            <PlayIcon />
            <span className="vd-topbar-action-label">运行</span>
            <span className="vd-run-chevron" aria-hidden>⌄</span>
          </button>
          {runMenuOpen ? (
            <div className="vd-run-menu" role="menu" aria-label="运行工作流">
              <label className="vd-batch-control">
                <span>批次数</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={batchSize}
                  onChange={event => setBatchSize(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
                />
                <small>固定 seed 每批递增</small>
              </label>
              <button type="button" role="menuitem" onClick={() => runVdWorkflow('all')}>
                <span>运行全部</span><small>{String(runnableCount)} 个可执行节点</small>
              </button>
              <button type="button" role="menuitem" disabled={selectedNodeIds.size === 0} onClick={() => runVdWorkflow('selected')}>
                <span>运行所选</span><small>{String(selectedNodeIds.size)} 个已选节点</small>
              </button>
              <button type="button" role="menuitem" disabled={selectedNodeIds.size === 0} onClick={() => runVdWorkflow('from-selection')}>
                <span>从所选节点运行</span><small>包含所有下游节点</small>
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="vd-topbar-button vd-jobs-button" aria-label="任务" title="任务" onClick={onJobs}>
          <JobsIcon />
          <span className="vd-topbar-action-label">任务</span>
          {activeJobCount > 0 ? <span className="vd-jobs-count">{activeJobCount}</span> : null}
        </button>
        <button type="button" className="vd-topbar-button vd-settings-button" aria-label="设置" title="设置" onClick={onSettings}>
          <SettingsIcon />
          <span className="vd-topbar-action-label">设置</span>
        </button>
        <button
          type="button"
          className={`vd-save-button ${snapshot.dirty ? 'is-dirty' : ''}`}
          aria-label={snapshot.saving ? '保存中…' : '保存'}
          disabled={!snapshot.dirty || snapshot.saving || projectTransitioning || project === null}
          title={snapshot.dirty ? '保存当前工程' : '没有未保存更改'}
          onClick={() => { void director.saveProject().catch(swallow) }}
        >
          <SaveIcon />
          <span className="vd-topbar-action-label">{snapshot.saving ? '保存中…' : '保存'}</span>
        </button>
      </div>
      <button type="button" className="vd-close vd-close-icon-button" aria-label="关闭 Video Director" onClick={() => { void director.close() }}><CloseIcon /></button>
    </header>
  )
}

interface JobGroup {
  id: string
  workflowRun?: VdRun
  jobs: DirectorJob[]
  startedAt: string
}

function jobGroupStatus(group: JobGroup): DirectorJob['status'] | VdRun['status'] {
  if (group.workflowRun !== undefined) return group.workflowRun.status
  if (group.jobs.some(job => job.status === 'running')) return 'running'
  if (group.jobs.some(job => job.status === 'queued')) return 'queued'
  if (group.jobs.some(job => job.status === 'failed')) return 'failed'
  if (group.jobs.some(job => job.status === 'orphaned')) return 'orphaned'
  if (group.jobs.every(job => job.status === 'cancelled')) return 'cancelled'
  return 'completed'
}

function JobDrawer({
  snapshot,
  director,
  onClose,
}: {
  snapshot: DirectorSnapshot
  director: DirectorController
  onClose(): void
}) {
  const project = snapshot.project
  const [openArtifact, setOpenArtifact] = useState<PreviewArtifact | null>(null)
  useEffect(() => { void director.refreshVdRuns().catch(swallow) }, [director, project?.id])
  const exportWorkflow = async (runId: string): Promise<void> => {
    const exported = await director.exportVdWorkflow(runId)
    const url = URL.createObjectURL(new Blob([exported.text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = exported.filename
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const groups = useMemo<JobGroup[]>(() => {
    if (project === null) return []
    const byId = new Map<string, JobGroup>()
    for (const run of snapshot.workflowRuns.filter(candidate => candidate.projectId === project.id)) {
      byId.set(run.id, { id: run.id, workflowRun: run, jobs: [], startedAt: run.startedAt })
    }
    for (const job of [...project.jobs].reverse()) {
      const id = job.workflowRunId ?? `job:${job.id}`
      const existing = byId.get(id)
      if (existing !== undefined) existing.jobs.push(job)
      else byId.set(id, { id, jobs: [job], startedAt: job.createdAt })
    }
    return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }, [project, snapshot.workflowRuns])

  const nodeTitle = (nodeId: string): string => (
    project?.graph.nodes.find(node => node.id === nodeId)?.data.title ?? nodeId
  )
  return (
    <aside className="vd-job-drawer" aria-label="任务列表">
      <header>
        <div>
          <strong>任务</strong>
          <small>工作流运行与单节点任务</small>
        </div>
        <button type="button" className="vd-close-icon-button" aria-label="关闭任务列表" onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="vd-job-list">
        {groups.length === 0 ? <p className="vd-job-empty">尚无运行记录。</p> : groups.map(group => {
          const status = jobGroupStatus(group)
          const active = status === 'queued' || status === 'running'
          const groupedWorkflow = group.workflowRun !== undefined || group.jobs[0]?.workflowRunId !== undefined
          const completedJobs = group.workflowRun?.completedJobs
            ?? group.jobs.filter(job => !['queued', 'running'].includes(job.status)).length
          const totalJobs = group.workflowRun?.totalJobs ?? group.jobs.length
          return (
            <section key={group.id} className={`vd-job-group is-${status}`}>
              <header>
                <div>
                  <strong>{groupedWorkflow ? '工作流运行' : '单节点运行'}</strong>
                  <small>{new Date(group.startedAt).toLocaleString()}</small>
                </div>
                <span className="vd-job-status">{status}</span>
              </header>
              {groupedWorkflow ? (
                <div className="vd-job-summary">
                  <span>{group.workflowRun?.mode ?? group.jobs[0]?.workflowRunMode ?? 'workflow'}</span>
                  <span>{String(group.workflowRun?.batchSize ?? group.jobs[0]?.batchSize ?? 1)} 批</span>
                  <span>{String(completedJobs)} / {String(totalJobs)}</span>
                  {group.workflowRun !== undefined ? <>
                    <button type="button" onClick={() => { void director.openVdWorkflow(group.id).catch(swallow) }}>打开工作流</button>
                    <button type="button" onClick={() => { void exportWorkflow(group.id).catch(swallow) }}>导出工作流</button>
                  </> : null}
                  {active ? (
                    <button type="button" className="is-cancel" onClick={() => { void director.cancelVdRun(group.id).catch(swallow) }}>取消运行</button>
                  ) : null}
                </div>
              ) : null}
              {group.workflowRun?.error !== undefined ? <p className="vd-job-error">{group.workflowRun.error}</p> : null}
              <div className="vd-job-rows">
                {group.jobs.map(job => {
                  const jobActive = job.status === 'queued' || job.status === 'running'
                  const retryable = job.status === 'failed' || job.status === 'cancelled' || job.status === 'orphaned'
                  const artifacts = previewArtifactsFromResult(job.result)
                  return (
                    <article key={job.id}>
                      <div className="vd-job-row-title">
                        <strong>{nodeTitle(job.nodeId)}</strong>
                        <span>{job.providerId}</span>
                      </div>
                      <div className="vd-job-row-meta">
                        <span>{job.status} · {job.phase}</span>
                        {job.promptId === undefined ? null : <span title={job.promptId}>ComfyUI: {job.promptId}</span>}
                        {job.batchIndex === undefined ? null : <span>批次 {String(job.batchIndex + 1)}</span>}
                        <span>{String(Math.round(job.progress * 100))}%</span>
                      </div>
                      <div className="vd-job-progress"><i style={{ width: `${String(Math.round(job.progress * 100))}%` }} /></div>
                      {job.error !== undefined ? <p>{job.error}</p> : null}
                      {artifacts.length === 0 ? null : (
                        <div className="vd-job-artifacts" aria-label="任务产物">
                          {artifacts.map(artifact => (
                            <ArtifactThumbnail key={artifact.id} artifact={artifact} variant="job" onOpen={setOpenArtifact} />
                          ))}
                        </div>
                      )}
                      <div className="vd-job-row-actions">
                        {jobActive && !groupedWorkflow ? (
                          <button type="button" onClick={() => { void director.cancelJob(job.id).catch(swallow) }}>取消</button>
                        ) : retryable && project?.graph.nodes.some(node => node.id === job.nodeId) ? (
                          <button type="button" onClick={() => { void director.runNode(job.nodeId).catch(swallow) }}>重试节点</button>
                        ) : null}
                        {!jobActive ? (
                          <button
                            type="button"
                            className="is-delete"
                            onClick={() => {
                              if (!window.confirm('删除这条任务记录？项目素材不会被删除。')) return
                              void director.deleteJob(job.id).catch(swallow)
                            }}
                          >删除</button>
                        ) : null}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
      {openArtifact === null ? null : (
        <ArtifactPreviewDialog artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
      )}
    </aside>
  )
}

const CHAT_INPUT_PREFERENCES_KEY = 'dsh-video-director.chat-input-preferences.v1'
const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-transcribe'
const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'])

interface ChatInputPreferences {
  enterInsertsNewline: boolean
  speechProviderId: string
  speechModel: string
}

function loadChatInputPreferences(): ChatInputPreferences {
  const fallback = { enterInsertsNewline: false, speechProviderId: '', speechModel: DEFAULT_SPEECH_MODEL }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_INPUT_PREFERENCES_KEY) ?? 'null') as Partial<ChatInputPreferences> | null
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      enterInsertsNewline: parsed.enterInsertsNewline === true,
      speechProviderId: typeof parsed.speechProviderId === 'string' ? parsed.speechProviderId : '',
      speechModel: typeof parsed.speechModel === 'string' && parsed.speechModel.trim() !== '' ? parsed.speechModel : DEFAULT_SPEECH_MODEL,
    }
  } catch {
    return fallback
  }
}

function isChatImage(file: File): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
}

function isChatAudio(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  return extension !== undefined && AUDIO_EXTENSIONS.has(extension)
}

function ChatPanel({
  chat,
  director,
  providers,
  projectName,
  collapsed,
}: {
  chat: ProjectChatSource
  director: DirectorController
  providers: DirectorSnapshot['providers']
  projectName: string
  collapsed: boolean
}) {
  const snapshot = useSource(chat)
  const [text, setText] = useState('')
  const [images, setImages] = useState<Array<{ id: string; file: File; previewUrl: string }>>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [inputMenuOpen, setInputMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preferences, setPreferences] = useState(loadChatInputPreferences)
  const [speechBaseUrl, setSpeechBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [newSessionBusy, setNewSessionBusy] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recording, setRecording] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptionVersionRef = useRef(0)
  const transcriptionInFlightRef = useRef(false)
  const sessionIdRef = useRef(snapshot.sessionId)
  sessionIdRef.current = snapshot.sessionId
  const imagesRef = useRef(images)
  imagesRef.current = images
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [snapshot.messages, snapshot.running])
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl)
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current)
    const recorder = mediaRecorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    for (const track of recordingStreamRef.current?.getTracks() ?? []) track.stop()
  }, [])
  useEffect(() => {
    transcriptionVersionRef.current += 1
    transcriptionInFlightRef.current = false
    setTranscribing(false)
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current)
    recordingTimerRef.current = null
    const recorder = mediaRecorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    for (const track of recordingStreamRef.current?.getTracks() ?? []) track.stop()
    mediaRecorderRef.current = null
    recordingStreamRef.current = null
    recordingChunksRef.current = []
    setRecording(false)
    setText('')
    setAttachmentError(null)
    setImages(current => {
      for (const image of current) URL.revokeObjectURL(image.previewUrl)
      return []
    })
  }, [snapshot.sessionId])

  const modelChoices = snapshot.models.groups.flatMap(group => group.models.map(model => ({
    key: `${group.id}\u0000${model.id}`,
    provider: group.id,
    providerName: group.name,
    model,
  })))
  const currentModelValue = snapshot.models.current === null
    ? ''
    : `${snapshot.models.current.provider}\u0000${snapshot.models.current.model}`
  const currentModelKnown = modelChoices.some(choice => choice.key === currentModelValue)
  const speechProviders = providers.filter(provider => provider.kind === 'openai-compatible')
  const effectiveSpeechProviderId = speechProviders.some(provider => provider.id === preferences.speechProviderId)
    ? preferences.speechProviderId
    : speechProviders[0]?.id ?? ''
  const selectedSpeechProvider = speechProviders.find(provider => provider.id === effectiveSpeechProviderId)
  const editableBaseUrl = (provider: typeof selectedSpeechProvider): string => {
    const baseUrl = provider?.baseUrl?.replace(/\/$/u, '') ?? ''
    return baseUrl === OFFICIAL_OPENAI_BASE_URL ? '' : baseUrl
  }

  const updatePreferences = (patch: Partial<ChatInputPreferences>): void => {
    setPreferences(current => {
      const next = { ...current, ...patch }
      try { window.localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  const addImages = (files: Iterable<File>): void => {
    const incoming = [...files]
    const accepted = incoming.filter(isChatImage)
    setAttachmentError(accepted.length === incoming.length
      ? null
      : '仅支持 PNG、JPEG、WebP 和 GIF 图片。')
    if (accepted.length === 0) return
    setImages(current => [
      ...current,
      ...accepted.map(file => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) })),
    ])
  }

  const removeImage = (id: string): void => {
    setImages(current => current.filter(image => {
      if (image.id !== id) return true
      URL.revokeObjectURL(image.previewUrl)
      return false
    }))
  }

  const send = async () => {
    const value = text.trim()
    if ((value === '' && images.length === 0) || snapshot.sending || transcribing) return
    const outgoingImages = images
    setText('')
    setImages([])
    setAttachmentError(null)
    try {
      await chat.send(value, outgoingImages.map(image => image.file))
      for (const image of outgoingImages) URL.revokeObjectURL(image.previewUrl)
    } catch {
      setText(current => current === '' ? value : `${value}\n${current}`)
      setImages(current => [...outgoingImages, ...current])
    }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter') return
    const shouldSend = preferences.enterInsertsNewline ? event.altKey : !event.shiftKey
    if (shouldSend) {
      event.preventDefault()
      void send()
    }
  }

  const speechReady = (): { providerId: string; model: string } | null => {
    const model = preferences.speechModel.trim()
    if (selectedSpeechProvider === undefined || model === '' || (selectedSpeechProvider.requiresApiKey && !selectedSpeechProvider.apiKeySet)) {
      setInputMenuOpen(false)
      setSettingsOpen(true)
      setSettingsMessage(selectedSpeechProvider === undefined
        ? '请先配置一个 OpenAI-compatible Provider。'
        : model === ''
          ? '请输入语音转写模型。'
          : '请先填写并保存这个 Provider 的 API Key。')
      return null
    }
    return { providerId: selectedSpeechProvider.id, model }
  }

  const transcribeFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0 || transcriptionInFlightRef.current) return
    const speech = speechReady()
    if (speech === null) return
    const version = ++transcriptionVersionRef.current
    const sessionId = sessionIdRef.current
    transcriptionInFlightRef.current = true
    setTranscribing(true)
    setAttachmentError(null)
    try {
      for (const file of files) {
        const transcript = (await director.transcribeAudio(speech.providerId, speech.model, file)).trim()
        if (transcriptionVersionRef.current !== version || sessionIdRef.current !== sessionId) return
        setText(current => current.trim() === '' ? transcript : `${current.replace(/\s*$/u, '')}\n${transcript}`)
      }
    } catch (error) {
      if (transcriptionVersionRef.current === version && sessionIdRef.current === sessionId) {
        setAttachmentError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (transcriptionVersionRef.current === version) {
        transcriptionInFlightRef.current = false
        setTranscribing(false)
      }
    }
  }

  const addFiles = (files: Iterable<File>): void => {
    const incoming = [...files]
    const imageFiles = incoming.filter(isChatImage)
    const audioFiles = incoming.filter(file => !isChatImage(file) && isChatAudio(file))
    const unsupported = incoming.length - imageFiles.length - audioFiles.length
    if (imageFiles.length > 0) addImages(imageFiles)
    if (unsupported > 0) setAttachmentError('只支持 PNG、JPEG、WebP、GIF 图片，以及 FLAC、MP3、MP4、M4A、OGG、WAV、WebM 音频。')
    if (audioFiles.length > 0) void transcribeFiles(audioFiles)
  }

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }
  const dropFiles = (event: DragEvent<HTMLDivElement>): void => {
    const files = [...event.dataTransfer.files]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const stopRecording = (): void => {
    if (recordingTimerRef.current !== null) {
      clearTimeout(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    const recorder = mediaRecorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop()
  }

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      stopRecording()
      return
    }
    if (speechReady() === null) return
    if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
      setAttachmentError('当前浏览器不支持麦克风录音。')
      return
    }
    setAttachmentError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredMimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
        .find(candidate => MediaRecorder.isTypeSupported(candidate))
      const recorder = preferredMimeType === undefined
        ? new MediaRecorder(stream)
        : new MediaRecorder(stream, { mimeType: preferredMimeType })
      recordingStreamRef.current = stream
      recordingChunksRef.current = []
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = event => { if (event.data.size > 0) recordingChunksRef.current.push(event.data) }
      recorder.onerror = () => setAttachmentError('录音失败，请检查麦克风权限。')
      recorder.onstop = () => {
        if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current)
        recordingTimerRef.current = null
        for (const track of stream.getTracks()) track.stop()
        recordingStreamRef.current = null
        mediaRecorderRef.current = null
        setRecording(false)
        const chunks = recordingChunksRef.current
        recordingChunksRef.current = []
        if (chunks.length === 0) return
        const mimeType = recorder.mimeType.split(';', 1)[0] || 'audio/webm'
        const extension = mimeType === 'audio/mp4' ? 'm4a' : mimeType === 'audio/ogg' ? 'ogg' : 'webm'
        const file = new File(chunks, `recording-${Date.now()}.${extension}`, { type: mimeType })
        void transcribeFiles([file])
      }
      recorder.start(1_000)
      setRecording(true)
      recordingTimerRef.current = setTimeout(stopRecording, 5 * 60 * 1_000)
    } catch (error) {
      for (const track of recordingStreamRef.current?.getTracks() ?? []) track.stop()
      recordingStreamRef.current = null
      setRecording(false)
      setAttachmentError(error instanceof Error ? error.message : '无法访问麦克风。')
    }
  }

  const saveSpeechSettings = async (): Promise<void> => {
    if (selectedSpeechProvider === undefined) {
      setSettingsMessage('没有可用于语音转写的 OpenAI-compatible Provider。')
      return
    }
    if (preferences.speechModel.trim() === '') {
      setSettingsMessage('请输入语音转写模型。')
      return
    }
    if (selectedSpeechProvider.requiresApiKey && !selectedSpeechProvider.apiKeySet && apiKey.trim() === '') {
      setSettingsMessage('请输入 API Key。')
      return
    }
    setSettingsBusy(true)
    setSettingsMessage(null)
    try {
      await director.updateProvider(selectedSpeechProvider.id, {
        baseUrl: speechBaseUrl.trim(),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      })
      setApiKey('')
      setApiKeyVisible(false)
      setSettingsMessage('语音输入设置已保存。')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSettingsBusy(false)
    }
  }

  const startNewSession = async (): Promise<void> => {
    if (newSessionBusy) return
    setNewSessionBusy(true)
    setSettingsMessage(null)
    try {
      await director.startNewChatSession()
      setSettingsMessage('已创建新会话，画布保持不变。')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setNewSessionBusy(false)
    }
  }
  return (
    <aside className="vd-chat-panel" aria-hidden={collapsed}>
      <div className="vd-chat-context">
        <span>上下文已绑定</span>
        <strong>{projectName}</strong>
      </div>
      <div className="vd-messages" aria-live="polite">
        {snapshot.messages.length === 0 ? (
          <div className="vd-chat-placeholder">
            <span aria-hidden>⌁</span>
            <p>和 DeepSeek 一起编排当前画布。连线、素材与任务状态会作为工程上下文发送。</p>
          </div>
        ) : snapshot.messages.map(message => (
          <article key={message.id} className={`vd-message vd-message-${message.role}`}>
            <header>{message.role === 'user' ? '你' : 'DeepSeek'}</header>
            <div>{message.text}</div>
          </article>
        ))}
        {snapshot.running ? <div className="vd-thinking"><span /><span /><span /></div> : null}
        <div ref={bottomRef} />
      </div>
      {snapshot.error !== null ? (
        <button type="button" className="vd-chat-error" onClick={chat.clearError}>{snapshot.error}</button>
      ) : null}
      <div
        className="vd-chat-composer"
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDrop={dropFiles}
      >
        {images.length > 0 ? (
          <div className="vd-chat-images" aria-label="待发送图片">
            {images.map(image => (
              <span key={image.id} className="vd-chat-image">
                <img src={image.previewUrl} alt={image.file.name || '待发送图片'} />
                <button type="button" className="vd-close-icon-button" aria-label={`移除 ${image.file.name || '图片'}`} onClick={() => removeImage(image.id)}><CloseIcon /></button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          value={text}
          rows={3}
          placeholder="询问当前工程，支持粘贴或拖入图片、音频…"
          onChange={event => setText(event.target.value)}
          onKeyDown={keyDown}
          onPaste={paste}
        />
        <span className="vd-chat-context-note">画布上下文自动附带</span>
        {transcribing ? <span className="vd-chat-transcribing"><i /> 正在转写音频…</span> : null}
        {attachmentError === null ? null : <span className="vd-chat-attachment-error">{attachmentError}</span>}
        <div className="vd-chat-composer-footer">
          <div className="vd-chat-composer-tools">
            <div className="vd-chat-tool-anchor">
              <button
                type="button"
                className="vd-chat-icon-button"
                aria-label="添加多模态输入"
                title="添加多模态输入"
                aria-expanded={inputMenuOpen}
                disabled={snapshot.sending || transcribing}
                onClick={() => { setInputMenuOpen(open => !open); setSettingsOpen(false) }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              {inputMenuOpen ? (
                <div className="vd-chat-add-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setInputMenuOpen(false); imageInputRef.current?.click() }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 16l4-4 3 3 2-2 7 6M15.5 9.5h.01" /></svg>
                    <span><strong>图片</strong><small>选择 PNG、JPEG、WebP 或 GIF</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setInputMenuOpen(false); audioInputRef.current?.click() }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13M9 9l10-2M6 21c1.7 0 3-1 3-2.3S7.7 16.5 6 16.5s-3 1-3 2.2S4.3 21 6 21Zm10-2c1.7 0 3-1 3-2.3s-1.3-2.2-3-2.2-3 1-3 2.2S14.3 19 16 19Z" /></svg>
                    <span><strong>音频</strong><small>选择文件并转写到输入框</small></span>
                  </button>
                </div>
              ) : null}
            </div>
            <div className="vd-chat-tool-anchor">
              <button
                type="button"
                className="vd-chat-icon-button"
                aria-label="聊天输入设置"
                title="聊天输入设置"
                aria-expanded={settingsOpen}
                onClick={() => {
                  setSettingsOpen(open => {
                    if (!open) {
                      setSpeechBaseUrl(editableBaseUrl(selectedSpeechProvider))
                      setApiKeyVisible(false)
                    }
                    return !open
                  })
                  setInputMenuOpen(false)
                  setSettingsMessage(null)
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
              {settingsOpen ? (
                <div className="vd-chat-settings-popover" role="dialog" aria-label="聊天输入设置">
                  <header><strong>聊天输入设置</strong><button type="button" className="vd-close-icon-button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><CloseIcon /></button></header>
                  <button
                    type="button"
                    className="vd-chat-new-session"
                    disabled={newSessionBusy}
                    onClick={() => { void startNewSession() }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14M4 4h16v16H4z" /></svg>
                    <span><strong>{newSessionBusy ? '正在创建新会话…' : '新会话'}</strong><small>保留当前画布，清空聊天上下文</small></span>
                  </button>
                  <label className="vd-chat-setting-toggle">
                    <input
                      type="checkbox"
                      checked={preferences.enterInsertsNewline}
                      onChange={event => updatePreferences({ enterInsertsNewline: event.target.checked })}
                    />
                    <span><strong>Enter 换行</strong><small>开启后使用 Alt + Enter 发送</small></span>
                  </label>
                  <div className="vd-chat-settings-section">
                    <strong>语音转写</strong>
                    <label><span>Provider</span>
                      <select
                        value={effectiveSpeechProviderId}
                        disabled={speechProviders.length === 0}
                        onChange={event => {
                          const provider = speechProviders.find(candidate => candidate.id === event.target.value)
                          updatePreferences({ speechProviderId: event.target.value })
                          setSpeechBaseUrl(editableBaseUrl(provider))
                          setApiKey('')
                          setApiKeyVisible(false)
                          setSettingsMessage(null)
                        }}
                      >
                        {speechProviders.length === 0 ? <option value="">没有 OpenAI-compatible Provider</option> : null}
                        {speechProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                      </select>
                    </label>
                    <label><span>Base URL</span>
                      <input
                        value={speechBaseUrl}
                        placeholder={`${OFFICIAL_OPENAI_BASE_URL}（留空使用官方 API）`}
                        onChange={event => setSpeechBaseUrl(event.target.value)}
                      />
                    </label>
                    <label><span>API Key {selectedSpeechProvider?.apiKeySet ? '· 已保存（不会回显）' : ''}</span>
                      <div className="vd-chat-secret-input">
                        <input
                          type={apiKeyVisible ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={apiKey}
                          placeholder={selectedSpeechProvider?.apiKeySet ? '留空以保留当前密钥' : '输入 API Key'}
                          onChange={event => setApiKey(event.target.value)}
                        />
                        <button
                          type="button"
                          aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}
                          aria-pressed={apiKeyVisible}
                          title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}
                          onClick={() => setApiKeyVisible(visible => !visible)}
                        >
                          {apiKeyVisible ? (
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.8 10.8 0 0 1 12 4c5.5 0 9 6 9 6a15.4 15.4 0 0 1-2.1 2.8M6.2 6.2C4.2 7.6 3 10 3 10s3.5 6 9 6c1 0 2-.2 2.8-.5" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Zm9 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /></svg>
                          )}
                        </button>
                      </div>
                    </label>
                    <label><span>语音模型</span>
                      <input
                        value={preferences.speechModel}
                        placeholder={DEFAULT_SPEECH_MODEL}
                        onChange={event => updatePreferences({ speechModel: event.target.value })}
                      />
                    </label>
                    <button type="button" className="vd-chat-settings-save" disabled={settingsBusy || speechProviders.length === 0} onClick={() => { void saveSpeechSettings() }}>
                      {settingsBusy ? '保存中…' : '保存语音设置'}
                    </button>
                    {settingsMessage !== null ? <span className="vd-chat-settings-message">{settingsMessage}</span> : null}
                  </div>
                </div>
              ) : null}
            </div>
            <select
              aria-label="聊天模型"
              title={snapshot.models.error ?? '切换当前工程会话模型'}
              value={currentModelValue}
              disabled={snapshot.models.status === 'loading' || snapshot.models.status === 'selecting' || modelChoices.length === 0}
              onChange={event => {
                const choice = modelChoices.find(candidate => candidate.key === event.target.value)
                if (choice === undefined) return
                void chat.selectModel({
                  provider: choice.provider,
                  model: choice.model.id,
                  ...(choice.model.reasoning?.defaultEffort === undefined
                    ? {}
                    : { reasoningEffort: choice.model.reasoning.defaultEffort }),
                }).catch(swallow)
              }}
            >
              {snapshot.models.status === 'loading' ? <option value="">加载模型中…</option> : null}
              {snapshot.models.status !== 'loading' && snapshot.models.current === null ? <option value="">选择模型</option> : null}
              {!currentModelKnown && snapshot.models.current !== null ? (
                <option value={currentModelValue}>{snapshot.models.current.provider}/{snapshot.models.current.model}</option>
              ) : null}
              {modelChoices.length === 0 && snapshot.models.status !== 'loading' ? <option value="">没有可用模型</option> : null}
              {snapshot.models.groups.map(group => (
                <optgroup key={group.id} label={group.name}>
                  {group.models.map(model => (
                    <option key={model.id} value={`${group.id}\u0000${model.id}`}>{model.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="vd-chat-submit-tools">
            <button
              type="button"
              className={`vd-chat-microphone ${recording ? 'is-recording' : ''}`}
              aria-label={recording ? '停止录音' : '开始语音输入'}
              title={recording ? '停止录音并转写' : '语音输入'}
              disabled={!recording && (snapshot.sending || transcribing)}
              onClick={() => { void toggleRecording() }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4Zm-7-4a7 7 0 0 0 14 0M12 18v4M8 22h8" /></svg>
            </button>
            <button
              type="button"
              className="vd-chat-send"
              aria-label={snapshot.sending ? '发送中' : '发送'}
              title={preferences.enterInsertsNewline ? '发送（Alt + Enter）' : '发送（Enter）'}
              disabled={snapshot.sending || transcribing || (text.trim() === '' && images.length === 0)}
              onClick={() => { void send() }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 4-4" /></svg>
            </button>
          </div>
        </div>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={event => {
            if (event.target.files !== null) addImages(event.target.files)
            event.target.value = ''
          }}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.flac,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm"
          multiple
          hidden
          onChange={event => {
            if (event.target.files !== null) void transcribeFiles([...event.target.files])
            event.target.value = ''
          }}
        />
      </div>
    </aside>
  )
}

function EdgeInspector({
  edge,
  onChange,
  onClose,
  onDelete,
}: {
  edge: DirectorEdge
  onChange(patch: Partial<NonNullable<DirectorEdge['data']>>): void
  onClose(): void
  onDelete(): void
}) {
  const role = edge.data?.role ?? 'visual'
  const includeAudio = edge.data?.includeAudio === true
  return (
    <div className="vd-edge-inspector">
      <div><strong>参考连线</strong><button type="button" className="vd-close-icon-button" aria-label="关闭参考连线" onClick={onClose}><CloseIcon /></button></div>
      <label>
        语义角色
        <select value={role} onChange={event => onChange({ role: event.target.value })}>
          <option value="visual">画面</option>
          <option value="motion">运动</option>
          <option value="camera">镜头</option>
          <option value="voice">人声</option>
          <option value="music">音乐</option>
          <option value="sound">音效</option>
        </select>
      </label>
      <label className="vd-check">
        <input type="checkbox" checked={includeAudio} onChange={event => onChange({ includeAudio: event.target.checked })} />
        将视频原音传给模型
      </label>
      <small>运动/镜头参考默认不携带音轨；仅在确实需要声音时开启。</small>
      <button type="button" className="vd-edge-delete-button" aria-label="删除参考连线" onClick={onDelete}>删除连线</button>
    </div>
  )
}

interface NodeContextMenuPosition {
  nodeId: string
  screen: { x: number; y: number }
}

interface ParameterInputPickerPosition {
  nodeId: string
  screen: { x: number; y: number }
}

const REMOTE_NODE_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
  'vram-trigger',
  'ollama-eject',
  'comfyui-clear',
])

function NodeContextMenu({
  position,
  node,
  canRun,
  onRun,
  onCancel,
  onFreeze,
  onCopy,
  onDuplicate,
  inputCandidateCount,
  onParameterInputs,
  onMask,
  onRename,
  onDetails,
  videoPreview,
  onSaveVideo,
  onVideoProperties,
  onDelete,
  onClose,
}: {
  position: NodeContextMenuPosition
  node: DirectorNode
  canRun: boolean
  onRun(): void
  onCancel(): void
  onFreeze(): void
  onCopy(): void
  onDuplicate(): void
  inputCandidateCount: number
  onParameterInputs(): void
  onMask(): void
  onRename(): void
  onDetails(): void
  videoPreview: boolean
  onSaveVideo(): void
  onVideoProperties(): void
  onDelete(): void
  onClose(): void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const busy = node.data.status === 'queued' || node.data.status === 'running'
  const dependencyRunnable = node.data.kind === 'preview'
  const runnable = REMOTE_NODE_KINDS.has(node.data.kind) || dependencyRunnable
  const maskable = (node.data.mediaKind === 'image' || node.data.mediaKind === 'video') && node.data.asset !== undefined
  const clip = node.data.mediaKind === 'audio' || node.data.mediaKind === 'video'
  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
    const focusTarget = firstItem ?? menuRef.current
    focusTarget?.focus()
  }, [])
  useEffect(() => {
    const pointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('keydown', keyDown)
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('keydown', keyDown)
    }
  }, [onClose])

  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      onClose()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={menuRef}
      className="vd-node-context-menu"
      role="menu"
      aria-orientation="vertical"
      aria-label={`${node.data.title} 节点菜单`}
      tabIndex={-1}
      style={{ left: position.screen.x, top: position.screen.y }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={navigateMenu}
    >
      <header>
        <strong>{node.data.title}</strong>
        <span>{node.data.kind}</span>
      </header>
      {runnable ? (
        <div className="vd-node-context-group">
          {busy ? (
            <button type="button" role="menuitem" disabled={node.data.jobId === undefined} onClick={onCancel}>
              <span aria-hidden>■</span><span>Cancel run<small>{node.data.phase ?? 'running'}</small></span>
            </button>
          ) : (
            <button type="button" role="menuitem" disabled={!canRun} onClick={onRun}>
              <span aria-hidden>▶</span><span>Run node<small>{dependencyRunnable ? '运行全部未冻结上游依赖' : '按当前未保存画布快照运行'}</small></span>
            </button>
          )}
        </div>
      ) : null}
      {videoPreview ? (
        <div className="vd-node-context-group">
          <button type="button" role="menuitem" onClick={onSaveVideo}>
            <span aria-hidden>⇩</span><span>保存视频…<small>下载原始输出文件</small></span>
          </button>
          <button type="button" role="menuitem" onClick={onVideoProperties}>
            <span aria-hidden>ⓘ</span><span>视频属性…<small>尺寸、时长、格式与文件信息</small></span>
          </button>
        </div>
      ) : null}
      <div className="vd-node-context-group">
        <button type="button" role="menuitem" disabled={busy} onClick={onFreeze}>
          <span aria-hidden>{node.data.frozen === true ? '◇' : '◆'}</span>
          <span>{node.data.frozen === true ? 'Unfreeze' : 'Freeze'}<small>{node.data.frozen === true ? '允许节点再次运行和更新' : '复用当前结果并跳过运行'}</small></span>
        </button>
        <button type="button" role="menuitem" disabled={inputCandidateCount === 0} onClick={onParameterInputs}>
          <span aria-hidden>◉</span>
          <span>
            参数输入…
            <small>{inputCandidateCount === 0 ? '没有可转换的文本参数' : `${String(inputCandidateCount)} 个文本参数`}</small>
          </span>
        </button>
        {maskable ? (
          <button type="button" role="menuitem" onClick={onMask}>
            <span aria-hidden>◩</span><span>创建 Mask 副本<small>保留原素材与节点</small></span>
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={onCopy}>
          <span aria-hidden>▣</span><span>Copy<small>Ctrl+C · 复制到画布剪贴板</small></span>
        </button>
        <button type="button" role="menuitem" onClick={onDuplicate}>
          <span aria-hidden>⧉</span><span>{clip ? '复制当前裁剪' : 'Duplicate'}<small>创建独立节点副本</small></span>
        </button>
        <button type="button" role="menuitem" onClick={onRename}>
          <span aria-hidden>✎</span><span>重命名<small>编辑节点标题</small></span>
        </button>
        <button type="button" role="menuitem" onClick={onDetails}>
          <span aria-hidden>ⓘ</span><span>查看节点属性<small>类型、端口与运行引用</small></span>
        </button>
      </div>
      <div className="vd-node-context-group">
        <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={onDelete}>
          <span aria-hidden>⌫</span><span>删除节点<small>{busy ? '请先取消当前运行' : '同时删除相关连线'}</small></span>
        </button>
      </div>
    </div>
  )
}

function ParameterInputPicker({
  position,
  node,
  definition,
  edges,
  onToggle,
  onClose,
}: {
  position: ParameterInputPickerPosition
  node: DirectorNode
  definition?: VdNodeDefinitionDescriptor
  edges: readonly DirectorEdge[]
  onToggle(fieldId: string, enabled: boolean): void
  onClose(restoreFocus?: boolean): void
}) {
  const [query, setQuery] = useState('')
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const candidates = useMemo(
    () => parameterInputCandidates(node.data, definition).filter(candidate => candidate.type === 'text'),
    [definition, node.data],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = normalizedQuery === ''
    ? candidates
    : candidates.filter(candidate => `${candidate.label} ${candidate.id}`.toLocaleLowerCase().includes(normalizedQuery))

  useEffect(() => {
    searchRef.current?.focus()
    const pointerDown = (event: PointerEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) onClose(false)
    }
    const focusIn = (event: FocusEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) onClose(false)
    }
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('focusin', focusIn)
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('focusin', focusIn)
    }
  }, [onClose])

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
      return
    }
    const items = [...(pickerRef.current?.querySelectorAll<HTMLButtonElement>('.vd-parameter-input-list button') ?? [])]
    if (items.length === 0) return
    if (event.key === 'ArrowDown' && event.target === searchRef.current) {
      event.preventDefault()
      items[0]?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (!(event.target instanceof HTMLButtonElement) || !items.includes(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const current = items.indexOf(event.target)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={pickerRef}
      className="vd-parameter-input-picker"
      role="dialog"
      aria-modal="false"
      aria-labelledby="vd-parameter-input-title"
      style={{ left: position.screen.x, top: position.screen.y }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={navigate}
    >
      <header>
        <div>
          <span>PARAMETER INPUTS</span>
          <strong id="vd-parameter-input-title">{node.data.title}</strong>
        </div>
        <button type="button" className="vd-close-icon-button" aria-label="关闭参数输入" onClick={() => onClose(true)}><CloseIcon /></button>
      </header>
      <label className="vd-parameter-input-search">
        <span aria-hidden>⌕</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          aria-label="搜索文本参数"
          placeholder="搜索参数名称或 ID…"
          onChange={event => setQuery(event.target.value)}
        />
        <kbd>Esc</kbd>
      </label>
      <div className="vd-parameter-input-list" role="group" aria-label="可转换的文本参数">
        {filtered.map(candidate => {
          const enabled = fieldInputModeEnabled(node.data, candidate.id)
          const portId = fieldInputPortId(candidate.id)
          const edgeCount = edges.filter(edge => (
            edge.target === node.id && edge.data?.targetPortId === portId
          )).length
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={enabled}
              aria-label={`${candidate.label}，${enabled ? '输入端口' : '控件'}，${String(edgeCount)} 条连线`}
              onClick={() => onToggle(candidate.id, !enabled)}
            >
              <span className={`vd-parameter-input-state ${enabled ? 'is-input' : ''}`} aria-hidden>
                {enabled ? 'IN' : 'UI'}
              </span>
              <span className="vd-parameter-input-copy">
                <strong>{candidate.label}</strong>
                <code>{candidate.id}</code>
                <small>
                  {enabled
                    ? edgeCount === 0
                      ? '输入端口 · 尚未连接'
                      : `输入端口 · ${String(edgeCount)} 条连线`
                    : '控件 · 点击转为输入端口'}
                </small>
              </span>
              <span className={`vd-parameter-input-switch ${enabled ? 'is-on' : ''}`} aria-hidden>
                <i />
              </span>
            </button>
          )
        })}
        {filtered.length === 0 ? <p>没有匹配的文本参数</p> : null}
      </div>
      <footer>转为输入端口后，未连接时仍使用当前值；连接后由上游文本覆盖。</footer>
    </div>
  )
}

function NodeDetails({
  node,
  snapshot,
  onClose,
}: {
  node: DirectorNode
  snapshot: DirectorSnapshot
  onClose(): void
}) {
  const definition = nodeDefinition(node.data, snapshot.nodeDefinitions)
  const provider = snapshot.providers.find(candidate => candidate.id === node.data.providerId)
  const workflow = snapshot.workflows.find(candidate => candidate.id === (definition?.workflowId ?? node.data.workflowId))
  const inputs = inputPortsFor(node.data, definition)
  const outputs = portsFor(definition, 'output')
  const rows: Array<[string, string]> = [
    ['标题', node.data.title],
    ['vd-node ID', node.id],
    ['Kind', node.data.kind],
    ['vd-node definition', node.data.nodeType === undefined ? '内置兼容节点' : `${node.data.nodeType}@${node.data.nodeVersion ?? '1.0.0'}`],
    ['Provider', provider === undefined ? (node.data.providerId ?? '—') : `${provider.label} · ${provider.id}`],
    ['comfyui-workflow', workflow === undefined ? (node.data.workflowId ?? '—') : `${workflow.name} · ${workflow.id}`],
    ['状态', `${node.data.status ?? 'idle'}${node.data.phase === undefined ? '' : ` · ${node.data.phase}`}`],
    ['vd-job', node.data.jobId ?? '—'],
    ['素材', node.data.asset === undefined ? '—' : `${node.data.asset.name} · ${node.data.asset.kind}`],
    ['输入端口', inputs.length === 0 ? '—' : inputs.map(port => `${port.label} (${port.types.join(' / ')})`).join(', ')],
    ['输出端口', outputs.length === 0 ? '—' : outputs.map(port => `${port.label} (${port.types.join(' / ')})`).join(', ')],
  ]
  return (
    <aside className="vd-node-details" aria-label="节点属性">
      <header><div><span>NODE DETAILS</span><strong>{node.data.title}</strong></div><button type="button" className="vd-close-icon-button" aria-label="关闭节点属性" onClick={onClose}><CloseIcon /></button></header>
      <dl>
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {node.data.nodeDigest !== undefined ? <footer title={node.data.nodeDigest}>Definition digest · {node.data.nodeDigest}</footer> : null}
    </aside>
  )
}

type NodeMenuAction =
  | { kind: 'text' }
  | { kind: 'file'; mediaKind: 'image' | 'audio' | 'video' }
  | { kind: 'sketch' }
  | { kind: 'workflow'; workflowKind: 'prompt-enhancer' | 'image-generation' | 'video-generation' | 'audio-generation' }
  | { kind: 'definition'; type: string; version?: string }

interface NodeMenuItem {
  key: string
  label: string
  description: string
  category: 'Inputs' | 'Workflows' | 'Utilities' | 'Outputs' | 'Custom Node'
  icon: string
  search: string
  action: NodeMenuAction
  inputs: readonly VdPortDescriptor[]
}

interface PendingNodeConnection {
  source: string
  sourceHandle: string
  sourceTypes: MediaKind[]
}

interface NodeMenuPosition {
  screen: { x: number; y: number }
  flow: { x: number; y: number }
  connection?: PendingNodeConnection
}

interface NodeMenuCandidate {
  item: NodeMenuItem
  targetPort?: VdPortDescriptor
}

const NODE_MENU_CATEGORY_LABELS: Record<NodeMenuItem['category'], string> = {
  Inputs: '输入节点',
  Workflows: '工作流',
  Utilities: '资源管理',
  Outputs: '输出节点',
  'Custom Node': 'Custom Node',
}

function NodeAddMenu({
  position,
  definitions,
  onChoose,
  onClose,
}: {
  position: NodeMenuPosition
  definitions: VdNodeDefinitionDescriptor[]
  onChoose(action: NodeMenuAction, targetPort?: VdPortDescriptor): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const pointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('keydown', keyDown)
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('keydown', keyDown)
    }
  }, [onClose])

  const items = useMemo<NodeMenuItem[]>(() => {
    const workflowInputs = (kind: Extract<DirectorNodeData['kind'], 'prompt-enhancer' | 'image-generation' | 'video-generation' | 'audio-generation'>): VdPortDescriptor[] => {
      const input = implicitInputPortForKind(kind)
      return [...(input === undefined ? [] : [input]), { id: 'flow', label: 'Flow', types: ['flow'], multiple: true }]
    }
    const regular: NodeMenuItem[] = [
      { key: 'input:text', label: 'Text', description: '添加可编辑文字输入', category: 'Inputs', icon: 'T', search: 'text 文字 input', action: { kind: 'text' }, inputs: [] },
      { key: 'input:image', label: 'Image', description: '从本地选择图像', category: 'Inputs', icon: '▧', search: 'image 图像 图片 input', action: { kind: 'file', mediaKind: 'image' }, inputs: [] },
      { key: 'input:audio', label: 'Audio', description: '从本地选择音频', category: 'Inputs', icon: '♫', search: 'audio 音频 input', action: { kind: 'file', mediaKind: 'audio' }, inputs: [] },
      { key: 'input:video', label: 'Video', description: '从本地选择视频', category: 'Inputs', icon: '▶', search: 'video 视频 input', action: { kind: 'file', mediaKind: 'video' }, inputs: [] },
      { key: 'input:sketch', label: 'Sketch', description: '绘制并添加草稿', category: 'Inputs', icon: '✎', search: 'sketch 草稿 手绘 input', action: { kind: 'sketch' }, inputs: [] },
      { key: 'workflow:prompt', label: 'Prompt Enhancer', description: '扩写与优化提示词', category: 'Workflows', icon: '✨', search: 'prompt enhancer 提示词 增强 workflow', action: { kind: 'workflow', workflowKind: 'prompt-enhancer' }, inputs: workflowInputs('prompt-enhancer') },
      { key: 'workflow:image', label: 'Image Processing', description: '通过已配置 workflow 处理图像', category: 'Workflows', icon: '◈', search: 'image processing generate edit 处理生成编辑图像 workflow', action: { kind: 'workflow', workflowKind: 'image-generation' }, inputs: workflowInputs('image-generation') },
      { key: 'workflow:video', label: 'H3 Video', description: '通过 MiniMax H3 生成视频', category: 'Workflows', icon: '◉', search: 'h3 minimax video 视频 workflow', action: { kind: 'workflow', workflowKind: 'video-generation' }, inputs: workflowInputs('video-generation') },
      { key: 'workflow:audio', label: 'H3 Audio', description: '通过 MiniMax H3 生成音频', category: 'Workflows', icon: '∿', search: 'h3 minimax audio 音频 workflow', action: { kind: 'workflow', workflowKind: 'audio-generation' }, inputs: workflowInputs('audio-generation') },
    ]
    const outputDefinitions = definitions.filter(definition => definition.type === 'core.preview' || definition.type === 'core.save')
      .map<NodeMenuItem>(definition => ({
        key: `${definition.type}@${definition.version}`,
        label: definition.title,
        description: definition.description,
        category: 'Outputs',
        icon: definition.behavior === 'preview' ? '◫' : '⇩',
        search: `${definition.title} ${definition.type} ${definition.category} ${definition.description}`,
        action: { kind: 'definition', type: definition.type, version: definition.version },
        inputs: definition.inputs,
      }))
    const utilityDefinitions = definitions.filter(definition => definition.behavior === 'trigger')
      .map<NodeMenuItem>(definition => ({
        key: `${definition.type}@${definition.version}`,
        label: definition.title,
        description: definition.description,
        category: 'Utilities',
        icon: '⏏',
        search: `${definition.title} ${definition.type} ${definition.description} VRAM unload eject clear cache`,
        action: { kind: 'definition', type: definition.type, version: definition.version },
        inputs: definition.inputs,
      }))
    const customDefinitions = definitions.filter(definition => (
      definition.type !== 'core.preview'
      && definition.type !== 'core.save'
      && definition.behavior !== 'trigger'
    ))
      .map<NodeMenuItem>(definition => ({
        key: `${definition.type}@${definition.version}`,
        label: definition.title,
        description: `${definition.category} · ${definition.description}`,
        category: 'Custom Node',
        icon: '◇',
        search: `${definition.title} ${definition.type} ${definition.category} ${definition.description}`,
        action: { kind: 'definition', type: definition.type, version: definition.version },
        inputs: definition.inputs,
      }))
    return [...regular, ...utilityDefinitions, ...outputDefinitions, ...customDefinitions]
  }, [definitions])
  const candidates: NodeMenuCandidate[] = position.connection === undefined
    ? items.map(item => ({ item }))
    : items.flatMap(item => {
      const targetPort = preferredCompatibleInputPort(item.inputs, position.connection?.sourceTypes ?? [])
      return targetPort === undefined ? [] : [{ item, targetPort }]
    })
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = normalizedQuery === ''
    ? candidates
    : candidates.filter(({ item }) => `${item.label} ${item.search}`.toLocaleLowerCase().includes(normalizedQuery))
  const categories: NodeMenuItem['category'][] = ['Inputs', 'Workflows', 'Utilities', 'Outputs', 'Custom Node']

  return (
    <div
      ref={menuRef}
      className="vd-node-menu"
      role="dialog"
      aria-label={position.connection === undefined ? '添加节点' : '添加并连接节点'}
      style={{ left: position.screen.x, top: position.screen.y }}
      onDoubleClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="vd-node-menu-search">
        <span aria-hidden>⌕</span>
        <input
          autoFocus
          value={query}
          type="search"
          aria-label="搜索节点"
          placeholder={position.connection === undefined ? '搜索节点名称或类型…' : '搜索兼容节点…'}
          onChange={event => setQuery(event.target.value)}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="vd-node-menu-list" role="listbox" aria-label="可添加的节点">
        {categories.map(category => {
          const categoryItems = filtered.filter(({ item }) => item.category === category)
          if (categoryItems.length === 0) return null
          return (
            <section key={category} className="vd-node-menu-group">
              <h3>{NODE_MENU_CATEGORY_LABELS[category]}</h3>
              {categoryItems.map(({ item, targetPort }) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => onChoose(item.action, targetPort)}
                >
                  <span className="vd-node-menu-icon" aria-hidden>{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{targetPort === undefined ? item.description : `连接到 ${targetPort.label} · ${item.description}`}</small>
                  </span>
                </button>
              ))}
            </section>
          )
        })}
        {filtered.length === 0 ? <p className="vd-node-menu-empty">没有匹配的节点</p> : null}
      </div>
    </div>
  )
}

function CanvasStage({
  snapshot,
  director,
  interactionMode,
  onInteractionModeChange,
  selectedNodeIds,
  onSelectedNodeIdsChange,
}: {
  snapshot: DirectorSnapshot
  director: DirectorController
  interactionMode: CanvasInteractionMode
  onInteractionModeChange(mode: CanvasInteractionMode): void
  selectedNodeIds: ReadonlySet<string>
  onSelectedNodeIdsChange(ids: Set<string>): void
}) {
  const project = snapshot.project
  const [instance, setInstance] = useState<ReactFlowInstance<DirectorNode, DirectorEdge> | null>(null)
  const [sketchOpen, setSketchOpen] = useState(false)
  const [sketchPosition, setSketchPosition] = useState<{ x: number; y: number } | undefined>()
  const [sketchNodeId, setSketchNodeId] = useState<string | null>(null)
  const [maskNodeId, setMaskNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [measuredNodeSizes, setMeasuredNodeSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [nodeMenu, setNodeMenu] = useState<NodeMenuPosition | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuPosition | null>(null)
  const [canvasContextMenu, setCanvasContextMenu] = useState<NodeMenuPosition | null>(null)
  const [selectionModifierPressed, setSelectionModifierPressed] = useState(false)
  const [spacePressed, setSpacePressed] = useState(false)
  const [resettingVram, setResettingVram] = useState(false)
  const [canvasNotice, setCanvasNotice] = useState<string | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [parameterInputPicker, setParameterInputPicker] = useState<ParameterInputPickerPosition | null>(null)
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null)
  const [openArtifact, setOpenArtifact] = useState<{ artifact: PreviewArtifact; properties: boolean } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [miniMapVisible, setMiniMapVisible] = useState(true)
  const [controlsLayer, setControlsLayer] = useState<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const ignoreNextPaneClickRef = useRef(false)
  const pastePositionRef = useRef<{ x: number; y: number } | null>(null)
  const selectionGestureRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean; nodeId?: string; previous: Set<string> } | null>(null)
  const pendingFileRef = useRef<{ mediaKind: 'image' | 'audio' | 'video'; position: { x: number; y: number } } | null>(null)
  const nodeTypes = useMemo(() => ({ director: DirectorNodeView }), [])
  useEffect(() => {
    onSelectedNodeIdsChange(new Set())
    setMeasuredNodeSizes({})
    setSelectedEdgeId(null)
    setNodeMenu(null)
    setNodeContextMenu(null)
    setCanvasContextMenu(null)
    setCanvasNotice(null)
    pastePositionRef.current = null
    selectionGestureRef.current = null
    setSelectionBox(null)
    setParameterInputPicker(null)
    setDetailsNodeId(null)
    setOpenArtifact(null)
    setSketchOpen(false)
    setSketchPosition(undefined)
    setSketchNodeId(null)
  }, [onSelectedNodeIdsChange, project?.id, snapshot.canvasResetVersion])

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      setSelectionModifierPressed(event.ctrlKey || event.metaKey)
      if (isCanvasTextInput(event.target)) return
      if (event.code === 'Space' && stageRef.current?.contains(event.target as Node)) {
        event.preventDefault()
        setSpacePressed(true)
      }
    }
    const keyUp = (event: globalThis.KeyboardEvent): void => {
      setSelectionModifierPressed(event.ctrlKey || event.metaKey)
      if (event.code === 'Space') setSpacePressed(false)
    }
    const reset = (): void => { setSelectionModifierPressed(false); setSpacePressed(false) }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const handMode = (interactionMode === 'hand' || spacePressed) && !selectionModifierPressed
  const pasteNodes = (at?: { x: number; y: number }): void => {
    if (instance === null || stageRef.current === null) return
    const bounds = stageRef.current.getBoundingClientRect()
    const position = at ?? pastePositionRef.current ?? instance.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
    const ids = director.pasteNodes(position)
    if (ids.length > 0) {
      onSelectedNodeIdsChange(new Set(ids))
      pastePositionRef.current = { x: position.x + 32, y: position.y + 32 }
    }
    setCanvasContextMenu(null)
    stageRef.current.focus({ preventScroll: true })
  }

  const updateNodes = useCallback((changes: NodeChange<DirectorNode>[]) => {
    if (project === null) return
    const dimensions = changes.filter(change => change.type === 'dimensions')
    if (dimensions.length > 0) {
      setMeasuredNodeSizes(current => {
        let next = current
        for (const change of dimensions) {
          if (change.type !== 'dimensions') continue
          const size = change.dimensions
          if (size === undefined) continue
          const previous = current[change.id]
          if (previous?.width === size.width && previous.height === size.height) continue
          if (next === current) next = { ...current }
          next[change.id] = { width: size.width, height: size.height }
        }
        return next
      })
    }
    const selection = changes.filter(change => change.type === 'select')
    if (selection.length > 0) {
      onSelectedNodeIdsChange((() => {
        const next = new Set(selectedNodeIds)
        for (const change of selection) {
          if (change.type !== 'select') continue
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
        }
        return next
      })())
    }
    const removedIds = changes.filter(change => change.type === 'remove').map(change => change.id)
    if (removedIds.length > 0) {
      try { director.deleteNodes(removedIds) } catch (error) { swallow(error) }
      onSelectedNodeIdsChange(new Set([...selectedNodeIds].filter(id => !removedIds.includes(id))))
      setNodeContextMenu(current => current !== null && removedIds.includes(current.nodeId) ? null : current)
      setParameterInputPicker(current => current !== null && removedIds.includes(current.nodeId) ? null : current)
      setDetailsNodeId(current => current !== null && removedIds.includes(current) ? null : current)
      return
    }
    const persisted = changes.filter(change => change.type !== 'select' && change.type !== 'dimensions' && change.type !== 'remove')
    if (persisted.length === 0) return
    director.updateGraph(
      applyNodeChanges(persisted, project.graph.nodes),
      project.graph.edges,
      project.graph.viewport,
    )
  }, [director, onSelectedNodeIdsChange, project, selectedNodeIds])

  const updateEdges = useCallback((changes: EdgeChange<DirectorEdge>[]) => {
    if (project === null) return
    const persisted = changes.filter(change => change.type !== 'select')
    if (persisted.length === 0) return
    const removedIds = persisted.filter(change => change.type === 'remove').map(change => change.id)
    if (selectedEdgeId !== null && removedIds.includes(selectedEdgeId)) setSelectedEdgeId(null)
    director.updateGraph(
      project.graph.nodes,
      applyEdgeChanges(persisted, project.graph.edges),
      project.graph.viewport,
    )
  }, [director, project, selectedEdgeId])

  const connect = useCallback((connection: Connection) => {
    if (project === null) return
    try {
      const ports = resolveConnectionPorts(project.graph, snapshot.nodeDefinitions, connection as DirectorEdge)
      const edge: DirectorEdge = {
        ...connection,
        sourceHandle: ports.sourceHandle,
        targetHandle: ports.targetHandle,
        id: crypto.randomUUID(),
        data: {
          role: 'visual',
          includeAudio: false,
          sourcePortId: ports.sourcePortId,
          targetPortId: ports.targetPortId,
        },
      }
      director.connect(edge)
    } catch (error) {
      swallow(error)
    }
  }, [director, project, snapshot.nodeDefinitions])

  const validConnection = useCallback((connection: Connection | DirectorEdge): boolean => {
    if (project === null) return false
    try {
      resolveConnectionPorts(project.graph, snapshot.nodeDefinitions, connection as DirectorEdge)
      return true
    } catch {
      return false
    }
  }, [project, snapshot.nodeDefinitions])

  const addFile = useCallback(async (file: File, at?: { x: number; y: number }) => {
    setUploading(true)
    try { await director.addFile(file, undefined, at) } catch (error) { swallow(error) } finally { setUploading(false) }
  }, [director])

  const openNodeMenu = useCallback((
    clientX: number,
    clientY: number,
    connection?: PendingNodeConnection,
  ): void => {
    if (instance === null || stageRef.current === null) return
    setCanvasContextMenu(null)
    setNodeContextMenu(null)
    setParameterInputPicker(null)
    const bounds = stageRef.current.getBoundingClientRect()
    const menuWidth = Math.min(340, Math.max(260, bounds.width - 24))
    const menuHeight = Math.min(500, Math.max(260, bounds.height - 24))
    setNodeMenu({
      screen: {
        x: Math.max(12, Math.min(clientX - bounds.left, bounds.width - menuWidth - 12)),
        y: Math.max(12, Math.min(clientY - bounds.top, bounds.height - menuHeight - 12)),
      },
      flow: instance.screenToFlowPosition({ x: clientX, y: clientY }),
      connection,
    })
  }, [instance])

  const openNodeContextMenu = useCallback((event: ReactMouseEvent, node: DirectorNode): void => {
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); return }
    const target = event.target
    if (!(target instanceof Element)) return
    if (isCanvasTextInput(target)) return
    event.preventDefault()
    event.stopPropagation()
    if (nodeMenu?.connection !== undefined || stageRef.current === null) {
      setNodeMenu(null)
      return
    }
    const bounds = stageRef.current.getBoundingClientRect()
    const menuWidth = Math.min(250, Math.max(210, bounds.width - 24))
    const menuHeight = Math.min(540, Math.max(240, bounds.height - 24))
    if (!selectedNodeIds.has(node.id)) onSelectedNodeIdsChange(new Set([node.id]))
    setSelectedEdgeId(null)
    setCanvasContextMenu(null)
    setNodeMenu(null)
    setParameterInputPicker(null)
    setNodeContextMenu({
      nodeId: node.id,
      screen: {
        x: Math.max(12, Math.min(event.clientX - bounds.left, bounds.width - menuWidth - 12)),
        y: Math.max(12, Math.min(event.clientY - bounds.top, bounds.height - menuHeight - 12)),
      },
    })
  }, [nodeMenu?.connection, onSelectedNodeIdsChange, selectedNodeIds])

  const focusNodeTitle = useCallback((nodeId: string): void => {
    setNodeContextMenu(null)
    window.setTimeout(() => {
      const flowNode = [...(stageRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
        .find(element => element.dataset.id === nodeId)
      const input = flowNode?.querySelector<HTMLInputElement>('input[aria-label="Node title"]')
      input?.focus()
      input?.select()
    }, 0)
  }, [])

  const closeParameterInputPicker = useCallback((restoreFocus = true): void => {
    const nodeId = parameterInputPicker?.nodeId
    setParameterInputPicker(null)
    if (nodeId === undefined || !restoreFocus) return
    window.setTimeout(() => {
      const flowNode = [...(stageRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
        .find(element => element.dataset.id === nodeId)
      flowNode?.focus()
    }, 0)
  }, [parameterInputPicker?.nodeId])

  const openParameterInputPicker = useCallback((position: NodeContextMenuPosition): void => {
    if (stageRef.current === null) return
    const bounds = stageRef.current.getBoundingClientRect()
    const pickerWidth = Math.min(380, Math.max(280, bounds.width - 24))
    const pickerHeight = Math.min(520, Math.max(300, bounds.height - 24))
    setNodeContextMenu(null)
    setParameterInputPicker({
      nodeId: position.nodeId,
      screen: {
        x: Math.max(12, Math.min(position.screen.x, bounds.width - pickerWidth - 12)),
        y: Math.max(12, Math.min(position.screen.y, bounds.height - pickerHeight - 12)),
      },
    })
  }, [])

  const chooseNode = useCallback((action: NodeMenuAction, targetPort?: VdPortDescriptor): void => {
    if (nodeMenu === null) return
    const position = nodeMenu.flow
    const connection = nodeMenu.connection
    setNodeMenu(null)
    try {
      if (action.kind === 'text') director.addTextNode(position)
      if (action.kind === 'workflow') {
        director.addWorkflowNode(action.workflowKind, position, connection === undefined || targetPort === undefined
          ? undefined
          : {
            source: connection.source,
            sourceHandle: connection.sourceHandle,
            targetHandle: `in:${targetPort.id}`,
          })
      }
      if (action.kind === 'definition') {
        const definition = snapshot.nodeDefinitions.find(candidate => (
          candidate.type === action.type && candidate.version === (action.version ?? '1.0.0')
        ))
        const targetHandle = definition === undefined || targetPort === undefined
          ? undefined
          : portHandleId('input', targetPort, definition.inputs.length)
        director.addNodeDefinition(action.type, action.version, position, connection === undefined || targetHandle === undefined
          ? undefined
          : {
            source: connection.source,
            sourceHandle: connection.sourceHandle,
            targetHandle,
          })
      }
      if (action.kind === 'sketch') {
        setSketchNodeId(null)
        setSketchPosition(position)
        setSketchOpen(true)
      }
      if (action.kind === 'file') {
        const input = fileInputRef.current
        if (input === null) return
        const accepts = {
          image: 'image/png,image/jpeg,image/webp,image/gif',
          audio: 'audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/mp4,audio/webm',
          video: 'video/mp4,video/webm,video/quicktime',
        }
        pendingFileRef.current = { mediaKind: action.mediaKind, position }
        input.accept = accepts[action.mediaKind]
        input.click()
      }
    } catch (error) { swallow(error) }
  }, [director, nodeMenu, snapshot.nodeDefinitions])

  const connectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    const fromHandle = connectionState.fromHandle
    const releaseTarget = event.target
    if (
      project === null
      || connectionState.isValid === true
      || connectionState.toNode !== null
      || fromHandle?.type !== 'source'
      || !(releaseTarget instanceof Element)
      || !releaseTarget.classList.contains('react-flow__pane')
    ) return
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
    if (pointer === undefined) return
    try {
      const output = resolveNodePort(
        project.graph,
        snapshot.nodeDefinitions,
        fromHandle.nodeId,
        'output',
        fromHandle.id,
      )
      ignoreNextPaneClickRef.current = true
      window.setTimeout(() => { ignoreNextPaneClickRef.current = false }, 0)
      openNodeMenu(pointer.clientX, pointer.clientY, {
        source: fromHandle.nodeId,
        sourceHandle: output.handle,
        sourceTypes: [...output.port.types],
      })
    } catch (error) {
      swallow(error)
    }
  }, [openNodeMenu, project, snapshot.nodeDefinitions])

  const referencePreviews = useMemo(() => (
    project === null
      ? {}
      : referencePreviewsByTarget(project.graph, snapshot.nodeDefinitions)
  ), [project, snapshot.nodeDefinitions])

  const runtime = useMemo<DirectorRuntimeValue>(() => ({
    providers: snapshot.providers,
    workflows: snapshot.workflows,
    nodeDefinitions: snapshot.nodeDefinitions,
    references: referencePreviews,
    onChange: (id, patch) => director.updateNode(id, patch),
    onRefreshModels: providerId => director.refreshProviderModels(providerId),
    onEjectModel: (providerId, model) => director.unloadProviderModel(providerId, model),
    onRunNode: nodeId => director.runNode(nodeId),
    onEditSketch: nodeId => {
      const node = project?.graph.nodes.find(candidate => candidate.id === nodeId)
      if (node?.data.kind !== 'load-sketch' || node.data.asset === undefined) return
      setSketchNodeId(nodeId)
      setSketchPosition(undefined)
      setSketchOpen(true)
    },
  }), [director, project, referencePreviews, snapshot.nodeDefinitions, snapshot.providers, snapshot.workflows])

  if (project === null) return null
  const selectedEdge = project.graph.edges.find(edge => edge.id === selectedEdgeId)
  const sketchNode = sketchNodeId === null ? undefined : project.graph.nodes.find(node => (
    node.id === sketchNodeId && node.data.kind === 'load-sketch'
  ))
  const maskNode = maskNodeId === null ? undefined : project.graph.nodes.find(node => node.id === maskNodeId)
  const contextNode = nodeContextMenu === null ? undefined : project.graph.nodes.find(node => node.id === nodeContextMenu.nodeId)
  const parameterInputNode = parameterInputPicker === null ? undefined : project.graph.nodes.find(node => node.id === parameterInputPicker.nodeId)
  const detailsNode = detailsNodeId === null ? undefined : project.graph.nodes.find(node => node.id === detailsNodeId)
  const contextProvider = contextNode === undefined ? undefined : snapshot.providers.find(provider => provider.id === contextNode.data.providerId)
  const contextDefinition = contextNode === undefined ? undefined : nodeDefinition(contextNode.data, snapshot.nodeDefinitions)
  const parameterInputDefinition = parameterInputNode === undefined ? undefined : nodeDefinition(parameterInputNode.data, snapshot.nodeDefinitions)
  const contextWorkflowId = contextDefinition?.workflowId ?? contextNode?.data.workflowId
  const contextVideoAsset = contextNode?.data.kind === 'preview'
    ? (contextNode.data.assets ?? (contextNode.data.asset === undefined ? [] : [contextNode.data.asset]))
      .find(asset => asset.kind === 'video')
    : undefined
  const contextWorkflowReady = contextProvider?.kind !== 'comfyui'
    && contextProvider?.kind !== 'comfyui-mcp'
    ? true
    : contextNode?.data.workflow !== undefined
      || (contextWorkflowId !== undefined && snapshot.workflows.some(workflow => workflow.id === contextWorkflowId))
  const contextCanRun = contextNode !== undefined
    && contextNode.data.frozen !== true
    && contextNode.data.status !== 'queued'
    && contextNode.data.status !== 'running'
    && !snapshot.saving
    && (contextNode.data.kind === 'preview'
      ? project.graph.edges.some(edge => edge.target === contextNode.id)
      : (contextNode.data.kind === 'vram-trigger' || contextNode.data.kind === 'ollama-eject' || contextNode.data.kind === 'comfyui-clear')
        ? true
      : REMOTE_NODE_KINDS.has(contextNode.data.kind)
        && contextNode.data.providerId !== undefined
        && contextProvider !== undefined
        && contextProvider.configured !== false
        && !(contextNode.data.modelFamily === 'minimax-h3' && contextProvider.minimaxH3Unlocked !== true)
        && contextWorkflowReady)
  return (
    <section
      ref={stageRef}
      className={`vd-canvas-stage${handMode ? ' is-hand-mode' : ''}${selectionModifierPressed ? ' is-group-selecting' : ''}`}
      tabIndex={0}
      aria-label="Workflow canvas"
      onPointerDownCapture={event => {
        if (!(event.target instanceof Element) || event.target.closest('.react-flow') === null) return
        if ((event.ctrlKey || event.metaKey) && event.button === 0 && !event.target.closest('.react-flow__panel') && stageRef.current) {
          event.preventDefault()
          event.stopPropagation()
          stageRef.current.focus({ preventScroll: true })
          stageRef.current.setPointerCapture(event.pointerId)
          selectionGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            moved: false, nodeId: event.target.closest<HTMLElement>('.react-flow__node')?.dataset.id,
            previous: new Set(selectedNodeIds) }
          setNodeMenu(null)
          setNodeContextMenu(null)
          setCanvasContextMenu(null)
          return
        }
        if (!isCanvasTextInput(event.target) && !event.target.closest('button, [role="menu"], .react-flow__minimap')) {
          stageRef.current?.focus({ preventScroll: true })
        }
      }}
      onPointerMoveCapture={event => {
        const gesture = selectionGestureRef.current
        if (!gesture || gesture.pointerId !== event.pointerId || !stageRef.current) return
        event.preventDefault()
        event.stopPropagation()
        if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 3) return
        gesture.moved = true
        const left = Math.min(gesture.x, event.clientX), top = Math.min(gesture.y, event.clientY)
        const right = Math.max(gesture.x, event.clientX), bottom = Math.max(gesture.y, event.clientY)
        const bounds = stageRef.current.getBoundingClientRect()
        setSelectionBox({ x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top })
        const selected = new Set(gesture.previous)
        for (const node of stageRef.current.querySelectorAll<HTMLElement>('.react-flow__node')) {
          const box = node.getBoundingClientRect()
          if (node.dataset.id && box.left < right && box.right > left && box.top < bottom && box.bottom > top) selected.add(node.dataset.id)
        }
        onSelectedNodeIdsChange(selected)
      }}
      onPointerUpCapture={event => {
        const gesture = selectionGestureRef.current
        if (!gesture || gesture.pointerId !== event.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        if (!gesture.moved && gesture.nodeId) {
          const selected = new Set(gesture.previous)
          if (selected.has(gesture.nodeId)) selected.delete(gesture.nodeId)
          else selected.add(gesture.nodeId)
          onSelectedNodeIdsChange(selected)
        }
        stageRef.current?.releasePointerCapture(event.pointerId)
        selectionGestureRef.current = null
        setSelectionBox(null)
      }}
      onPointerCancel={event => {
        const gesture = selectionGestureRef.current
        if (gesture && gesture.pointerId === event.pointerId) {
          onSelectedNodeIdsChange(gesture.previous)
          selectionGestureRef.current = null
          setSelectionBox(null)
        }
      }}
      onPointerMove={event => {
        if (event.target instanceof Element && event.target.closest('.react-flow') && !event.target.closest('.react-flow__panel')) {
          pastePositionRef.current = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? null
        }
      }}
      onMouseDownCapture={event => {
        if (handMode && event.button === 0 && event.target instanceof Element && event.target.closest('.react-flow__node')) {
          // Keep Hand navigation from focusing editors while still letting the
          // pan handler receive this mouse event.
          event.preventDefault()
          stageRef.current?.focus({ preventScroll: true })
        }
      }}
      onClickCapture={event => {
        if (handMode && event.target instanceof Element && event.target.closest('.react-flow__node')) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onWheelCapture={event => {
        if (scrollableCanvasField(event.target)) event.stopPropagation()
      }}
      onKeyDown={event => {
        if (event.isDefaultPrevented() || event.nativeEvent.isComposing || isCanvasTextInput(event.target)
          || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
        const key = event.key.toLowerCase()
        if (!event.ctrlKey && !event.metaKey && !event.altKey && (key === 'v' || key === 'h')) {
          event.preventDefault()
          onInteractionModeChange(key === 'v' ? 'select' : 'hand')
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return
        try {
          if (key === 'b' && selectedNodeIds.size > 0) {
            event.preventDefault()
            director.toggleNodesFrozen([...selectedNodeIds])
          } else if (key === 'c' && selectedNodeIds.size > 0) {
            event.preventDefault()
            director.copyNodes([...selectedNodeIds])
            setCanvasNotice(`Copied ${selectedNodeIds.size} node${selectedNodeIds.size === 1 ? '' : 's'}`)
          } else if (key === 'v' && director.canPasteNodes()) {
            event.preventDefault()
            pasteNodes()
          }
        } catch (error) { setCanvasNotice(error instanceof Error ? error.message : String(error)) }
      }}
      onDoubleClick={event => {
        const target = event.target
        if (handMode || selectionModifierPressed || event.button !== 0 || !(target instanceof Element)) return
        if (target.closest('.react-flow__pane') === null) return
        openNodeMenu(event.clientX, event.clientY)
      }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => {
        const file = event.dataTransfer.files[0]
        if (file === undefined) return
        event.preventDefault()
        const position = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
        void addFile(file, position)
      }}
      onContextMenuCapture={event => {
        // macOS Ctrl-click opens a native menu, sometimes targeting this section
        // because it captured the selection pointer. Stop it before child menus.
        if (event.ctrlKey || event.metaKey || selectionGestureRef.current !== null) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onContextMenu={event => {
        if (nodeMenu?.connection !== undefined) {
          event.preventDefault()
          setNodeMenu(null)
          return
        }
        if (event.target instanceof Element && event.target.closest('.react-flow__pane') !== null) {
          if (event.target.closest('.react-flow__node, .react-flow__edge, .react-flow__panel')) return
          event.preventDefault()
          if (!stageRef.current || !instance) return
          const bounds = stageRef.current.getBoundingClientRect()
          setCanvasContextMenu({
            screen: { x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 248)),
              y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 148)) },
            flow: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          })
          setNodeMenu(null)
          setNodeContextMenu(null)
          setParameterInputPicker(null)
        }
      }}
    >
      <DirectorRuntimeProvider value={runtime}>
        <ReactFlow<DirectorNode, DirectorEdge>
          key={`${project.id}:${snapshot.canvasResetVersion}`}
          nodes={project.graph.nodes.map(node => ({
            ...node,
            measured: measuredNodeSizes[node.id] ?? node.measured,
            selected: selectedNodeIds.has(node.id),
            draggable: !handMode && !selectionModifierPressed,
            selectable: !handMode,
            connectable: !handMode && !selectionModifierPressed,
            focusable: !handMode,
            style: { ...node.style, pointerEvents: 'all' },
          }))}
          edges={project.graph.edges.map(edge => ({ ...edge, selected: edge.id === selectedEdgeId }))}
          nodeTypes={nodeTypes}
          onInit={setInstance}
          onNodesChange={updateNodes}
          onEdgesChange={updateEdges}
          onConnect={connect}
          onConnectEnd={connectEnd}
          isValidConnection={validConnection}
          onNodeContextMenu={openNodeContextMenu}
          onNodeDragStart={() => {
            setNodeContextMenu(null)
            setParameterInputPicker(null)
            director.beginHistoryTransaction()
          }}
          onNodeDragStop={() => director.endHistoryTransaction()}
          onSelectionDragStart={() => director.beginHistoryTransaction()}
          onSelectionDragStop={() => director.endHistoryTransaction()}
          onEdgeClick={(_event, edge) => { if (!handMode) setSelectedEdgeId(edge.id) }}
          onNodeDoubleClick={event => event.stopPropagation()}
          onPaneClick={event => {
            setCanvasContextMenu(null)
            setSelectedEdgeId(null)
            setNodeContextMenu(null)
            setParameterInputPicker(null)
            if (ignoreNextPaneClickRef.current) return
            setNodeMenu(null)
          }}
          onMoveStart={() => {
            setCanvasContextMenu(null)
            setNodeContextMenu(null)
            setParameterInputPicker(null)
          }}
          onMoveEnd={(_event, viewport) => director.updateViewport(viewport)}
          minZoom={0.08}
          maxZoom={3.2}
          defaultViewport={project.graph.viewport}
          fitView={project.graph.nodes.length > 0 && project.graph.viewport.zoom === 1 && project.graph.viewport.x === 0}
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          deleteKeyCode={['Backspace', 'Delete']}
          selectionOnDrag={false}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          elementsSelectable={!handMode}
          nodesDraggable={!handMode && !selectionModifierPressed}
          nodesConnectable={!handMode && !selectionModifierPressed}
          nodesFocusable={!handMode}
          panOnDrag={[0, 1]}
          noPanClassName={handMode ? 'vd-hand-nopan' : 'nopan'}
          noWheelClassName="vd-native-scroll"
          panActivationKeyCode="Space"
          zoomOnScroll
          panOnScroll={false}
          zoomOnDoubleClick={false}
          colorMode="dark"
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(148,163,184,.18)" />
          {controlsLayer !== null ? createPortal(<>
            <Controls
              showZoom={false}
              showFitView={false}
              showInteractive={false}
              position="bottom-right"
              orientation="horizontal"
              aria-label="画布控制"
            >
              <CanvasModeControl mode={interactionMode} onChange={onInteractionModeChange} />
              <span className="vd-control-half-gap" aria-hidden="true" />
              <ControlButton
                aria-label="Zoom In"
                title="放大"
                disabled={instance === null}
                onClick={() => { void instance?.zoomIn({ duration: 180 }) }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </ControlButton>
              <ControlButton
                aria-label="Zoom Out"
                title="缩小"
                disabled={instance === null}
                onClick={() => { void instance?.zoomOut({ duration: 180 }) }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </ControlButton>
              <ControlButton
                aria-label="Fit View"
                title="适配视图"
                disabled={instance === null}
                onClick={() => { void instance?.fitView({ padding: 0.25, maxZoom: 1, duration: 220 }) }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9 4H5a1 1 0 0 0-1 1v4m11-5h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4m11 5h4a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </ControlButton>
              <ControlButton
                className={`vd-interaction-control ${miniMapVisible ? 'is-active' : ''}`}
                aria-label={miniMapVisible ? '隐藏 Mini Map' : '显示 Mini Map'}
                aria-pressed={miniMapVisible}
                title={miniMapVisible ? '隐藏 Mini Map' : '显示 Mini Map'}
                onClick={() => setMiniMapVisible(visible => !visible)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m3 6 5-2 8 3 5-2v13l-5 2-8-3-5 2V6Zm5-2v13m8-10v13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </ControlButton>
            </Controls>
            {miniMapVisible ? (
              <MiniMap
                position="bottom-right"
                style={{ width: 180, height: 110 }}
                pannable
                zoomable
                nodeColor={node => kindColor((node as DirectorNode).data.kind)}
                nodeStrokeWidth={6}
                nodeStrokeColor={node => {
                  const data = (node as DirectorNode).data
                  return data.status === 'failed' || (data.error !== undefined && data.error !== '') ? '#dc2626' : 'transparent'
                }}
              />
            ) : null}
          </>, controlsLayer) : null}
        </ReactFlow>
      </DirectorRuntimeProvider>
      <div ref={setControlsLayer} className="vd-canvas-controls-layer react-flow dark" />
      <div className="vd-canvas-label">
        <span>INFINITE CANVAS</span>
        <small>拖放媒体 · 连线构建工作流 · Delete 删除</small>
      </div>
      {uploading ? <div className="vd-uploading">正在写入不可变素材…</div> : null}
      {selectionBox ? <div className="vd-canvas-selection" style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.width, height: selectionBox.height }} /> : null}
      {canvasNotice ? <div className="vd-canvas-notice" role="status">{canvasNotice}</div> : null}
      {canvasContextMenu ? <CanvasContextMenu position={canvasContextMenu.screen}
        canPaste={director.canPasteNodes()} resettingVram={resettingVram}
        onMap={() => {
          if (instance) {
            const point = instance.flowToScreenPosition(canvasContextMenu.flow)
            openNodeMenu(point.x, point.y)
          }
        }}
        onResetVram={() => {
          setCanvasContextMenu(null)
          setResettingVram(true)
          setCanvasNotice('Resetting VRAM…')
          void director.resetVram().then(() => setCanvasNotice('VRAM reset'),
            error => setCanvasNotice(error instanceof Error ? error.message : String(error)))
            .finally(() => setResettingVram(false))
        }}
        onPaste={() => pasteNodes(canvasContextMenu.flow)}
        onClose={() => { setCanvasContextMenu(null); stageRef.current?.focus({ preventScroll: true }) }} /> : null}
      {selectedEdge !== undefined ? (
        <EdgeInspector
          edge={selectedEdge}
          onClose={() => setSelectedEdgeId(null)}
          onDelete={() => {
            director.updateGraph(
              project.graph.nodes,
              project.graph.edges.filter(edge => edge.id !== selectedEdge.id),
              project.graph.viewport,
            )
            setSelectedEdgeId(null)
          }}
          onChange={patch => {
            const edges = project.graph.edges.map(edge => edge.id === selectedEdge.id
              ? { ...edge, data: { ...edge.data, ...patch } }
              : edge)
            director.updateGraph(project.graph.nodes, edges, project.graph.viewport)
          }}
        />
      ) : null}
      {nodeMenu !== null ? (
        <NodeAddMenu
          position={nodeMenu}
          definitions={snapshot.nodeDefinitions}
          onChoose={chooseNode}
          onClose={() => setNodeMenu(null)}
        />
      ) : null}
      {nodeContextMenu !== null && contextNode !== undefined ? (
        <NodeContextMenu
          position={nodeContextMenu}
          node={contextNode}
          canRun={contextCanRun}
          inputCandidateCount={parameterInputCandidates(contextNode.data, contextDefinition).length}
          onRun={() => {
            setNodeContextMenu(null)
            if (contextNode.data.kind === 'preview') void director.runDependencies(contextNode.id).catch(swallow)
            else void director.runNode(contextNode.id).catch(swallow)
          }}
          onCancel={() => {
            setNodeContextMenu(null)
            if (contextNode.data.jobId !== undefined) void director.cancelJob(contextNode.data.jobId).catch(swallow)
          }}
          onFreeze={() => {
            setNodeContextMenu(null)
            try { director.setNodeFrozen(contextNode.id, contextNode.data.frozen !== true) } catch (error) { swallow(error) }
          }}
          onCopy={() => {
            director.copyNodes(selectedNodeIds.has(contextNode.id) ? [...selectedNodeIds] : [contextNode.id])
            setNodeContextMenu(null)
            setCanvasNotice('Copied to canvas clipboard')
            stageRef.current?.focus({ preventScroll: true })
          }}
          onDuplicate={() => {
            setNodeContextMenu(null)
            director.duplicateNode(contextNode.id)
          }}
          onParameterInputs={() => openParameterInputPicker(nodeContextMenu)}
          onMask={() => {
            setNodeContextMenu(null)
            setMaskNodeId(contextNode.id)
          }}
          onRename={() => focusNodeTitle(contextNode.id)}
          onDetails={() => {
            setNodeContextMenu(null)
            setDetailsNodeId(contextNode.id)
          }}
          videoPreview={contextVideoAsset !== undefined}
          onSaveVideo={() => {
            setNodeContextMenu(null)
            if (contextVideoAsset !== undefined) downloadAsset(contextVideoAsset)
          }}
          onVideoProperties={() => {
            setNodeContextMenu(null)
            if (contextVideoAsset !== undefined) {
              setOpenArtifact({ artifact: previewArtifactFromAsset(contextVideoAsset), properties: true })
            }
          }}
          onDelete={() => {
            setNodeContextMenu(null)
            try { director.deleteNodes([contextNode.id]) } catch (error) { swallow(error) }
          }}
          onClose={() => setNodeContextMenu(null)}
        />
      ) : null}
      {parameterInputPicker !== null && parameterInputNode !== undefined ? (
        <ParameterInputPicker
          position={parameterInputPicker}
          node={parameterInputNode}
          definition={parameterInputDefinition}
          edges={project.graph.edges}
          onToggle={(fieldId, enabled) => {
            try { director.configureFieldInput(parameterInputNode.id, fieldId, enabled) } catch (error) { swallow(error) }
          }}
          onClose={closeParameterInputPicker}
        />
      ) : null}
      {detailsNode !== undefined ? <NodeDetails node={detailsNode} snapshot={snapshot} onClose={() => setDetailsNodeId(null)} /> : null}
      {openArtifact === null ? null : (
        <ArtifactPreviewDialog
          artifact={openArtifact.artifact}
          initialPropertiesOpen={openArtifact.properties}
          onClose={() => setOpenArtifact(null)}
        />
      )}
      <input
        ref={fileInputRef}
        hidden
        type="file"
        onChange={event => {
          const file = event.target.files?.[0]
          const pending = pendingFileRef.current
          event.target.value = ''
          pendingFileRef.current = null
          if (file === undefined || pending === null) return
          setUploading(true)
          void director.addFile(file, pending.mediaKind, pending.position)
            .catch(swallow)
            .finally(() => setUploading(false))
        }}
      />
      <SketchModal
        open={sketchOpen}
        initialDocument={sketchNode?.data.sketchDocument}
        initialAsset={sketchNode?.data.sketchDocument === undefined ? sketchNode?.data.asset : undefined}
        title={sketchNode === undefined ? undefined : `Edit Sketch · ${sketchNode.data.title}`}
        submitLabel={sketchNode === undefined ? undefined : 'Save changes'}
        onCancel={() => {
          setSketchOpen(false)
          setSketchPosition(undefined)
          setSketchNodeId(null)
        }}
        onSubmit={async (file, sketchDocument) => {
          if (sketchNode === undefined) {
            await director.addFile(file, 'sketch', sketchPosition, sketchDocument)
          } else {
            const asset = await director.uploadDerived(file, 'sketch')
            director.updateNode(sketchNode.id, {
              asset,
              sketchDocument,
              mediaKind: 'sketch',
              status: 'idle',
              phase: undefined,
              progress: undefined,
              error: undefined,
              jobId: undefined,
            })
          }
          setSketchOpen(false)
          setSketchPosition(undefined)
          setSketchNodeId(null)
        }}
      />
      <MaskModal
        open={maskNode !== undefined}
        sourceUrl={maskNode?.data.asset?.url ?? ''}
        sourceKind={maskNode?.data.mediaKind === 'video' ? 'video' : 'image'}
        sourceName={maskNode?.data.asset?.name}
        title={maskNode === undefined ? undefined : `Mask · ${maskNode.data.title}`}
        onCancel={() => setMaskNodeId(null)}
        onSubmit={async file => {
          if (maskNode === undefined) return
          const maskAsset = await director.uploadDerived(file, 'mask')
          director.duplicateNode(maskNode.id, { maskAsset })
          setMaskNodeId(null)
        }}
      />
    </section>
  )
}

const CHAT_PANEL_LAYOUT_KEY = 'dsh-video-director.chat-panel-layout.v1'
const CHAT_PANEL_DEFAULT_WIDTH = 340
const CHAT_PANEL_MIN_WIDTH = 320
const CHAT_PANEL_MAX_WIDTH = 640
const CANVAS_MIN_WIDTH = 520
const CHAT_PANEL_RESIZER_WIDTH = 7

interface ChatPanelLayout {
  width: number
  open: boolean
}

function loadChatPanelLayout(): ChatPanelLayout {
  const fallback = { width: CHAT_PANEL_DEFAULT_WIDTH, open: true }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_PANEL_LAYOUT_KEY) ?? 'null') as Partial<ChatPanelLayout> | null
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      width: typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, parsed.width))
        : fallback.width,
      open: parsed.open !== false,
    }
  } catch {
    return fallback
  }
}

function storeChatPanelLayout(layout: ChatPanelLayout): void {
  try { window.localStorage.setItem(CHAT_PANEL_LAYOUT_KEY, JSON.stringify(layout)) } catch {}
}

export function DirectorOverlay({ director, chat }: DirectorInjectedProps) {
  const snapshot = useSource(director)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set())
  const [interactionMode, setInteractionMode] = useState<CanvasInteractionMode>('select')
  const initialChatPanelLayout = useMemo(loadChatPanelLayout, [])
  const [chatPanelWidth, setChatPanelWidth] = useState(initialChatPanelLayout.width)
  const [chatPanelOpen, setChatPanelOpen] = useState(initialChatPanelLayout.open)
  const [narrowChatPanelOpen, setNarrowChatPanelOpen] = useState(false)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const [resizingChatPanel, setResizingChatPanel] = useState(false)
  const workspaceRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!snapshot.open) {
      setSettingsOpen(false)
      setJobsOpen(false)
    }
  }, [snapshot.open])
  useEffect(() => {
    storeChatPanelLayout({ width: chatPanelWidth, open: chatPanelOpen })
  }, [chatPanelOpen, chatPanelWidth])
  useEffect(() => {
    const workspace = workspaceRef.current
    if (workspace === null) return
    const measure = (): void => setWorkspaceWidth(workspace.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [snapshot.open, snapshot.project?.id])
  const autoCollapseChatPanel = workspaceWidth < CHAT_PANEL_MIN_WIDTH + CANVAS_MIN_WIDTH + CHAT_PANEL_RESIZER_WIDTH
  const chatPanelCollapsed = !chatPanelOpen || (autoCollapseChatPanel && !narrowChatPanelOpen)
  useEffect(() => {
    if (!autoCollapseChatPanel) setNarrowChatPanelOpen(false)
  }, [autoCollapseChatPanel])
  const chatPanelMaxWidth = Math.min(
    CHAT_PANEL_MAX_WIDTH,
    Math.max(CHAT_PANEL_MIN_WIDTH, workspaceWidth - CANVAS_MIN_WIDTH - CHAT_PANEL_RESIZER_WIDTH),
  )
  const visibleChatPanelWidth = Math.min(chatPanelMaxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, chatPanelWidth))
  const setVisibleChatPanelWidth = (width: number): void => {
    setChatPanelWidth(Math.min(chatPanelMaxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, width)))
  }
  if (!snapshot.open) return null
  return (
    <>
      <style>{`${xyflowStyles}\n${styles}`}</style>
      <div className="vd-shell" role="dialog" aria-modal="true" aria-label="Video Director">
        <TopBar
          snapshot={snapshot}
          director={director}
          onSettings={() => setSettingsOpen(open => !open)}
          selectedNodeIds={selectedNodeIds}
          onJobs={() => setJobsOpen(open => !open)}
        />
        {jobsOpen ? <JobDrawer snapshot={snapshot} director={director} onClose={() => setJobsOpen(false)} /> : null}
        {snapshot.error !== null ? (
          <div className={`vd-global-error ${snapshot.conflict ? 'is-conflict' : ''}`}>
            <strong>{snapshot.conflict ? '工程发生保存冲突' : 'Video Director 错误'}</strong>
            <span>{snapshot.error}</span>
          </div>
        ) : null}
        {snapshot.phase === 'loading' && snapshot.project === null ? <div className="vd-loading">载入 Video Projects…</div> : null}
        {snapshot.phase !== 'loading' && snapshot.project === null ? (
          <EmptyProject onCreate={name => director.createProject(name)} />
        ) : snapshot.project !== null ? (
          <main
            ref={workspaceRef}
            className={`vd-workspace ${chatPanelCollapsed ? 'is-chat-collapsed' : ''} ${resizingChatPanel ? 'is-resizing-chat' : ''} ${snapshot.phase === 'loading' ? 'is-project-loading' : ''}`}
            style={{ '--vd-chat-panel-width': `${visibleChatPanelWidth}px` } as CSSProperties}
            aria-busy={snapshot.phase === 'loading'}
          >
            <ChatPanel
              chat={chat}
              director={director}
              providers={snapshot.providers}
              projectName={snapshot.project.name}
              collapsed={chatPanelCollapsed}
            />
            <div
              className="vd-chat-resizer"
              role="separator"
              aria-label="调整左侧聊天栏宽度"
              aria-orientation="vertical"
              aria-valuemin={CHAT_PANEL_MIN_WIDTH}
              aria-valuemax={chatPanelMaxWidth}
              aria-valuenow={visibleChatPanelWidth}
              tabIndex={chatPanelCollapsed ? -1 : 0}
              onPointerDown={event => {
                if (chatPanelCollapsed) return
                event.preventDefault()
                event.currentTarget.focus()
                event.currentTarget.setPointerCapture(event.pointerId)
                setResizingChatPanel(true)
              }}
              onPointerMove={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const bounds = workspaceRef.current?.getBoundingClientRect()
                if (bounds === undefined) return
                setVisibleChatPanelWidth(event.clientX - bounds.left)
              }}
              onPointerUp={event => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                setResizingChatPanel(false)
              }}
              onPointerCancel={() => setResizingChatPanel(false)}
              onDoubleClick={() => setVisibleChatPanelWidth(CHAT_PANEL_DEFAULT_WIDTH)}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') setVisibleChatPanelWidth(visibleChatPanelWidth - 20)
                else if (event.key === 'ArrowRight') setVisibleChatPanelWidth(visibleChatPanelWidth + 20)
                else if (event.key === 'Home') setVisibleChatPanelWidth(CHAT_PANEL_MIN_WIDTH)
                else if (event.key === 'End') setVisibleChatPanelWidth(chatPanelMaxWidth)
                else return
                event.preventDefault()
              }}
            />
            <CanvasStage
              snapshot={snapshot}
              director={director}
              interactionMode={interactionMode}
              onInteractionModeChange={setInteractionMode}
              selectedNodeIds={selectedNodeIds}
              onSelectedNodeIdsChange={setSelectedNodeIds}
            />
            <button
              type="button"
              className="vd-chat-collapse-toggle"
              aria-label={chatPanelCollapsed ? '展开左侧聊天栏' : '折叠左侧聊天栏'}
              title={chatPanelCollapsed ? '展开左侧聊天栏' : '折叠左侧聊天栏'}
              onClick={() => {
                if (chatPanelCollapsed) {
                  setChatPanelOpen(true)
                  setNarrowChatPanelOpen(autoCollapseChatPanel)
                } else {
                  setChatPanelOpen(false)
                  setNarrowChatPanelOpen(false)
                }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={chatPanelCollapsed ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} />
              </svg>
            </button>
            {snapshot.phase === 'loading' ? <div className="vd-project-loading">正在切换工程…</div> : null}
          </main>
        ) : null}
        {settingsOpen ? <SettingsDrawer snapshot={snapshot} director={director} onClose={() => setSettingsOpen(false)} /> : null}
      </div>
    </>
  )
}
