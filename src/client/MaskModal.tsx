import { t, useLanguage } from './i18n'
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

type MaskMode = 'paint' | 'erase'
type Point = { x: number; y: number }
type MaskStroke = { mode: MaskMode; width: number; points: Point[] }

export interface MaskModalProps {
  open: boolean
  sourceUrl: string
  /** Explicitly pass `video` for asset URLs that do not retain a file extension. */
  sourceKind?: 'image' | 'video'
  /** Frame shown underneath a video mask; defaults to the first decodable frame. */
  sourceTime?: number
  title?: string
  sourceName?: string
  onCancel(): void
  onSubmit(file: File): void | Promise<void>
}

function inferredSourceKind(url: string): 'image' | 'video' {
  return /\.(?:mp4|m4v|mov|webm|ogv)(?:$|[?#])/iu.test(url) ? 'video' : 'image'
}

const buttonStyle: CSSProperties = {
  border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 8,
  background: 'rgba(255,255,255,.055)',
  color: '#f5f5f5',
  minHeight: 32,
  padding: '0 10px',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

function pointerPoint(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  }
}

function renderStroke(ctx: CanvasRenderingContext2D, stroke: MaskStroke): void {
  if (stroke.points.length === 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.strokeStyle = stroke.mode === 'paint' ? '#ffffff' : '#000000'
  ctx.fillStyle = stroke.mode === 'paint' ? '#ffffff' : '#000000'
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (stroke.points.length === 1) {
    const point = stroke.points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }
  ctx.restore()
}

async function exportPng(canvas: HTMLCanvasElement): Promise<Blob> {
  // Keep luminance for ordinary ComfyUI mask loaders and also encode the
  // painted (white) region as transparent for OpenAI image-edit masks.
  // ComfyUI's LoadImage mask output inverts alpha, so both conventions point
  // at the same editable region.
  const output = document.createElement('canvas')
  output.width = canvas.width
  output.height = canvas.height
  const context = output.getContext('2d')
  if (context === null) throw new Error('The browser could not prepare this mask.')
  context.drawImage(canvas, 0, 0)
  const pixels = context.getImageData(0, 0, output.width, output.height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const intensity = pixels.data[index] ?? 0
    pixels.data[index + 3] = 255 - intensity
  }
  context.putImageData(pixels, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('The browser could not export this mask as PNG.')
  return blob
}

export function MaskModal(props: MaskModalProps): ReactNode {
  useLanguage()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeRef = useRef<MaskStroke | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [strokes, setStrokes] = useState<MaskStroke[]>([])
  const [redo, setRedo] = useState<MaskStroke[]>([])
  const [mode, setMode] = useState<MaskMode>('paint')
  const [brush, setBrush] = useState(64)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sourceKind = props.sourceKind ?? inferredSourceKind(props.sourceUrl)

  const redraw = useCallback((nextStrokes: MaskStroke[]): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas === null || canvas === undefined || ctx === null || ctx === undefined) return
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (const stroke of nextStrokes) renderStroke(ctx, stroke)
  }, [])

  useEffect(() => {
    if (!props.open) return
    activeRef.current = null
    setSize(null)
    setStrokes([])
    setRedo([])
    setMode('paint')
    setError(null)
  }, [props.open, props.sourceUrl, sourceKind])

  useEffect(() => {
    if (!props.open || size === null) return
    redraw(strokes)
  }, [props.open, redraw, size, strokes])

  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) props.onCancel()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          const restored = redo.at(-1)
          if (restored === undefined) return
          setRedo(redo.slice(0, -1))
          setStrokes([...strokes, restored])
        } else {
          const removed = strokes.at(-1)
          if (removed === undefined) return
          setStrokes(strokes.slice(0, -1))
          setRedo([...redo, removed])
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, props.onCancel, redo, strokes])

  if (!props.open) return null

  const imageLoaded = (image: HTMLImageElement): void => {
    const width = Math.max(1, image.naturalWidth)
    const height = Math.max(1, image.naturalHeight)
    const canvas = canvasRef.current
    if (canvas !== null) {
      canvas.width = width
      canvas.height = height
    }
    setSize({ width, height })
    window.requestAnimationFrame(() => redraw([]))
  }

  const videoLoaded = (video: HTMLVideoElement): void => {
    const width = Math.max(1, video.videoWidth)
    const height = Math.max(1, video.videoHeight)
    const canvas = canvasRef.current
    if (canvas !== null) {
      canvas.width = width
      canvas.height = height
    }
    setSize({ width, height })
    const requested = Math.max(0, props.sourceTime ?? 0)
    const seekTo = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(requested === 0 ? .001 : requested, Math.max(0, video.duration - .001))
      : requested
    try { video.currentTime = seekTo } catch { /* first decoded frame is still usable */ }
    window.requestAnimationFrame(() => redraw([]))
  }

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (busy || event.button !== 0 || size === null) return
    const canvas = canvasRef.current
    if (canvas === null) return
    event.preventDefault()
    event.stopPropagation()
    canvas.setPointerCapture(event.pointerId)
    const stroke: MaskStroke = { mode, width: brush, points: [pointerPoint(canvas, event)] }
    activeRef.current = stroke
    setRedo([])
    const ctx = canvas.getContext('2d')
    if (ctx !== null) renderStroke(ctx, stroke)
  }

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    const stroke = activeRef.current
    if (canvas === null || stroke === null || !canvas.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    event.stopPropagation()
    const next = pointerPoint(canvas, event)
    const prior = stroke.points.at(-1)
    if (prior !== undefined && Math.hypot(next.x - prior.x, next.y - prior.y) < 0.5) return
    stroke.points.push(next)
    const ctx = canvas.getContext('2d')
    if (ctx !== null && prior !== undefined) renderStroke(ctx, { ...stroke, points: [prior, next] })
  }

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    const stroke = activeRef.current
    if (canvas === null || stroke === null) return
    event.preventDefault()
    event.stopPropagation()
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    activeRef.current = null
    setStrokes(current => [...current, stroke])
  }

  const undo = (): void => {
    const removed = strokes.at(-1)
    if (removed === undefined) return
    setStrokes(strokes.slice(0, -1))
    setRedo([...redo, removed])
  }

  const redoStroke = (): void => {
    const restored = redo.at(-1)
    if (restored === undefined) return
    setRedo(redo.slice(0, -1))
    setStrokes([...strokes, restored])
  }

  const submit = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (canvas === null || size === null || busy) return
    setBusy(true)
    setError(null)
    try {
      redraw(strokes)
      const blob = await exportPng(canvas)
      const file = new File([blob], `mask-${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() })
      await props.onSubmit(file)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const landscape = size === null || size.width >= size.height
  const stageStyle: CSSProperties = size === null
    ? { width: 'min(900px, 88vw)', minHeight: 340 }
    : landscape
      ? { width: 'min(900px, 88vw)', aspectRatio: `${size.width} / ${size.height}` }
      : { height: 'min(62vh, 650px)', width: 'auto', maxWidth: '88vw', aspectRatio: `${size.width} / ${size.height}` }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title ?? 'Image mask editor'}
      className="nodrag nowheel nopan"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget && !busy) props.onCancel()
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0,0,0,.74)', backdropFilter: 'blur(8px)' }}
    >
      <section style={{ width: 'min(1020px, 96vw)', maxHeight: '94vh', display: 'flex', flexDirection: 'column', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,.14)', background: '#151515', color: '#f4f4f4', boxShadow: '0 28px 90px rgba(0,0,0,.58)', fontFamily: 'var(--dsw-alias-font, Inter, ui-sans-serif, system-ui, sans-serif)' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.09)', background: '#1d1d1d' }}>
          <strong style={{ fontSize: 13 }}>{props.title ?? t("Create mask copy")}</strong>
          <span title={props.sourceName} style={{ minWidth: 0, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,255,255,.45)', fontSize: 11 }}>
            {props.sourceName ?? 'Paint white where the workflow may edit'}
          </span>
          {size !== null ? <span style={{ color: 'rgba(255,255,255,.38)', fontSize: 10 }}>{size.width} × {size.height}</span> : null}
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={props.onCancel} style={buttonStyle}>{t("Close")}</button>
        </header>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          <button type="button" onClick={() => setMode('paint')} style={{ ...buttonStyle, background: mode === 'paint' ? 'rgba(122,162,255,.22)' : buttonStyle.background }}>{t("Paint mask")}</button>
          <button type="button" onClick={() => setMode('erase')} style={{ ...buttonStyle, background: mode === 'erase' ? 'rgba(122,162,255,.22)' : buttonStyle.background }}>{t("Erase mask")}</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,.62)', fontSize: 11 }}>
            {t("Brush")} {brush}px
            <input type="range" min={2} max={320} value={brush} onChange={event => setBrush(Number(event.target.value))} style={{ width: 150 }} />
          </label>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={strokes.length === 0} onClick={undo} style={buttonStyle}>{t("Undo")}</button>
          <button type="button" disabled={redo.length === 0} onClick={redoStroke} style={buttonStyle}>{t("Redo")}</button>
          <button type="button" disabled={strokes.length === 0} onClick={() => { setRedo([...redo, ...strokes]); setStrokes([]) }} style={buttonStyle}>{t("Clear")}</button>
        </div>

        <div style={{ minHeight: 0, flex: 1, overflow: 'auto', padding: 14, display: 'grid', placeItems: 'center', background: '#090909' }}>
          <div style={{ ...stageStyle, position: 'relative', overflow: 'hidden', borderRadius: 9, background: '#111', boxShadow: '0 8px 32px rgba(0,0,0,.45)' }}>
            {sourceKind === 'video' ? (
              <video
                src={props.sourceUrl}
                aria-label={props.sourceName ?? 'Video mask source'}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={event => videoLoaded(event.currentTarget)}
                onSeeked={() => redraw(strokes)}
                onError={() => setError('The source video could not be loaded.')}
                style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <img
                src={props.sourceUrl}
                alt={props.sourceName ?? 'Mask source'}
                draggable={false}
                onLoad={event => imageLoaded(event.currentTarget)}
                onError={() => setError('The source image could not be loaded.')}
                style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
              />
            )}
            <canvas
              ref={canvasRef}
              width={size?.width ?? 1}
              height={size?.height ?? 1}
              aria-label={t("Image mask drawing canvas")}
              onPointerDown={startStroke}
              onPointerMove={continueStroke}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', cursor: mode === 'erase' ? 'cell' : 'crosshair', touchAction: 'none', mixBlendMode: 'screen', opacity: .72 }}
            />
            {size === null ? <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,.48)', fontSize: 12, background: '#111' }}>{t("Loading source")} {sourceKind}…</div> : null}
          </div>
        </div>

        <footer style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: '1px solid rgba(255,255,255,.09)', background: '#1a1a1a' }}>
          {error !== null ? <span role="alert" style={{ color: '#ff948b', fontSize: 11 }}>{error}</span> : <span style={{ color: 'rgba(255,255,255,.42)', fontSize: 11 }}>{t("White = editable · Black = preserve · export is a grayscale PNG")}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={props.onCancel} style={buttonStyle}>{t("Cancel")}</button>
          <button type="button" disabled={busy || size === null} onClick={() => { void submit() }} style={{ ...buttonStyle, minWidth: 126, background: busy || size === null ? 'rgba(255,255,255,.08)' : '#f3f3f3', color: busy || size === null ? 'rgba(255,255,255,.45)' : '#111', fontWeight: 700 }}>
            {busy ? t("Saving…") : 'Create masked copy'}
          </button>
        </footer>
      </section>
    </div>
  )
}

export default MaskModal
