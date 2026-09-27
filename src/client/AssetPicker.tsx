import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssetRef } from './types'
import { CloseIcon } from './icons'
import { t, useLanguage } from './i18n'

export type InputAssetKind = 'image' | 'audio' | 'video' | 'sketch'

function displayName(asset: AssetRef): string {
  return asset.origin === 'input' ? asset.filename?.split('/').at(-1) ?? asset.name : asset.name
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function AssetPicker(props: {
  kind: InputAssetKind
  nodeTitle: string
  currentAssetId?: string
  load(kind: InputAssetKind): Promise<AssetRef[]>
  onSelect(asset: AssetRef): Promise<void>
  onClose(): void
}) {
  useLanguage()
  const titleId = useId()
  const [assets, setAssets] = useState<AssetRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<'all' | 'input' | 'output'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(props.currentAssetId ?? null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const panel = useRef<HTMLElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const close = useRef(props.onClose)
  close.current = props.onClose

  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    search.current?.focus()
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!busyRef.current) close.current()
      } else if (event.key === 'Tab') {
        const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])
        const first = items[0]; const last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keyDown, true)
    return () => { alive.current = false; window.removeEventListener('keydown', keyDown, true); previous?.focus() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    void props.load(props.kind).then(rows => {
      if (!cancelled) setAssets(rows.filter(asset => asset.kind === props.kind))
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [props.kind, props.load, reload])

  const filtered = useMemo(() => assets.filter(asset => (origin === 'all' || asset.origin === origin)
    && `${asset.name} ${displayName(asset)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [assets, query, origin])
  const selected = filtered.find(asset => asset.id === selectedId)
  const select = async (asset: AssetRef) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await props.onSelect(asset); if (alive.current) close.current() }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }

  return createPortal(<div className="vd-artifact-dialog-backdrop vd-asset-picker-backdrop" onPointerDown={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget && !busy) props.onClose()
  }}>
    <section ref={panel} className="vd-asset-picker nodrag nowheel" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header><div><strong id={titleId}>{t('Choose from assets')}</strong><span>{props.nodeTitle} · {t(props.kind)} · {t('All workflows')}</span></div>
        <button type="button" className="vd-asset-picker-close" aria-label={t('Close asset chooser')} disabled={busy} onClick={props.onClose}><CloseIcon /></button>
      </header>
      <div className="vd-asset-picker-search">
        <input ref={search} type="search" aria-label={t('Search assets')} placeholder={t('Search by filename…')} value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label={t('Asset source')} value={origin} onChange={event => setOrigin(event.target.value as typeof origin)}>
          <option value="all">{t('Inputs and outputs')}</option><option value="input">{t('Inputs')}</option><option value="output">{t('Outputs')}</option>
        </select>
      </div>
      {error ? <div className="vd-asset-picker-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>{t('Retry')}</button></div> : null}
      <div className="vd-asset-picker-list" aria-busy={loading || busy}>
        {loading ? <p role="status">{t('Loading assets…')}</p> : filtered.length === 0 ? <p>{t('No matching assets. Upload a file or change your search.')}</p> : filtered.map(asset => (
          <button key={asset.id} type="button" className="vd-asset-picker-row" aria-pressed={selectedId === asset.id} disabled={busy}
            onClick={() => setSelectedId(asset.id)} onDoubleClick={() => void select(asset)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h5" /></svg>
            <span><strong>{displayName(asset)}</strong><small>{asset.mimeType} · {fileSize(asset.size)} · {new Date(asset.createdAt).toLocaleDateString()}</small></span>
            <span className="vd-asset-picker-source">{t(asset.origin === 'output' ? 'Output' : 'Input')}</span>
            <svg className="vd-asset-picker-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          </button>
        ))}
      </div>
      <footer><span>{t('{0} assets', filtered.length)}</span><div>
        <button type="button" disabled={busy} onClick={props.onClose}>{t('Cancel')}</button>
        <button type="button" className="is-primary" disabled={!selected || busy || loading} onClick={() => { if (selected) void select(selected) }}>{t(busy ? 'Adding…' : 'Use asset')}</button>
      </div></footer>
    </section>
  </div>, document.body)
}
