import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function frameRate(value) {
  if (typeof value !== 'string') return positiveNumber(value)
  const [numerator, denominator = '1'] = value.split('/')
  return positiveNumber(Number(numerator) / Number(denominator))
}

/** Keep container/stream tags, without exposing the host's file path. */
export function videoPropertiesFromProbe(probe, mimeType) {
  const streams = Array.isArray(probe.streams) ? probe.streams : []
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video) throw new Error('No video stream was found in this file.')
  const container = probe.format ?? {}
  const metadata = []
  const add = (name, value) => {
    if (value !== undefined && value !== null && value !== '' && value !== 'N/A') {
      metadata.push({ name, value: String(value) })
    }
  }
  const tags = (scope, values) => {
    for (const [name, value] of Object.entries(values ?? {})) add(`${scope} · ${name}`, value)
  }
  add('Container', container.format_long_name ?? container.format_name)
  add('Bit rate', positiveNumber(container.bit_rate) ? `${container.bit_rate} bit/s` : undefined)
  tags('Container', container.tags)
  for (const stream of streams) {
    const scope = `${stream.codec_type ?? 'Stream'} ${stream.index ?? streams.indexOf(stream)}`
    add(`${scope} · Codec`, stream.codec_long_name ?? stream.codec_name)
    for (const field of ['profile', 'pix_fmt', 'bits_per_raw_sample', 'color_range', 'color_space', 'color_transfer', 'color_primaries', 'sample_aspect_ratio', 'display_aspect_ratio', 'bit_rate', 'nb_frames', 'sample_rate', 'channels', 'channel_layout']) {
      add(`${scope} · ${field}`, stream[field])
    }
    tags(scope, stream.tags)
    for (const sideData of stream.side_data_list ?? []) {
      if (sideData.rotation !== undefined) add(`${scope} · Rotation`, `${sideData.rotation}°`)
    }
  }
  const formats = { 'video/mp4': 'MP4', 'video/quicktime': 'QuickTime / MOV', 'video/webm': 'WebM' }
  const format = container.format_name?.includes('matroska') ? 'WebM'
    : container.tags?.major_brand?.trim() === 'qt' ? 'QuickTime / MOV'
      : container.format_name?.includes('mov') ? 'MP4' : formats[mimeType] ?? container.format_name
  return {
    format,
    width: positiveNumber(video.width),
    height: positiveNumber(video.height),
    duration: positiveNumber(container.duration) ?? positiveNumber(video.duration),
    fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
    metadata,
  }
}

/** Probe only a resolved asset-store file, with bounded time and output. */
export async function readVideoProperties(filePath, mimeType, { signal, execFileImpl = runFile } = {}) {
  try {
    const { stdout } = await execFileImpl('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm',
      '-show_format', '-show_streams', '-of', 'json', filePath,
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true })
    return videoPropertiesFromProbe(JSON.parse(stdout), mimeType)
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error.code === 'ENOENT'
      ? 'Video metadata requires ffprobe (FFmpeg) on the DSH host.'
      : 'Could not read video metadata. The file may be damaged or unsupported.'
    throw Object.assign(new Error(message), { code: 'video-director/video-properties-unavailable' })
  }
}
