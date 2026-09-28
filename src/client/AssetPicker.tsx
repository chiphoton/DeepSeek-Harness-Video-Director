import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssetRef, InputAssetPage, InputAssetQuery } from './types'
import { ArtifactPreviewDialog, ArtifactThumbnail, previewArtifactFromAsset, type PreviewArtifact } from './ArtifactPreview'
import { CloseIcon } from './icons'
import { t, useLanguage } from './i18n'
import { useModalScrollLock } from './modal-scroll-lock'

export type InputAssetKind = 'image' | 'audio' | 'video' | 'sketch'
const PAGE_SIZE = 15

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
  load(kind: InputAssetKind, options: InputAssetQuery): Promise<InputAssetPage>
  onSelect(asset: AssetRef): Promise<void>
  onClose(): void
}) {
  useLanguage()
  useModalScrollLock()
  const titleId = useId()
  const [assets, setAssets] = useState<AssetRef[]>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<InputAssetQuery['origin']>('all')
  const [selectedId, setSelectedId] = useState<string | null>(props.currentAssetId ?? null)
  const [preview, setPreview] = useState<PreviewArtifact | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const panel = useRef<HTMLElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const loadingRef = useRef(false)
  const requestVersion = useRef(0)
  const close = useRef(props.onClose)
  const previewOpen = useRef(false)
  close.current = props.onClose
  previewOpen.current = preview !== null
  const searchQuery = query.trim()
  const filterKey = JSON.stringify([props.kind, searchQuery, origin])
  const currentFilter = useRef(filterKey)
  currentFilter.current = filterKey

  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    search.current?.focus()
    const keyDown = (event: KeyboardEvent) => {
      // The nested preview owns Escape, focus and any Media Editor above it.
      if (previewOpen.current) return
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

  const loadPage = useCallback(async (cursor?: string): Promise<void> => {
    const version = ++requestVersion.current
    loadingRef.current = true; setLoading(true); setError(null)
    try {
      const page = await props.load(props.kind, { query: searchQuery, origin, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      if (!alive.current || version !== requestVersion.current || filterKey !== currentFilter.current) return
      const rows = page.assets.filter(asset => asset.kind === props.kind)
      setAssets(previous => cursor ? [...new Map([...previous, ...rows].map(asset => [asset.filename ?? asset.id, asset])).values()] : rows)
      setTotal(page.total); setNextCursor(page.nextCursor)
    } catch (error) {
      if (alive.current && version === requestVersion.current && filterKey === currentFilter.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current && version === requestVersion.current) { loadingRef.current = false; setLoading(false) }
    }
  }, [props.kind, props.load, searchQuery, origin, filterKey])

  useEffect(() => {
    setAssets([]); setTotal(0); setNextCursor(null)
    if (list.current) list.current.scrollTop = 0
    void loadPage()
    return () => { requestVersion.current++; loadingRef.current = false }
  }, [loadPage, reload])

  const loadMore = (): void => { if (!loadingRef.current && !busyRef.current && nextCursor) void loadPage(nextCursor) }
  const selected = assets.find(asset => asset.id === selectedId)
  const select = async (asset: AssetRef) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await props.onSelect(asset); if (alive.current) close.current() }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }

  return <>{createPortal(<div className={`vd-artifact-dialog-backdrop vd-asset-picker-backdrop${preview ? ' is-previewing' : ''}`} aria-hidden={preview ? true : undefined} onPointerDown={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget && !busy) props.onClose()
  }}>
    <section ref={panel} className="vd-asset-picker nodrag nowheel" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header><div><strong id={titleId}>{t('Choose from assets')}</strong><span>{props.nodeTitle} · {t(props.kind)} · {t('All workflows')}</span></div>
        <button type="button" className="vd-asset-picker-close" aria-label={t('Close asset chooser')} disabled={busy} onClick={props.onClose}><CloseIcon /></button>
      </header>
      <div className="vd-asset-picker-search">
        <input ref={search} type="search" maxLength={512} aria-label={t('Search assets')} placeholder={t('Search by filename…')} value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label={t('Asset source')} value={origin} onChange={event => setOrigin(event.target.value as typeof origin)}>
          <option value="all">{t('Inputs and outputs')}</option><option value="input">{t('Inputs')}</option><option value="output">{t('Outputs')}</option>
        </select>
      </div>
      {error ? <div className="vd-asset-picker-error" role="alert">{error} <button type="button" disabled={busy || loading} onClick={() => nextCursor ? loadMore() : setReload(value => value + 1)}>{t('Retry')}</button></div> : null}
      <div ref={list} className="vd-asset-picker-list" aria-busy={loading || busy} onScroll={event => {
        const element = event.currentTarget
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) loadMore()
      }}>
        {!loading && !error && assets.length === 0 ? <p>{t('No matching assets. Upload a file or change your search.')}</p> : assets.map(asset => (
          <div key={asset.id} className={`vd-asset-picker-row${selectedId === asset.id ? ' is-selected' : ''}`}>
            <ArtifactThumbnail variant="picker" artifact={{ ...previewArtifactFromAsset(asset), name: displayName(asset) }} onOpen={artifact => { if (!busy) setPreview(artifact) }} />
            <button type="button" className="vd-asset-picker-select" aria-pressed={selectedId === asset.id} disabled={busy}
              onClick={() => setSelectedId(asset.id)} onDoubleClick={() => void select(asset)}>
              <span><strong>{displayName(asset)}</strong><small>{asset.mimeType} · {fileSize(asset.size)} · {new Date(asset.createdAt).toLocaleDateString()}</small></span>
              <span className="vd-asset-picker-source">{t(asset.origin === 'output' ? 'Output' : 'Input')}</span>
              <svg className="vd-asset-picker-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
            </button>
          </div>
        ))}
        {loading ? <p className="vd-asset-picker-loading" role="status">{t('Loading assets…')}</p> : nextCursor ? <button type="button" className="vd-asset-picker-more" disabled={busy} onClick={loadMore}>{t('Load 15 more')}</button> : null}
      </div>
      <footer><span>{t('{0} of {1} assets', assets.length, total)}</span><div>
        <button type="button" disabled={busy} onClick={props.onClose}>{t('Cancel')}</button>
        <button type="button" className="is-primary" disabled={!selected || busy || loading} onClick={() => { if (selected) void select(selected) }}>{t(busy ? 'Adding…' : 'Use asset')}</button>
      </div></footer>
    </section>
  </div>, document.body)}
    {preview ? <ArtifactPreviewDialog artifact={preview} onClose={() => setPreview(null)} onAssetEdited={() => setReload(value => value + 1)} /> : null}
  </>
}
