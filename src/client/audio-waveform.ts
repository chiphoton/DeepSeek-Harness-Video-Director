import type { AssetRef } from './types'

export interface AudioWaveform {
  duration: number
  peaks: Float32Array
}

// Only compact envelopes are cached; decoded PCM and audio contexts are released.
const cache = new Map<string, AudioWaveform>()
const MAX_DECODE_BYTES = 64 * 1024 * 1024
const MAX_DECODE_SECONDS = 3600

export async function loadAudioWaveform(asset: AssetRef, duration: number, signal: AbortSignal): Promise<AudioWaveform> {
  const key = `${asset.id}:${asset.sha256}`
  const existing = cache.get(key)
  if (existing) return existing
  if (asset.size > MAX_DECODE_BYTES || duration > MAX_DECODE_SECONDS) throw new Error('Waveform preview is unavailable for this file. You can still play and seek.')
  const response = await fetch(asset.url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error('Could not load the waveform. You can still play and seek.')
  const bytes = await response.arrayBuffer()
  signal.throwIfAborted()
  // Low-rate offline decoding avoids an output device or an autoplay permission.
  const context = new OfflineAudioContext(1, 1, 8000)
  const buffer = await context.decodeAudioData(bytes)
  signal.throwIfAborted()
  const waveform = await audioEnvelope(buffer, signal)
  cache.set(key, waveform)
  if (cache.size > 8) cache.delete(cache.keys().next().value!)
  return waveform
}

/** Retain peaks across every channel, including opposite-phase stereo material. */
export async function audioEnvelope(buffer: Pick<AudioBuffer, 'duration' | 'length' | 'numberOfChannels' | 'getChannelData'>, signal: AbortSignal): Promise<AudioWaveform> {
  const count = Math.min(buffer.length, 60_000, Math.max(1000, Math.ceil(buffer.duration * 160)))
  const peaks = new Float32Array(count)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor(bin * buffer.length / count)
    const end = Math.floor((bin + 1) * buffer.length / count)
    let peak = 0
    for (const samples of channels) {
      for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(samples[index]))
    }
    peaks[bin] = peak
    if (bin % 1024 === 0) {
      signal.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  signal.throwIfAborted()
  let maximum = .02
  for (const peak of peaks) maximum = Math.max(maximum, peak)
  for (let bin = 0; bin < count; bin++) peaks[bin] /= maximum
  return { duration: buffer.duration, peaks }
}

export function audioTime(seconds: number, precise = false): string {
  const ticks = Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) * 100))
  const minutes = Math.floor(ticks / 6000)
  const whole = `${String(minutes).padStart(precise ? 2 : 1, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}`
  return precise ? `${whole}.${String(ticks % 100).padStart(2, '0')}` : whole
}

/** SVG bars pooled over each visible time interval; blank time stays blank. */
export function waveformPath(waveform: AudioWaveform | null, start: number, span: number, bars = 240): string {
  if (!waveform || span <= 0 || waveform.duration <= 0) return ''
  const { peaks, duration } = waveform
  const path: string[] = []
  for (let bar = 0; bar < bars; bar++) {
    const time = start + bar * span / bars
    const end = start + (bar + 1) * span / bars
    if (end <= 0 || time >= duration) continue
    const first = Math.max(0, Math.floor(time * peaks.length / duration))
    const last = Math.min(peaks.length, Math.max(first + 1, Math.ceil(end * peaks.length / duration)))
    let peak = 0
    for (let index = first; index < last; index++) peak = Math.max(peak, peaks[index])
    const height = Math.max(.6, peak * 83)
    path.push(`M${((bar + .5) * 1000 / bars).toFixed(2)} ${(100 - height).toFixed(2)}v${(height * 2).toFixed(2)}`)
  }
  return path.join('')
}
