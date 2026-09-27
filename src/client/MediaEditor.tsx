import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AudioPreviewPlayer } from './AudioPreviewPlayer'
import { constrainCrop, VideoCropOverlay } from './MediaSelections'
import { MediaEditingContext, type MediaCrop, type MediaEditAction } from './media-editing'
import { audioTime } from './audio-waveform'
import { t, useLanguage } from './i18n'
import { useModalScrollLock } from './modal-scroll-lock'
import type { AssetRef } from './types'

export function MediaEditorIcon({ name }: { name: 'trim' | 'crop' | 'export' | 'save' | 'copy' | 'discard' | 'frame' | 'close' }) {
  const paths = {
    trim: 'M6 3v18M18 3v18M3 7h18M3 17h18M10 10v4m4-4v4',
    crop: 'M7 3v12a2 2 0 0 0 2 2h12M3 7h12a2 2 0 0 1 2 2v12M3 21 21 3',
    export: 'M12 15V3m-4 4 4-4 4 4M5 11H3v10h18V11h-2',
    save: 'm7 12 3.5 3.5L17 9M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    copy: 'M8 8V3h13v13h-5M3 8h13v13H3V8Zm3 6.5h7m-3.5-3.5v7',
    discard: 'm8 3-4 4 4 4M4 7h9a7 7 0 0 1 0 14H8',
    frame: 'M3 5h18v14H3V5Zm0 4h18M7 5v4m5-4v4m5-4v4M8 14h8m-4-3v6',
    close: 'm6 6 12 12M6 18 18 6',
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function MediaEditor({ asset, onClose, onSaved, initial }: {
  asset: AssetRef
  initial?: { duration?: number; width?: number; height?: number }
  onClose(): void
  onSaved(asset: AssetRef): void
}) {
  useLanguage()
  useModalScrollLock()
  const editMedia = useContext(MediaEditingContext)
  const [timing, setTiming] = useState({ duration: initial?.duration ?? 0, start: 0, end: initial?.duration ?? 0 })
  const { duration, ...range } = timing
  const [size, setSize] = useState({ width: initial?.width ?? 0, height: initial?.height ?? 0 })
  const [crop, setCrop] = useState<MediaCrop | null>(null)
  const [tool, setTool] = useState<'trim' | 'crop'>('trim')
  const [time, setTime] = useState(0)
  const [busy, setBusy] = useState<MediaEditAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const confirmation = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLMediaElement | null>(null)
  const operation = useRef<AbortController | null>(null)
  const id = useId()
  const video = asset.kind === 'video'
  const cropChanged = crop !== null && (crop.x !== 0 || crop.y !== 0 || crop.width !== size.width || crop.height !== size.height)
  const changed = range.start > .0001 || Math.abs(range.end - duration) > .0001 || cropChanged

  const readDuration = (value: number): void => {
    if (!(value > 0 && Number.isFinite(value))) return
    setTiming(current => ({
      duration: value,
      start: Math.min(current.start, Math.max(0, value - .01)),
      // An untouched end follows the clip's duration as browser/probe metadata arrives.
      end: current.end === 0 || Math.abs(current.end - current.duration) < .0001 ? value : Math.min(current.end, value),
    }))
  }
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`${asset.url}/properties`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Could not read media metadata.')
      if (controller.signal.aborted) return
      readDuration(result.value.duration)
      if (video) setSize({ width: result.value.width ?? 0, height: result.value.height ?? 0 })
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => { controller.abort(); operation.current?.abort(); media.current?.pause(); if (previousFocus?.isConnected) previousFocus.focus() }
  }, [asset.id])

  const close = (): void => { operation.current?.abort(); onClose() }
  const requestClose = (): void => {
    operation.current?.abort()
    media.current?.pause()
    if (changed) { setConfirmClose(true); return }
    close()
  }
  useEffect(() => {
    if (!confirmClose) return
    const previousFocus = document.activeElement as HTMLElement | null
    confirmation.current?.querySelector('button')?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
  }, [confirmClose])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      if (confirmClose) setConfirmClose(false)
      else requestClose()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [confirmClose, changed, onClose])

  const selectRange = (start: number, end: number): void => {
    media.current?.pause()
    setTiming(current => ({ ...current, start, end })); setConfirmClose(false); setNotice('')
    if (media.current && (media.current.currentTime < start || media.current.currentTime > end)) media.current.currentTime = start
  }
  const fullCrop = (): MediaCrop => constrainCrop({ x: 0, y: 0, ...size }, size.width, size.height)
  const applyAspect = (ratio: number): void => {
    let width = size.width, height = width / ratio
    if (height > size.height) { height = size.height; width = height * ratio }
    setCrop(constrainCrop({ x: (size.width - width) / 2, y: (size.height - height) / 2, width, height }, size.width, size.height))
  }
  const run = async (action: MediaEditAction): Promise<void> => {
    if (operation.current || !editMedia) return
    const controller = new AbortController()
    operation.current = controller; setBusy(action); setError(null); setNotice(''); media.current?.pause()
    try {
      const result = await editMedia(asset, { start: range.start, end: range.end, ...(cropChanged && crop ? { crop } : {}),
        ...(action === 'frame' ? { time: Math.min(time, Math.max(0, duration - .001)) } : {}) }, action, controller.signal)
      controller.signal.throwIfAborted()
      if ('asset' in result) onSaved(result.asset)
      else {
        const bytes = Uint8Array.from(atob(result.dataBase64), char => char.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = result.name; document.body.append(anchor); anchor.click(); anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        setNotice(action === 'frame' ? 'Frame exported.' : 'Exported. Your source is unchanged.')
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(null) }
    }
  }
  const action = (name: 'export' | 'save' | 'copy' | 'discard', label: string, disabled = false): ReactNode => <button type="button"
    className={name === 'save' ? 'is-primary' : ''} aria-label={t(label)} title={t(label)} disabled={!!busy || disabled}
    onClick={() => { if (name === 'discard') close(); else void run(name) }}><MediaEditorIcon name={name} /><span>{t(label)}</span></button>

  return createPortal(<div className="vd-artifact-dialog-backdrop vd-media-editor-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) requestClose() }}>
    <section ref={dialog} className="vd-media-editor nodrag nowheel" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const focusRoot = confirmClose ? confirmation.current : dialog.current
        const controls = [...(focusRoot?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
      }}>
      <header><div><strong id={`${id}-title`}>{t('Media Editor')}</strong><span title={asset.name}>{asset.name}</span></div>
        <button type="button" aria-label={t('Close media editor')} title={t('Close media editor')} onClick={requestClose}><MediaEditorIcon name="close" /></button></header>
      <div className="vd-media-editor-toolbar">
        <div className="vd-media-editor-tools" role="group" aria-label={t('Editing tools')}>
          <button type="button" aria-label={t('Trim')} aria-pressed={tool === 'trim'} disabled={!!busy} onClick={() => setTool('trim')}><MediaEditorIcon name="trim" /><span>{t('Trim')}</span></button>
          {video ? <button type="button" aria-label={t('Crop')} aria-pressed={tool === 'crop'} disabled={!!busy || !size.width} onClick={() => setTool('crop')}><MediaEditorIcon name="crop" /><span>{t('Crop')}</span></button> : null}
        </div>
        <div className="vd-media-editor-actions" role="group" aria-label={t('Media actions')}>
          {action('discard', 'Discard changes')}{action('export', 'Export', !duration || !editMedia)}
          {action('copy', 'Save as new copy', !duration || !editMedia)}{action('save', 'Save', !changed || !duration || !editMedia)}
        </div>
      </div>
      <div className="vd-media-editor-body" aria-busy={!!busy}>
        <div className={`vd-media-editor-playback${busy ? ' is-busy' : ''}`}>
          <AudioPreviewPlayer asset={asset} duration={duration} onDuration={readDuration} onTimeChange={setTime}
            onMediaReady={element => { media.current = element; if (element instanceof HTMLVideoElement) setSize({ width: element.videoWidth, height: element.videoHeight }) }}
            selection={duration ? { ...range, onChange: selectRange } : undefined} videoSize={size}
            videoOverlay={video && tool === 'crop' && size.width ? <VideoCropOverlay crop={crop ?? fullCrop()} {...size} onChange={setCrop} /> : null} />
        </div>
        <div className="vd-media-editor-inspector">
          {tool === 'trim' ? <>
            <div className="vd-media-selection-summary"><strong>{t('Keep selection')}</strong><span>{(range.end - range.start).toFixed(2)} s / {audioTime(duration, true)}</span></div>
            <div className="vd-media-editor-fields">
              <label>{t('Start (seconds)')}<input type="number" min={0} max={Math.max(0, range.end - .01)} step="0.01" value={Number(range.start.toFixed(3))} disabled={!!busy}
                onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) selectRange(Math.max(0, Math.min(range.end - .01, value)), range.end) }} /></label>
              <button type="button" disabled={!!busy || !duration} onClick={() => selectRange(Math.min(time, range.end - .01), range.end)}>{t('Set start here')}</button>
              <label>{t('End (seconds)')}<input type="number" min={range.start + .01} max={duration} step="0.01" value={Number(range.end.toFixed(3))} disabled={!!busy}
                onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) selectRange(range.start, Math.min(duration, Math.max(range.start + .01, value))) }} /></label>
              <button type="button" disabled={!!busy || !duration} onClick={() => selectRange(range.start, Math.max(time, range.start + .01))}>{t('Set end here')}</button>
              <button type="button" disabled={!!busy} onClick={() => selectRange(0, duration)}>{t('Reset trim')}</button>
            </div>
          </> : <>
            <div className="vd-media-selection-summary"><strong>{t('Crop video')}</strong><span>{crop?.width ?? size.width} × {crop?.height ?? size.height} px</span></div>
            <div className="vd-media-editor-fields is-crop">
              {(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{t(['Left (pixels)', 'Top (pixels)', 'Width (pixels)', 'Height (pixels)'][index])}
                <input type="number" min={key === 'x' || key === 'y' ? 0 : 2} step={key === 'x' || key === 'y' ? 1 : 2} value={(crop ?? fullCrop())[key]} disabled={!!busy}
                  onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setCrop(constrainCrop({ ...(crop ?? fullCrop()), [key]: value }, size.width, size.height)) }} /></label>)}
              {[1, 16 / 9, 9 / 16].map((ratio, index) => <button key={ratio} type="button" disabled={!!busy} onClick={() => applyAspect(ratio)}>{['1:1', '16:9', '9:16'][index]}</button>)}
              <button type="button" disabled={!!busy} onClick={() => setCrop(null)}>{t('Reset crop')}</button>
            </div>
          </>}
          {video ? <button className="vd-media-frame-export" type="button" disabled={!!busy || !duration || !editMedia} onClick={() => { void run('frame') }}><MediaEditorIcon name="frame" />{t('Export current frame')}</button> : null}
        </div>
        {error ? <p className="vd-media-editor-error" role="alert">{error}</p> : null}
      </div>
      <footer><span role="status">{busy ? t('Processing media…') : notice ? t(notice) : t('Save updates the source. Save as new copy keeps the original in Gallery.')}</span>
        {busy ? <button type="button" onClick={() => operation.current?.abort()}>{t('Cancel processing')}</button> : <span>{video ? 'MP4' : asset.mimeType.includes('wav') ? 'WAV' : 'FLAC'}</span>}
      </footer>
      {confirmClose ? <div className="vd-media-editor-confirm-backdrop">
        <div ref={confirmation} className="vd-media-editor-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-description`}>
          <strong id={`${id}-confirm-title`}>{t('Discard unsaved edits?')}</strong>
          <p id={`${id}-confirm-description`}>{t('Your unsaved edits will be discarded.')}</p>
          <div className="vd-media-editor-confirm-actions"><button type="button" onClick={() => setConfirmClose(false)}>{t('Keep editing')}</button><button type="button" className="is-destructive" onClick={close}>{t('Discard changes')}</button></div>
        </div>
      </div> : null}
    </section>
  </div>, document.body)
}
