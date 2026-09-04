import type {
  AssetRef,
  SketchDocument,
  SketchElement,
  SketchPoint,
} from './types'

export const SKETCH_MIN_SIZE = 64
export const SKETCH_MAX_SIZE = 8192

export function clampSketchDimension(value: number): number {
  if (!Number.isFinite(value)) return SKETCH_MIN_SIZE
  return Math.max(SKETCH_MIN_SIZE, Math.min(SKETCH_MAX_SIZE, Math.round(value)))
}

export function createSketchDocument(
  width = 1280,
  height = 720,
  background = '#ffffff',
): SketchDocument {
  return {
    version: 1,
    width: clampSketchDimension(width),
    height: clampSketchDimension(height),
    background,
    elements: [],
  }
}

export function legacySketchDocument(
  asset: AssetRef,
  width = 1280,
  height = 720,
  background = '#ffffff',
): SketchDocument {
  const document = createSketchDocument(width, height, background)
  return {
    ...document,
    base: {
      asset,
      x: 0,
      y: 0,
      width: document.width,
      height: document.height,
    },
  }
}

function shiftPoint(point: SketchPoint, x: number, y: number): SketchPoint {
  return { x: point.x + x, y: point.y + y }
}

function shiftElement(element: SketchElement, x: number, y: number): SketchElement {
  if ('points' in element) {
    return { ...element, points: element.points.map(point => shiftPoint(point, x, y)) }
  }
  if ('point' in element) {
    return { ...element, point: shiftPoint(element.point, x, y) }
  }
  return {
    ...element,
    start: shiftPoint(element.start, x, y),
    end: shiftPoint(element.end, x, y),
  }
}

export function resizeSketchDocument(
  document: SketchDocument,
  width: number,
  height: number,
): SketchDocument {
  const nextWidth = clampSketchDimension(width)
  const nextHeight = clampSketchDimension(height)
  if (nextWidth === document.width && nextHeight === document.height) return document
  const x = (nextWidth - document.width) / 2
  const y = (nextHeight - document.height) / 2
  return {
    ...document,
    width: nextWidth,
    height: nextHeight,
    base: document.base === undefined
      ? undefined
      : { ...document.base, x: document.base.x + x, y: document.base.y + y },
    elements: document.elements.map(element => shiftElement(element, x, y)),
  }
}

export function sketchHasContent(document: SketchDocument): boolean {
  return document.base !== undefined || document.elements.length > 0
}

export function clearSketchDocument(document: SketchDocument): SketchDocument {
  if (!sketchHasContent(document)) return document
  const { base: _base, ...rest } = document
  return { ...rest, elements: [] }
}
