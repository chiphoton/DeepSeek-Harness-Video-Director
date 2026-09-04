export interface SketchCanvasView {
  scale: number
  x: number
  y: number
}

export interface SketchViewPoint {
  x: number
  y: number
}

export const SKETCH_VIEW_MIN_SCALE = 0.25
export const SKETCH_VIEW_MAX_SCALE = 8

export function fitSketchCanvasView(): SketchCanvasView {
  return { scale: 1, x: 0, y: 0 }
}

export function zoomSketchCanvasView(
  view: SketchCanvasView,
  pointer: SketchViewPoint,
  deltaY: number,
): SketchCanvasView {
  if (!Number.isFinite(deltaY) || deltaY === 0) return view
  const scale = Math.max(
    SKETCH_VIEW_MIN_SCALE,
    Math.min(SKETCH_VIEW_MAX_SCALE, view.scale * Math.exp(-deltaY * 0.0015)),
  )
  if (scale === view.scale) return view
  const ratio = scale / view.scale
  return {
    scale,
    x: pointer.x - (pointer.x - view.x) * ratio,
    y: pointer.y - (pointer.y - view.y) * ratio,
  }
}
