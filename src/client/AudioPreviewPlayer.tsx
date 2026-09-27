import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { AssetRef } from './types'
import { t } from './i18n'
import { audioTime, loadAudioWaveform, waveformPath, type AudioWaveform } from './audio-waveform'
import { TrimSelection, type TrimRange } from './MediaSelections'

function SkipIcon({ forward = false }: { forward?: boolean }) {
  return <svg viewBox="0 0 32 32" aria-hidden="true">
    <g transform={forward ? 'translate(32 0) scale(-1 1)' : undefined}>
      <path d="M12 7.5h4a10.5 10.5 0 1 1-10.5 10.5" />
      <path d="m16 3.5-4 4 4 4" />
    </g>
    <text x="16" y="22" textAnchor="middle">15</text>
  </svg>
}

export function AudioPreviewPlayer({ asset, duration: hint, onDuration, selection, videoSize, videoOverlay, onTimeChange, onMediaReady }: {
  asset: AssetRef
  duration?: number
  onDuration(duration: number): void
  selection?: TrimRange
  videoSize?: { width: number; height: number }
  videoOverlay?: ReactNode
  onTimeChange?(time: number): void
  onMediaReady?(media: HTMLMediaElement): void
}) {
  const audio = useRef<HTMLMediaElement | null>(null)
  const video = asset.kind === 'video'
  const [duration, setDuration] = useState(hint ?? 0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [windowSize, setWindowSize] = useState(12)
  const [waveform, setWaveform] = useState<AudioWaveform | null>(null)
  const [waveformError, setWaveformError] = useState(false)
  const [playbackError, setPlaybackError] = useState(false)
  const drag = useRef<{ pointer: number; start: number; span: number } | null>(null)
  const span = Math.min(windowSize, Math.max(1, duration))
  const start = time - span / 2
  const progress = duration > 0 ? Math.min(100, time / duration * 100) : 0
  const detailedPath = useMemo(() => waveformPath(waveform, start, span), [waveform, start, span])
  const overviewPath = useMemo(() => waveformPath(waveform, 0, waveform?.duration ?? 0, 320), [waveform])
  const rangeStart = selection?.start ?? 0
  const rangeEnd = selection?.end ?? duration
  useEffect(() => { onTimeChange?.(time) }, [time, onTimeChange])

  useEffect(() => { if (hint && Number.isFinite(hint)) setDuration(hint) }, [hint])

  useEffect(() => {
    if (!(duration > 0)) return
    const controller = new AbortController()
    setWaveformError(false)
    void loadAudioWaveform(asset, duration, controller.signal).then(result => {
      if (!controller.signal.aborted) setWaveform(result)
    }).catch(() => { if (!controller.signal.aborted) setWaveformError(true) })
    return () => controller.abort()
  }, [asset.id, asset.url, asset.sha256, duration])

  useEffect(() => {
    const element = audio.current
    return () => { element?.pause() }
  }, [])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = (): void => {
      const element = audio.current
      if (element && element.currentTime >= rangeEnd && rangeEnd > 0) { element.pause(); element.currentTime = rangeEnd }
      setTime(element?.currentTime ?? 0); frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, rangeEnd])

  const readDuration = (): void => {
    const value = audio.current?.duration
    if (value && Number.isFinite(value)) { setDuration(value); onDuration(value) }
  }
  const seek = (value: number): void => {
    const element = audio.current
    if (!element || !duration) return
    const next = Math.max(rangeStart, Math.min(rangeEnd, value))
    try { element.currentTime = next; setTime(next) } catch { /* Media has not loaded its seekable timeline yet. */ }
  }
  const togglePlayback = async (): Promise<void> => {
    const element = audio.current
    if (!element) return
    if (!element.paused) { element.pause(); return }
    if (element.ended || element.currentTime >= rangeEnd || element.currentTime < rangeStart) seek(rangeStart)
    setPlaybackError(false)
    try { await element.play() } catch { setPlaybackError(true) }
  }
  const keySeek = (event: KeyboardEvent): void => {
    let value: number | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') value = time - (event.shiftKey ? 5 : .1)
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') value = time + (event.shiftKey ? 5 : .1)
    if (event.key === 'Home') value = 0
    if (event.key === 'End') value = duration
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void togglePlayback(); return }
    if (value === undefined) return
    event.preventDefault(); event.stopPropagation(); seek(value)
  }
  const seekPointer = (event: PointerEvent<HTMLDivElement>, range: { start: number; span: number }): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width) seek(range.start + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * range.span)
  }
  const timelineProps = (overview: boolean) => ({
    role: 'slider', tabIndex: 0, 'aria-label': t(overview ? video ? 'Video timeline' : 'Audio overview' : 'Audio waveform'),
    'aria-valuemin': 0, 'aria-valuemax': duration, 'aria-valuenow': time,
    'aria-valuetext': `${audioTime(time, true)} / ${audioTime(duration)}`,
    onKeyDown: keySeek,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || duration <= 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointer: event.pointerId, start: overview ? 0 : start, span: overview ? duration : span }
      seekPointer(event, drag.current)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.pointer === event.pointerId) seekPointer(event, drag.current)
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.pointer !== event.pointerId) return
      drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId)
    },
    onPointerCancel: () => { drag.current = null },
  })
  const interval = span <= 8 ? 1 : span <= 20 ? 2 : span <= 60 ? 5 : Math.ceil(span / 12 / 5) * 5
  const ticks = Array.from({ length: Math.ceil(span / interval) + 1 }, (_, index) => Math.ceil(start / interval) * interval + index * interval)
    .filter(value => value >= 0 && value <= duration && value < start + span)

  const mediaProps = {
    ref: (element: HTMLMediaElement | null): void => { audio.current = element }, src: asset.url, preload: 'metadata',
    onLoadedMetadata: (): void => { readDuration(); if (audio.current) onMediaReady?.(audio.current) }, onDurationChange: readDuration,
    onTimeUpdate: (): void => setTime(audio.current?.currentTime ?? 0),
    onPlay: (): void => setPlaying(true), onPause: (): void => setPlaying(false),
    onEnded: (): void => { setPlaying(false); setTime(audio.current?.currentTime ?? duration) },
    onError: (): void => { setPlaying(false); setPlaybackError(true) },
  }
  return <div className={`vd-audio-player${video ? ' is-video-player' : ''}`}>
    {video ? <div className="vd-media-video-stage"><div className="vd-media-video-frame"
      style={{ aspectRatio: (videoSize?.width || 16) / (videoSize?.height || 9), width: `min(100%, calc(var(--vd-media-stage-height) * ${(videoSize?.width || 16) / (videoSize?.height || 9)}))` }}>
      <video {...mediaProps} playsInline />{videoOverlay}
    </div></div> : <audio {...mediaProps} />}
    {!video ? <div className="vd-audio-detail" {...timelineProps(false)}>
      <div className="vd-audio-past" />
      <svg className="vd-audio-wave" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"><path d={detailedPath} /></svg>
      {!waveform ? <div className="vd-audio-wave-message" role="status">{t(waveformError ? 'Waveform unavailable. You can still play and seek.' : 'Reading waveform…')}</div> : null}
      <div className="vd-audio-ruler" aria-hidden="true">{ticks.map(value => <span key={value} style={{ left: `${(value - start) / span * 100}%` }}>{audioTime(value)}</span>)}</div>
      <div className="vd-audio-playhead" aria-hidden="true" />
    </div> : null}
    <div className="vd-audio-navigation">
      <div className="vd-audio-overview-wrap">
      <div className="vd-audio-overview" {...timelineProps(true)}>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"><path d={overviewPath} /></svg>
        <div className="vd-audio-overview-progress" style={{ width: `${progress}%` }} />
        <i style={{ left: `${progress}%` }} aria-hidden="true" />
      </div>
      {selection ? <TrimSelection range={selection} duration={duration} /> : null}
      </div>
      <div className="vd-audio-overview-labels"><span>0:00</span><div className="vd-audio-zoom">
        <button type="button" aria-label={t('Zoom out')} title={t('Zoom out')} disabled={span >= duration} onClick={() => setWindowSize(Math.min(duration, span * 2))}>−</button>
        <span>{t('{0}s view', Number(span.toFixed(1)))}</span>
        <button type="button" aria-label={t('Zoom in')} title={t('Zoom in')} disabled={span <= 1} onClick={() => setWindowSize(Math.max(1, span / 2))}>+</button>
      </div><span>{audioTime(duration)}</span></div>
      <output className="vd-audio-time" role="timer" aria-live="off" aria-label={t('Playback time')}>{audioTime(time, true)}</output>
      <div className="vd-audio-controls">
        <div className="vd-audio-volume">
          <button type="button" aria-label={t(muted ? 'Unmute' : 'Mute')} title={t(muted ? 'Unmute' : 'Mute')} aria-pressed={muted}
            onClick={() => { if (audio.current) audio.current.muted = !muted; setMuted(!muted) }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5 5 9H2v6h3l5 4V5Z" />{muted || volume === 0 ? <path d="m15 9 6 6m0-6-6 6" /> : <path d="M14 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />}</svg>
          </button>
          <input type="range" aria-label={t('Volume')} min="0" max="1" step="0.01" value={muted ? 0 : volume}
            onChange={event => { const value = Number(event.target.value); setVolume(value); setMuted(false); if (audio.current) { audio.current.volume = value; audio.current.muted = false } }} />
        </div>
        <div className="vd-audio-transport">
          <button type="button" aria-label={t('Back 15 seconds')} title={t('Back 15 seconds')} disabled={!duration} onClick={() => seek(time - 15)}><SkipIcon /></button>
          <button type="button" className="vd-audio-play" aria-label={t(playing ? 'Pause' : 'Play')} title={t(playing ? 'Pause' : 'Play')} onClick={() => { void togglePlayback() }}>
            <svg viewBox="0 0 32 32" aria-hidden="true">{playing ? <path d="M9 6h5v20H9zm10 0h5v20h-5z" /> : <path d="M10 5 27 16 10 27Z" />}</svg>
          </button>
          <button type="button" aria-label={t('Forward 15 seconds')} title={t('Forward 15 seconds')} disabled={!duration} onClick={() => seek(time + 15)}><SkipIcon forward /></button>
        </div>
        <select className="vd-audio-rate" aria-label={t('Playback speed')} value={rate}
          onChange={event => { const value = Number(event.target.value); setRate(value); if (audio.current) audio.current.playbackRate = value }}>
          {[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
      </div>
      {playbackError ? <p className="vd-audio-error" role="alert">{t('Could not play this audio. Try again or download the file.')}</p> : null}
    </div>
  </div>
}
