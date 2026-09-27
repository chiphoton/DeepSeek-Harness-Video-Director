import { useRef, type PointerEvent } from 'react'
import { t } from './i18n'
import { audioTime } from './audio-waveform'
import type { MediaCrop } from './media-editing'

export interface TrimRange { start: number; end: number; onChange(start: number, end: number): void }
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export function TrimSelection({ range, duration }: { range: TrimRange; duration: number }) {
  const drag = useRef<number | null>(null)
  if (!duration) return null
  const change = (edge: 'start' | 'end', value: number): void => edge === 'start'
    ? range.onChange(clamp(value, 0, range.end - .01), range.end)
    : range.onChange(range.start, clamp(value, range.start + .01, duration))
  const move = (event: PointerEvent<HTMLButtonElement>, edge: 'start' | 'end'): void => {
    if (drag.current !== event.pointerId) return
    const rect = event.currentTarget.parentElement!.getBoundingClientRect()
    change(edge, (event.clientX - rect.left) / rect.width * duration)
  }
  return <div className="vd-media-trim-selection">
    <div className="vd-media-trim-kept" style={{ left: `${range.start / duration * 100}%`, right: `${100 - range.end / duration * 100}%` }} />
    {(['start', 'end'] as const).map(edge => <button key={edge} type="button" role="slider" className="vd-media-trim-handle"
      aria-label={t(edge === 'start' ? 'Trim start' : 'Trim end')} aria-valuemin={edge === 'start' ? 0 : range.start + .01}
      aria-valuemax={edge === 'end' ? duration : range.end - .01} aria-valuenow={range[edge]} aria-valuetext={audioTime(range[edge], true)}
      style={{ left: `${range[edge] / duration * 100}%` }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); if (event.button !== 0) return; event.currentTarget.focus(); drag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => move(event, edge)}
      onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={() => { drag.current = null }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        change(edge, event.key === 'Home' ? 0 : event.key === 'End' ? duration : range[edge] + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .01))
      }}><i /><i /></button>)}
  </div>
}

export function constrainCrop(crop: MediaCrop, width: number, height: number): MediaCrop {
  const even = (value: number): number => Math.round(value / 2) * 2
  const w = clamp(even(crop.width), 2, Math.floor(width / 2) * 2)
  const h = clamp(even(crop.height), 2, Math.floor(height / 2) * 2)
  return { x: clamp(Math.round(crop.x), 0, width - w), y: clamp(Math.round(crop.y), 0, height - h), width: w, height: h }
}

export function VideoCropOverlay({ crop, width, height, onChange }: {
  crop: MediaCrop; width: number; height: number; onChange(crop: MediaCrop): void
}) {
  const drag = useRef<{ pointer: number; x: number; y: number; scaleX: number; scaleY: number; crop: MediaCrop; handle: string } | null>(null)
  const adjust = (base: MediaCrop, handle: string, dx: number, dy: number): MediaCrop => {
    if (handle === 'move') return constrainCrop({ ...base, x: base.x + dx, y: base.y + dy }, width, height)
    const left = handle.includes('w') ? clamp(base.x + dx, 0, base.x + base.width - 2) : base.x
    const top = handle.includes('n') ? clamp(base.y + dy, 0, base.y + base.height - 2) : base.y
    const right = handle.includes('e') ? clamp(base.x + base.width + dx, left + 2, width) : base.x + base.width
    const bottom = handle.includes('s') ? clamp(base.y + base.height + dy, top + 2, height) : base.y + base.height
    return constrainCrop({ x: left, y: top, width: right - left, height: bottom - top }, width, height)
  }
  const events = (handle: string) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus()
      const rect = event.currentTarget.closest('.vd-media-video-frame')!.getBoundingClientRect()
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, scaleX: width / rect.width, scaleY: height / rect.height, crop, handle }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const anchor = drag.current
      if (anchor?.pointer === event.pointerId) onChange(adjust(anchor.crop, anchor.handle, (event.clientX - anchor.x) * anchor.scaleX, (event.clientY - anchor.y) * anchor.scaleY))
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) },
    onPointerCancel: () => { drag.current = null },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 10 : 2
      onChange(adjust(crop, handle, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))
    },
  })
  return <div className="vd-media-crop-overlay">
    <div className="vd-media-crop-box" tabIndex={0} role="group" aria-label={t('Move crop region')}
      style={{ left: `${crop.x / width * 100}%`, top: `${crop.y / height * 100}%`, width: `${crop.width / width * 100}%`, height: `${crop.height / height * 100}%` }} {...events('move')}>
      <div className="vd-media-crop-grid" />
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner, index) => <button key={corner} type="button" className={`vd-media-crop-handle is-${corner}`}
        aria-label={t(['Resize crop top left', 'Resize crop top right', 'Resize crop bottom left', 'Resize crop bottom right'][index])} {...events(corner)} />)}
    </div>
  </div>
}
