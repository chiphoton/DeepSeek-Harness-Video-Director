import { t, useLanguage } from './i18n'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import {
  clearSketchDocument,
  clampSketchDimension,
  createSketchDocument,
  legacySketchDocument,
  resizeSketchDocument,
  SKETCH_MAX_SIZE,
  SKETCH_MIN_SIZE,
  sketchHasContent,
} from './sketch-document'
import { fitSketchCanvasView, zoomSketchCanvasView } from './sketch-view'
import type {
  AssetRef,
  SketchDocument,
  SketchElement,
  SketchPathElement,
  SketchPoint,
  SketchShapeElement,
  SketchTextElement,
  SketchTool,
} from './types'
import type { SketchCanvasView } from './sketch-view'

interface SketchHistory {
  past: SketchDocument[]
  present: SketchDocument
  future: SketchDocument[]
}

interface TextDraft {
  point: SketchPoint
  value: string
  color: string
  fontSize: number
  displayScale: number
}

interface CanvasCursorPreview {
  x: number
  y: number
  scale: number
}

interface CanvasPanGesture {
  pointerId: number
  startX: number
  startY: number
  viewX: number
  viewY: number
}

export interface SketchModalProps {
  open: boolean
  title?: string
  width?: number
  height?: number
  initialDocument?: SketchDocument
  initialAsset?: AssetRef
  background?: string
  submitLabel?: string
  onCancel(): void
  onSubmit(file: File, document: SketchDocument): void | Promise<void>
}

const colors = ['#111111', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6'] as const
const tools: readonly SketchTool[] = ['brush', 'rectangle', 'circle', 'ellipse', 'line', 'arrow', 'text', 'eraser']
const toolLabels: Record<SketchTool, string> = {
  brush: 'Brush',
  rectangle: 'Rectangle',
  circle: 'Circle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  eraser: 'Eraser',
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

function cloneSketch(document: SketchDocument): SketchDocument {
  return structuredClone(document)
}

function pointInCanvas(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>): SketchPoint {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  }
}

function drawPath(ctx: CanvasRenderingContext2D, element: SketchPathElement): void {
  if (element.points.length === 0) return
  ctx.save()
  ctx.globalCompositeOperation = element.type === 'eraser' ? 'destination-out' : 'source-over'
  ctx.strokeStyle = element.color
  ctx.fillStyle = element.color
  ctx.lineWidth = element.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (element.points.length === 1) {
    const point = element.points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, element.width / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(element.points[0].x, element.points[0].y)
    for (const point of element.points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }
  ctx.restore()
}

function shapeBounds(element: SketchShapeElement): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(element.start.x, element.end.x),
    y: Math.min(element.start.y, element.end.y),
    width: Math.abs(element.end.x - element.start.x),
    height: Math.abs(element.end.y - element.start.y),
  }
}

function drawShape(ctx: CanvasRenderingContext2D, element: SketchShapeElement): void {
  const { x, y, width, height } = shapeBounds(element)
  ctx.save()
  ctx.strokeStyle = element.color
  ctx.fillStyle = element.color
  ctx.lineWidth = element.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (element.type === 'rectangle') {
    ctx.rect(x, y, width, height)
  } else if (element.type === 'circle') {
    const diameter = Math.min(width, height)
    const centerX = element.start.x <= element.end.x ? x + diameter / 2 : x + width - diameter / 2
    const centerY = element.start.y <= element.end.y ? y + diameter / 2 : y + height - diameter / 2
    ctx.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2)
  } else if (element.type === 'ellipse') {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  } else {
    ctx.moveTo(element.start.x, element.start.y)
    ctx.lineTo(element.end.x, element.end.y)
    if (element.type === 'arrow') {
      const angle = Math.atan2(element.end.y - element.start.y, element.end.x - element.start.x)
      const head = Math.max(12, Math.min(48, element.width * 3.5))
      ctx.moveTo(element.end.x, element.end.y)
      ctx.lineTo(element.end.x - head * Math.cos(angle - Math.PI / 7), element.end.y - head * Math.sin(angle - Math.PI / 7))
      ctx.moveTo(element.end.x, element.end.y)
      ctx.lineTo(element.end.x - head * Math.cos(angle + Math.PI / 7), element.end.y - head * Math.sin(angle + Math.PI / 7))
    }
  }
  ctx.stroke()
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, element: SketchTextElement): void {
  ctx.save()
  ctx.fillStyle = element.color
  ctx.font = `${String(element.fontSize)}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.textBaseline = 'top'
  const lines = element.text.split('\n')
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, element.point.x, element.point.y + index * element.fontSize * 1.2)
  }
  ctx.restore()
}

function drawElement(ctx: CanvasRenderingContext2D, element: SketchElement): void {
  if ('points' in element) drawPath(ctx, element)
  else if ('point' in element) drawText(ctx, element)
  else drawShape(ctx, element)
}

function renderSketch(
  canvas: HTMLCanvasElement,
  sketch: SketchDocument,
  baseImage: HTMLImageElement | null,
  draft?: SketchElement,
): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const layer = window.document.createElement('canvas')
  layer.width = sketch.width
  layer.height = sketch.height
  const layerCtx = layer.getContext('2d')
  if (layerCtx === null) return
  if (sketch.base !== undefined && baseImage !== null) {
    layerCtx.drawImage(baseImage, sketch.base.x, sketch.base.y, sketch.base.width, sketch.base.height)
  }
  for (const element of sketch.elements) drawElement(layerCtx, element)
  if (draft !== undefined) drawElement(layerCtx, draft)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = sketch.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(layer, 0, 0)
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('The browser could not export this sketch as PNG.')
  return blob
}

function ToolIcon({ tool }: { tool: SketchTool }): ReactNode {
  useLanguage()
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (tool === 'brush') return <svg viewBox="0 0 24 24" aria-hidden><path {...common} d="M4 20c3.8.2 5.8-1.1 6-4 0-1.7 1.2-3 2.8-3.1L19 5.7 16.3 3l-7.1 6.3c-.2 1.7-1.4 2.8-3.1 2.8C3.2 12.3 2 14.4 4 20Z" /></svg>
  if (tool === 'rectangle') return <svg viewBox="0 0 24 24" aria-hidden><rect {...common} x="4" y="5" width="16" height="14" rx="1" /></svg>
  if (tool === 'circle') return <svg viewBox="0 0 24 24" aria-hidden><circle {...common} cx="12" cy="12" r="8" /></svg>
  if (tool === 'ellipse') return <svg viewBox="0 0 24 24" aria-hidden><ellipse {...common} cx="12" cy="12" rx="9" ry="6" /></svg>
  if (tool === 'line') return <svg viewBox="0 0 24 24" aria-hidden><path {...common} d="M5 19 19 5" /></svg>
  if (tool === 'arrow') return <svg viewBox="0 0 24 24" aria-hidden><path {...common} d="M4 18 19 5m0 0-1 7m1-7-7 1" /></svg>
  if (tool === 'text') return <svg viewBox="0 0 24 24" aria-hidden><path {...common} d="M5 6V4h14v2M12 4v16m-4 0h8" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden><path {...common} d="m7 17 9-11 4 4-7 9H9l-2-2Zm0 0-3-3 8-9 4 1" /><path {...common} d="M12 19h8" /></svg>
}

function initialHistory(props: SketchModalProps): SketchHistory {
  const background = props.background ?? '#ffffff'
  const width = clampSketchDimension(props.width ?? 1280)
  const height = clampSketchDimension(props.height ?? 720)
  const present = props.initialDocument !== undefined
    ? cloneSketch(props.initialDocument)
    : props.initialAsset !== undefined
      ? legacySketchDocument(props.initialAsset, width, height, background)
      : createSketchDocument(width, height, background)
  return { past: [], present, future: [] }
}

function newElement(tool: SketchTool, point: SketchPoint, color: string, width: number): SketchElement {
  const id = crypto.randomUUID()
  if (tool === 'brush' || tool === 'eraser') {
    return { id, type: tool, color, width, points: [point] }
  }
  if (tool === 'text') {
    return { id, type: 'text', color, fontSize: Math.max(12, width * 2), point, text: '' }
  }
  return { id, type: tool, color, width, start: point, end: point }
}

export function SketchModal(props: SketchModalProps): ReactNode {
  useLanguage()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasShellRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<SketchElement | null>(null)
  const panRef = useRef<CanvasPanGesture | null>(null)
  const baseImageRef = useRef<{ url: string; image: HTMLImageElement } | null>(null)
  const brushPreviewTimerRef = useRef<number | undefined>(undefined)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [history, setHistory] = useState<SketchHistory>(() => initialHistory(props))
  const [tool, setTool] = useState<SketchTool>('brush')
  const [color, setColor] = useState<string>('#111111')
  const [brush, setBrush] = useState(8)
  const [brushDraft, setBrushDraft] = useState('8')
  const [brushPreviewSize, setBrushPreviewSize] = useState(8)
  const [brushPreviewVisible, setBrushPreviewVisible] = useState(false)
  const [canvasCursor, setCanvasCursor] = useState<CanvasCursorPreview | null>(null)
  const [canvasView, setCanvasView] = useState<SketchCanvasView>(() => fitSketchCanvasView())
  const [panning, setPanning] = useState(false)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)
  const [widthDraft, setWidthDraft] = useState(String(history.present.width))
  const [heightDraft, setHeightDraft] = useState(String(history.present.height))
  const [baseImageVersion, setBaseImageVersion] = useState(0)
  const [baseLoading, setBaseLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sketch = history.present

  const redraw = useCallback((document: SketchDocument, draft?: SketchElement): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const base = document.base
    const cached = base !== undefined && baseImageRef.current?.url === base.asset.url
      ? baseImageRef.current.image
      : null
    renderSketch(canvas, document, cached, draft)
  }, [])

  useEffect(() => {
    if (!props.open) return
    const next = initialHistory(props)
    activeRef.current = null
    panRef.current = null
    baseImageRef.current = null
    setHistory(next)
    setTool('brush')
    setTextDraft(null)
    setWidthDraft(String(next.present.width))
    setHeightDraft(String(next.present.height))
    setBrush(8)
    setBrushDraft('8')
    setBrushPreviewVisible(false)
    setCanvasCursor(null)
    setCanvasView(fitSketchCanvasView())
    setPanning(false)
    setError(null)
  }, [props.open, props.initialDocument, props.initialAsset, props.width, props.height, props.background])

  const baseUrl = sketch.base?.asset.url
  useEffect(() => {
    if (!props.open) return
    if (baseUrl === undefined) {
      baseImageRef.current = null
      setBaseLoading(false)
      setBaseImageVersion(version => version + 1)
      return
    }
    if (baseImageRef.current?.url === baseUrl) return
    let cancelled = false
    setBaseLoading(true)
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      baseImageRef.current = { url: baseUrl, image }
      setBaseLoading(false)
      setBaseImageVersion(version => version + 1)
    }
    image.onerror = () => {
      if (cancelled) return
      setBaseLoading(false)
      setError('The editable sketch base image could not be loaded.')
    }
    image.src = baseUrl
    return () => { cancelled = true }
  }, [baseUrl, props.open])

  useEffect(() => {
    if (!props.open) return
    redraw(sketch, activeRef.current ?? undefined)
  }, [baseImageVersion, props.open, redraw, sketch])

  useEffect(() => {
    setWidthDraft(String(sketch.width))
    setHeightDraft(String(sketch.height))
  }, [sketch.width, sketch.height])

  useEffect(() => {
    if (textDraft !== null) window.requestAnimationFrame(() => textInputRef.current?.focus())
  }, [textDraft])

  useEffect(() => () => {
    if (brushPreviewTimerRef.current !== undefined) window.clearTimeout(brushPreviewTimerRef.current)
  }, [])

  useEffect(() => {
    if (!props.open) return
    const canvas = canvasRef.current
    const shell = canvasShellRef.current
    if (canvas === null || shell === null) return
    const onWheel = (event: WheelEvent): void => {
      if (busy) return
      event.preventDefault()
      event.stopPropagation()
      const rect = shell.getBoundingClientRect()
      const deltaY = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * rect.height
          : event.deltaY
      setCanvasView(current => zoomSketchCanvasView(current, {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      }, deltaY))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [busy, props.open])

  const commit = useCallback((next: SketchDocument): void => {
    activeRef.current = null
    setHistory(current => ({
      past: [...current.past.slice(-99), current.present],
      present: cloneSketch(next),
      future: [],
    }))
  }, [])

  const undo = useCallback((): void => {
    activeRef.current = null
    setTextDraft(null)
    setHistory(current => {
      const restored = current.past.at(-1)
      if (restored === undefined) return current
      return {
        past: current.past.slice(0, -1),
        present: restored,
        future: [current.present, ...current.future].slice(0, 100),
      }
    })
  }, [])

  const redo = useCallback((): void => {
    activeRef.current = null
    setTextDraft(null)
    setHistory(current => {
      const restored = current.future[0]
      if (restored === undefined) return current
      return {
        past: [...current.past.slice(-99), current.present],
        present: restored,
        future: current.future.slice(1),
      }
    })
  }, [])

  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Escape' && !busy) props.onCancel()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, props.onCancel, props.open, redo, undo])

  if (!props.open) return null

  const showBrushPreview = (nextBrush: number): void => {
    const next = Math.max(1, Math.min(200, Math.round(nextBrush)))
    setBrush(next)
    setBrushDraft(String(next))
    const canvas = canvasRef.current
    const scale = canvas === null ? 1 : canvas.clientWidth / Math.max(1, canvas.width)
    setBrushPreviewSize(Math.max(2, next * scale))
    setBrushPreviewVisible(true)
    if (brushPreviewTimerRef.current !== undefined) window.clearTimeout(brushPreviewTimerRef.current)
    brushPreviewTimerRef.current = window.setTimeout(() => setBrushPreviewVisible(false), 850)
  }

  const commitText = (draft = textDraft): SketchDocument => {
    if (draft === null || draft.value.trim() === '') {
      setTextDraft(null)
      return sketch
    }
    const next: SketchDocument = {
      ...sketch,
      elements: [...sketch.elements, {
        id: crypto.randomUUID(),
        type: 'text',
        color: draft.color,
        fontSize: draft.fontSize,
        point: draft.point,
        text: draft.value.trim(),
      }],
    }
    setTextDraft(null)
    commit(next)
    return next
  }

  const updateCanvasCursor = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    setCanvasCursor({
      x: (event.clientX - rect.left) * (canvas.clientWidth / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (canvas.clientHeight / Math.max(1, rect.height)),
      scale: canvas.clientWidth / Math.max(1, canvas.width),
    })
  }

  const fitCanvasView = (): void => {
    panRef.current = null
    setPanning(false)
    setCanvasView(fitSketchCanvasView())
  }

  const startElement = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (busy) return
    const canvas = canvasRef.current
    if (canvas === null) return
    if (event.button === 2) {
      event.preventDefault()
      event.stopPropagation()
      canvas.setPointerCapture(event.pointerId)
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: canvasView.x,
        viewY: canvasView.y,
      }
      setCanvasCursor(null)
      setPanning(true)
      return
    }
    if (event.button !== 0) return
    updateCanvasCursor(event)
    event.preventDefault()
    event.stopPropagation()
    const point = pointInCanvas(canvas, event)
    if (tool === 'text') {
      setTextDraft({
        point,
        value: '',
        color,
        fontSize: Math.max(12, brush * 2),
        displayScale: canvas.clientWidth / Math.max(1, canvas.width),
      })
      return
    }
    canvas.setPointerCapture(event.pointerId)
    const element = newElement(tool, point, color, brush)
    activeRef.current = element
    redraw(sketch, element)
  }

  const continueElement = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const pan = panRef.current
    if (pan?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      setCanvasView(current => ({
        ...current,
        x: pan.viewX + event.clientX - pan.startX,
        y: pan.viewY + event.clientY - pan.startY,
      }))
      return
    }
    updateCanvasCursor(event)
    const canvas = canvasRef.current
    const element = activeRef.current
    if (canvas === null || element === null || !canvas.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    event.stopPropagation()
    const next = pointInCanvas(canvas, event)
    if ('points' in element) {
      const prior = element.points.at(-1)
      if (prior !== undefined && Math.hypot(next.x - prior.x, next.y - prior.y) < 0.5) return
      element.points.push(next)
    } else if ('end' in element) {
      element.end = next
    }
    redraw(sketch, element)
  }

  const finishElement = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    const pan = panRef.current
    if (canvas !== null && pan?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      panRef.current = null
      setPanning(false)
      return
    }
    const element = activeRef.current
    if (canvas === null || element === null) return
    event.preventDefault()
    event.stopPropagation()
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    activeRef.current = null
    commit({ ...sketch, elements: [...sketch.elements, cloneSketchElement(element)] })
  }

  const applyCanvasSize = (): void => {
    const width = Number(widthDraft)
    const height = Number(heightDraft)
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      setError('Canvas width and height must be numbers.')
      return
    }
    const nextWidth = clampSketchDimension(width)
    const nextHeight = clampSketchDimension(height)
    setWidthDraft(String(nextWidth))
    setHeightDraft(String(nextHeight))
    setError(null)
    const next = resizeSketchDocument(sketch, nextWidth, nextHeight)
    if (next !== sketch) {
      fitCanvasView()
      commit(next)
    }
  }

  const onSizeKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      applyCanvasSize()
    }
  }

  const submit = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (canvas === null || busy) return
    setBusy(true)
    setError(null)
    try {
      let output = sketch
      if (textDraft !== null && textDraft.value.trim() !== '') output = commitText(textDraft)
      if (output.base !== undefined && baseImageRef.current?.url !== output.base.asset.url) {
        throw new Error('Wait for the editable sketch base image to finish loading.')
      }
      renderSketch(canvas, output, baseImageRef.current?.image ?? null)
      const blob = await canvasPng(canvas)
      const file = new File([blob], `sketch-${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() })
      await props.onSubmit(file, cloneSketch(output))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title ?? 'Sketch editor'}
      className="nodrag nowheel nopan vd-sketch-dialog-backdrop"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget && !busy) props.onCancel()
      }}
    >
      <section className="vd-sketch-dialog">
        <header className="vd-sketch-dialog-header">
          <strong>{props.title ?? 'New sketch'}</strong>
          <span className="vd-sketch-canvas-size" aria-label={t("Canvas size")}>
            <label>
              <span>W</span>
              <input type="number" min={SKETCH_MIN_SIZE} max={SKETCH_MAX_SIZE} value={widthDraft} aria-label={t("Canvas width")} onChange={event => setWidthDraft(event.target.value)} onKeyDown={onSizeKeyDown} />
            </label>
            <span aria-hidden>×</span>
            <label>
              <span>H</span>
              <input type="number" min={SKETCH_MIN_SIZE} max={SKETCH_MAX_SIZE} value={heightDraft} aria-label={t("Canvas height")} onChange={event => setHeightDraft(event.target.value)} onKeyDown={onSizeKeyDown} />
            </label>
            <button type="button" disabled={busy} onClick={applyCanvasSize}>{t("Resize")}</button>
            <small>PNG</small>
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={props.onCancel} style={buttonStyle}>{t("Close")}</button>
        </header>

        <div className="vd-sketch-toolbar">
          <div className="vd-sketch-toolbar-primary">
            <span className="vd-sketch-history" role="group" aria-label={t("Sketch history")}>
              <button type="button" disabled={history.past.length === 0 || busy} onClick={undo} style={buttonStyle}>{t("Undo")}</button>
              <button type="button" disabled={history.future.length === 0 || busy} onClick={redo} style={buttonStyle}>{t("Redo")}</button>
            </span>
            <span aria-label={t("Brush colors")} className="vd-sketch-colors">
              {colors.map(value => (
                <button
                  key={value}
                  type="button"
                  title={value}
                  aria-label={`Use color ${value}`}
                  onClick={() => { setColor(value); if (tool === 'eraser') setTool('brush') }}
                  style={{ borderColor: color === value && tool !== 'eraser' ? '#7aa2ff' : undefined, background: value, boxShadow: value === '#ffffff' ? 'inset 0 0 0 1px #888' : undefined }}
                />
              ))}
            </span>
            <label className="vd-sketch-brush-size">
              <span>{t("Size")}</span>
              <input
                type="number"
                min={1}
                max={200}
                value={brushDraft}
                aria-label={t("Brush size value")}
                onChange={event => {
                  setBrushDraft(event.target.value)
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1 && value <= 200) showBrushPreview(value)
                }}
                onBlur={() => showBrushPreview(Number(brushDraft) || brush)}
              />
              <span>px</span>
              <input type="range" min={1} max={200} value={brush} aria-label={t("Brush size")} onChange={event => showBrushPreview(Number(event.target.value))} />
            </label>
            <span className="vd-sketch-view-actions">
              <button type="button" disabled={busy} onClick={fitCanvasView} style={buttonStyle}>{t("Fit")}</button>
              <button type="button" disabled={!sketchHasContent(sketch) || busy} onClick={() => commit(clearSketchDocument(sketch))} style={buttonStyle}>{t("Clear")}</button>
            </span>
          </div>
          <div className="vd-sketch-tools" role="toolbar" aria-label={t("Drawing tools")}>
            {tools.map(value => (
              <button
                key={value}
                type="button"
                className={tool === value ? 'is-active' : undefined}
                aria-pressed={tool === value}
                aria-label={t(toolLabels[value])}
                title={t(toolLabels[value])}
                onClick={() => setTool(value)}
              >
                <ToolIcon tool={value} />
                <span>{t(toolLabels[value])}</span>
              </button>
            ))}
          </div>
        </div>

        <div ref={canvasShellRef} className="vd-sketch-canvas-shell">
          <div
            className="vd-sketch-canvas-wrap"
            data-view-scale={canvasView.scale}
            style={{ transform: `translate3d(${String(canvasView.x)}px, ${String(canvasView.y)}px, 0) scale(${String(canvasView.scale)})` }}
          >
            <canvas
              ref={canvasRef}
              width={sketch.width}
              height={sketch.height}
              aria-label={t("Sketch drawing canvas")}
              onPointerDown={startElement}
              onPointerEnter={updateCanvasCursor}
              onPointerMove={continueElement}
              onPointerUp={finishElement}
              onPointerCancel={finishElement}
              onPointerLeave={() => setCanvasCursor(null)}
              onLostPointerCapture={event => {
                if (panRef.current?.pointerId !== event.pointerId) return
                panRef.current = null
                setPanning(false)
              }}
              onContextMenu={event => event.preventDefault()}
              style={{ aspectRatio: `${String(sketch.width)} / ${String(sketch.height)}`, background: sketch.background, cursor: panning ? 'grabbing' : 'none' }}
            />
            {canvasCursor !== null ? (
              <span
                className={`vd-sketch-canvas-cursor${tool === 'eraser' ? ' is-eraser' : ''}`}
                aria-hidden
                style={{
                  left: canvasCursor.x,
                  top: canvasCursor.y,
                  width: Math.max(2, (tool === 'text' ? Math.max(12, brush * 2) : brush) * canvasCursor.scale),
                  height: Math.max(2, (tool === 'text' ? Math.max(12, brush * 2) : brush) * canvasCursor.scale),
                  borderColor: tool === 'eraser' ? '#000000' : color,
                  background: tool === 'eraser' ? 'rgba(210, 210, 210, .38)' : `${color}99`,
                }}
              />
            ) : null}
            {brushPreviewVisible ? (
              <span
                className="vd-sketch-brush-preview"
                aria-label={`Brush size preview ${String(brush)} pixels`}
                style={{ width: Math.max(96, brushPreviewSize + 32), height: Math.max(96, brushPreviewSize + 32) }}
              >
                <i style={{ width: brushPreviewSize, height: brushPreviewSize }} />
              </span>
            ) : null}
            {textDraft !== null ? (
              <textarea
                ref={textInputRef}
                className="vd-sketch-text-editor"
                aria-label={t("Sketch text")}
                value={textDraft.value}
                rows={2}
                placeholder={t("Type text…")}
                onChange={event => setTextDraft({ ...textDraft, value: event.target.value })}
                onBlur={() => { commitText() }}
                onKeyDown={event => {
                  event.stopPropagation()
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setTextDraft(null)
                  } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    commitText()
                  }
                }}
                style={{
                  left: `${String((textDraft.point.x / sketch.width) * 100)}%`,
                  top: `${String((textDraft.point.y / sketch.height) * 100)}%`,
                  color: textDraft.color,
                  fontSize: Math.max(12, textDraft.fontSize * textDraft.displayScale),
                }}
              />
            ) : null}
          </div>
        </div>

        <footer className="vd-sketch-dialog-footer">
          {error !== null ? <span role="alert">{error}</span> : <span>{t(baseLoading ? 'Loading editable canvas…' : '⌘/Ctrl+Z to undo · Shift+⌘/Ctrl+Z to redo')}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={props.onCancel} style={buttonStyle}>{t("Cancel")}</button>
          <button type="button" disabled={busy || baseLoading} onClick={() => { void submit() }} className="vd-sketch-submit">
            {busy ? t("Saving…") : t(props.submitLabel ?? 'Add to canvas')}
          </button>
        </footer>
      </section>
    </div>,
    window.document.body,
  )
}

function cloneSketchElement(element: SketchElement): SketchElement {
  return structuredClone(element)
}

export default SketchModal
