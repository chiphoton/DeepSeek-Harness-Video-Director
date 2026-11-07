import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { t } from './i18n'
import { useModalScrollLock } from './modal-scroll-lock'
import type { DirectorController } from './controller'

type Skill = { id: string; projectId?: string; name: string; description: string; revision: number; digest: string; content?: string; resources?: Record<string, string>; frontmatter?: Record<string, unknown>; loadedAt?: string; archived?: boolean; shared?: boolean; builtIn?: boolean }
type Change = { id: string; kind: string; draftRevision: number; createdAt: string; undoOf?: string; changes: Record<string, string[]> }
const blank = { name: '', description: '', content: '', resources: '{}', frontmatter: {} as Record<string, unknown> }

export function SkillsDialog({ director, projectId, onChange, onClose }: { director: DirectorController; projectId: string; onChange(): void; onClose(): void }) {
  useModalScrollLock()
  const panel = useRef<HTMLElement>(null)
  const title = useId()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key !== 'Tab') return
      const controls = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(item => item.getClientRects().length > 0)
      const first = controls[0]; const last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keyDown, true)
    return () => { window.removeEventListener('keydown', keyDown, true); previous?.focus() }
  }, [])
  return createPortal(<div className="vd-skills-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={panel} className="vd-skills-dialog" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <header><div><h2 id={title}>{t('Manage skills')}</h2><p>{t('Create reusable instructions and choose skills to use in chat.')}</p></div>
        <button type="button" className="vd-close-icon-button" aria-label={t('Close skills manager')} onClick={onClose}><CloseIcon /></button></header>
      <SkillsPanel director={director} projectId={projectId} onChange={onChange} />
    </section>
  </div>, document.body)
}

function SkillResources({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [path, setPath] = useState('references/example.md')
  const [error, setError] = useState('')
  let files: Record<string, string> = {}
  try { files = JSON.parse(value) as Record<string, string> } catch { /* Imported content is validated by the Host. */ }
  return <details><summary>Supporting files ({Object.keys(files).length})</summary>
    {Object.entries(files).map(([name, content]) => <div key={name}><label>{name}<textarea aria-label={`Resource ${name}`} rows={5} value={content} onChange={event => onChange(JSON.stringify({ ...files, [name]: event.target.value }))} /></label>
      <button type="button" onClick={() => { const next = { ...files }; delete next[name]; onChange(JSON.stringify(next)) }}>Remove file</button></div>)}
    <label>New file path<input value={path} onChange={event => setPath(event.target.value)} placeholder="references/example.md" /></label>
    <button type="button" onClick={() => { if (!/^(references|assets|scripts)\/.+/.test(path) || path.split('/').some(part => part === '..' || !part)) { setError('Use a relative path under references/, assets/, or scripts/.'); return } onChange(JSON.stringify({ ...files, [path]: files[path] ?? '' })); setError('') }}>Add supporting file</button>
    <p>Keep instructions short; place examples and templates here. Script files are never executed automatically.</p>{error && <p role="alert">{error}</p>}
  </details>
}

export function ContextInspector({ director, projectId }: { director: DirectorController; projectId: string }) {
  const [allowed, setAllowed] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let live = true; void director.agentAccess().then(value => { if (live) setAllowed(value.allowContent) }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [director, projectId])
  const context = director.currentContext()
  return <details className="vd-workspace-changes"><summary>{t('Workflow access')}</summary>
    <details><summary>{t('View context details')}</summary><pre>{context}</pre></details><label><input type="checkbox" checked={allowed} onChange={event => {
      const value = event.target.checked
      void director.agentAccess(value).then(result => { setAllowed(result.allowContent); setError('') }).catch(error => setError(String(error)))
    }} />Allow the chat agent to read this workflow’s text/media and run configured providers</label>
    <p>Selected content goes to the configured model. Other dsh filesystem or shell tools have their own access settings.</p>
    {error && <p role="alert">{error}</p>}
  </details>
}

export function WorkspaceHistory({ director, projectId, onHighlightNode }: { director: DirectorController; projectId: string; onHighlightNode(id: string | null): void }) {
  const [items, setItems] = useState<Change[]>([])
  const [inspected, setInspected] = useState<Change | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      try { const result = await director.workspace<{ items: Change[] }>('canvas', 'history', { limit: 5 }); if (!disposed) setItems(result.items) }
      catch { /* The main controller reports connection/conflict failures. */ }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [director, projectId])
  if (!items.length) return null
  return <details className="vd-workspace-changes"><summary>Canvas changes ({items.length})</summary>
    {items.map(item => <article key={item.id}>
      <strong>{item.kind === 'undo' ? 'Undo' : item.kind === 'browser' ? 'Canvas edit' : item.kind === 'layout' ? 'Layout' : 'Agent edit'} · revision {item.draftRevision}</strong>
      <span>+{item.changes.added.length} nodes · {item.changes.updated.length} updated · −{item.changes.removed.length} removed</span>
      <div className="vd-workspace-actions"><button disabled={busy} onClick={() => {
        setInspected(item); onHighlightNode(item.changes.added[0] ?? item.changes.updated[0] ?? null)
      }}>Inspect</button><button disabled={busy} onClick={() => { void (async () => {
        setBusy(true); setError('')
        try {
          const current = await director.workspace<{ draftRevision: number }>('canvas', 'summary')
          await director.workspace('canvas', 'undo', { operationId: item.id, expectedDraftRevision: current.draftRevision, idempotencyKey: crypto.randomUUID() })
          setItems((await director.workspace<{ items: Change[] }>('canvas', 'history', { limit: 5 })).items)
          setInspected(null)
        } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
      })() }}>Undo</button></div>
    </article>)}
    {inspected && <pre aria-label="Inspected canvas changes">{JSON.stringify(inspected.changes, null, 2)}</pre>}
    {error && <p role="alert">{error}</p>}
  </details>
}

export function SkillsPanel({ director, projectId, onChange }: { director: DirectorController; projectId: string; onChange?(): void }) {
  const [items, setItems] = useState<Skill[]>([])
  const [active, setActive] = useState<Skill[]>([])
  const [selected, setSelected] = useState<Skill | null>(null)
  const [draft, setDraft] = useState(blank)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [offset, setOffset] = useState<number | null>(null)
  const [version, setVersion] = useState(1)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const readOnly = selected !== null && selected.projectId !== projectId
  const refresh = async (append = false): Promise<void> => {
    const [list, bindings] = await Promise.all([
      director.workspace<{ items: Skill[]; nextOffset: number | null }>('library', 'list', { query, archived: showArchived, offset: append ? offset : 0 }),
      director.workspace<{ items: Skill[] }>('library', 'active'),
    ])
    setItems(previous => append ? [...previous, ...list.items] : list.items); setOffset(list.nextOffset); setActive(bindings.items)
  }
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await operation(); onChange?.() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  useEffect(() => { void run(() => refresh()) }, [projectId, showArchived])
  const edit = async (id: string): Promise<void> => {
    const skill = await director.workspace<Skill>('library', 'get', { id })
    setSelected(skill); setVersion(skill.revision)
    setDraft({ name: skill.name, description: skill.description, content: skill.content ?? '', resources: JSON.stringify(skill.resources ?? {}, null, 2), frontmatter: skill.frontmatter ?? {} })
  }
  return <section className="vd-workspace-library" aria-label="Skills library">
    <div className="vd-workspace-actions"><button disabled={busy} onClick={() => { setSelected(null); setDraft(blank); setMessage('') }}>New skill</button>
      <label className="vd-workspace-import">Import SKILL.md or bundle<input type="file" accept="application/json,.json,.md" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
        if (file) void run(async () => {
          if (file.size > 600 * 1024) throw new Error('Choose a skill bundle below 600 KiB.')
          const text = await file.text()
          const data = file.name.toLowerCase().endsWith('.md') ? { markdown: text } : JSON.parse(text) as Record<string, unknown>
          const created = await director.workspace<Skill>('library', 'create', data); await refresh(); await edit(created.id)
        })
      }} /></label></div>
    <form className="vd-workspace-actions" onSubmit={event => { event.preventDefault(); void run(() => refresh()) }}>
      <input aria-label="Find skills" placeholder="Find skills" value={query} onChange={event => setQuery(event.target.value)} /><button disabled={busy}>Search</button>
      <label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Include archived</label>
    </form>
    <ul>{items.map(item => <li key={item.id}><button disabled={busy} onClick={() => { void run(() => edit(item.id)) }}>{item.name} · v{item.revision}{item.archived ? ' · archived' : ''}{item.builtIn ? ' · built-in' : item.shared ? ' · shared' : ''}</button></li>)}</ul>
    {offset !== null && <button disabled={busy} onClick={() => { void run(() => refresh(true)) }}>More skills</button>}
    {active.length > 0 && <div className="vd-workspace-active"><strong>Selected for this chat</strong>{active.map(item => <div key={item.id}>
      {item.name} · v{item.revision} {item.loadedAt ? '· loaded' : '· loads when requested'} <button disabled={busy} onClick={() => { void run(async () => { await director.workspace('library', 'unload', { id: item.id }); await refresh() }) }}>Unload</button>
    </div>)}</div>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const value = { ...draft, resources: JSON.parse(draft.resources), ...(selected ? { id: selected.id, expectedRevision: selected.revision } : {}) }
      const saved = await director.workspace<Skill>('library', selected ? 'save' : 'create', value)
      await refresh(); await edit(saved.id); setMessage(`Saved ${saved.name} v${saved.revision}. Selected versions stay pinned.`)
    }) }}>
      <label>Name<input required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Description<input required maxLength={240} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      <label>Instructions<textarea required rows={10} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
      <SkillResources value={draft.resources} onChange={resources => setDraft({ ...draft, resources })} />
      <button disabled={busy || readOnly}>Save version</button>
      {readOnly && <p>{selected?.builtIn ? 'This is a built-in skill. Duplicate it to save your own version.' : 'This skill is shared by another workflow. Duplicate it to save your own version.'}</p>}
    </form>
    {selected && <div className="vd-workspace-actions"><label>Version<input aria-label="Skill version" type="number" min={1} max={selected.revision} value={version} onChange={event => setVersion(Number(event.target.value))} /></label>
      <button disabled={busy} onClick={() => { void run(async () => {
        await director.workspace('library', 'bind', { id: selected.id, revision: version }); await refresh(); setMessage('Selected for this chat. The agent loads this exact version on demand.')
      }) }}>Load in chat</button>
      <button disabled={busy} onClick={() => { setSelected(null); setDraft({ ...draft, name: `${draft.name}-copy` }) }}>Duplicate</button>
      <button disabled={busy} onClick={() => { void run(async () => {
        const value = await director.workspace<Skill>('library', 'get', { id: selected.id, revision: version })
        const portable = { name: value.name, description: value.description, content: value.content, resources: value.resources, frontmatter: value.frontmatter }
        const url = URL.createObjectURL(new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = `${value.name}-v${version}.json`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage(`Exported ${value.name} v${version} with its supporting files.`)
      }) }}>Export version</button>
      <button disabled={busy || readOnly} onClick={() => { void run(async () => {
        await director.workspace('library', 'publish', { id: selected.id, expectedRevision: selected.revision, enabled: !selected.shared })
        await refresh(); await edit(selected.id)
      }) }}>{selected.shared ? 'Make private' : 'Share across workflows'}</button>
      <button disabled={busy || readOnly} onClick={() => { void run(async () => { await director.workspace('library', 'archive', { id: selected.id, expectedRevision: selected.revision, enabled: !selected.archived }); setSelected(null); setDraft(blank); await refresh() }) }}>{selected.archived ? 'Restore' : 'Archive'}</button>
    </div>}
    <p className="vd-workspace-note">Instructions load into the configured chat model only when invoked. Unload cannot erase text already in conversation history.</p>
    {message && <p role="status">{message}</p>}
  </section>
}
