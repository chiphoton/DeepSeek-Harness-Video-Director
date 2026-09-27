import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { DirectorInputError, finiteNumber, oneOf, record, uuid } from './validation.js'
import { readVideoProperties } from './video-properties.js'

const runFile = promisify(execFile)

/** Render into a temporary file. Export never imports an asset or changes a source. */
export async function editMedia(store, input, signal, registerAsset, execFileImpl = runFile) {
  const source = store.asset(uuid(input.assetId, 'assetId'))
  if (source.projectId !== uuid(input.projectId, 'projectId') || !['audio', 'video'].includes(source.kind)) {
    throw new DirectorInputError('Choose audio or video owned by this workflow.')
  }
  const action = oneOf(input.action, 'action', ['export', 'save', 'copy', 'frame'])
  const edit = record(input.edit ?? {}, 'edit')
  const properties = await readVideoProperties(join(store.assetsDir, source.filename), source.mimeType, { signal, execFileImpl })
  const duration = properties.duration
  if (!(duration > 0)) throw new DirectorInputError('The media duration could not be read.')
  const start = finiteNumber(edit.start ?? 0, 'Start time', { min: 0, max: duration })
  const end = finiteNumber(edit.end ?? duration, 'End time', { min: 0, max: duration + .001 })
  if (end - start < .01) throw new DirectorInputError('Select at least 0.01 seconds to keep.')
  const frame = action === 'frame'
  if (frame && source.kind !== 'video') throw new DirectorInputError('Frame extraction requires a video.')
  const time = frame ? finiteNumber(edit.time ?? start, 'Frame time', { min: 0, max: duration }) : start
  if (time >= duration) throw new DirectorInputError('Choose a frame before the end of the video.')
  const filters = []
  if (edit.crop !== undefined) {
    if (source.kind !== 'video') throw new DirectorInputError('Crop is available for video only.')
    const crop = record(edit.crop, 'crop')
    const values = ['x', 'y', 'width', 'height'].map(key => finiteNumber(crop[key], `Crop ${key}`, { min: 0, max: 65536 }))
    const [x, y, width, height] = values
    if (!values.every(Number.isSafeInteger) || width < 2 || height < 2 || width % 2 || height % 2
      || x + width > properties.width || y + height > properties.height) {
      throw new DirectorInputError('Use positive, even crop dimensions within the video bounds.')
    }
    filters.push(`crop=${width}:${height}:${x}:${y}:exact=1`)
  }
  const audio = source.kind === 'audio'
  const wav = audio && ['audio/wav', 'audio/x-wav'].includes(source.mimeType)
  const extension = frame ? 'png' : audio ? wav ? 'wav' : 'flac' : 'mp4'
  const mimeType = frame ? 'image/png' : audio ? wav ? 'audio/wav' : 'audio/flac' : 'video/mp4'
  const name = `${parse(source.name).name.slice(0, 220)}${frame ? '-frame' : action === 'copy' ? '-copy' : ''}.${extension}`
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
    '-ss', String(time), '-i', join(store.assetsDir, source.filename), '-map_metadata', '0']
  if (audio) args.push('-map', '0:a:0', '-vn', '-c:a', wav ? 'pcm_s24le' : 'flac')
  else {
    args.push('-map', '0:v:0')
    if (frame) args.push('-frames:v', '1')
    else {
      args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
      filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2')
    }
    if (filters.length) args.push('-vf', filters.join(','))
  }
  if (!frame) args.push('-t', String(Math.min(end, duration) - start))
  const directory = await mkdtemp(join(tmpdir(), 'vd-media-editor-'))
  try {
    signal?.throwIfAborted()
    const output = join(directory, `output.${extension}`)
    await execFileImpl('ffmpeg', [...args, output], { signal, maxBuffer: 1024 * 1024, windowsHide: true })
    const info = await stat(output)
    if (!info.size || info.size > store.maxAssetBytes) throw new DirectorInputError('The edited media exceeds the configured asset size limit or contains no media.')
    const dataBase64 = (await readFile(output)).toString('base64')
    signal?.throwIfAborted()
    if (action === 'export' || frame) return { name, mimeType, dataBase64 }
    const asset = await store.putAsset({ projectId: source.projectId, origin: 'output', kind: source.kind, name, mimeType, dataBase64 })
    await registerAsset(asset)
    return { asset }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Media editing requires ffmpeg on the DSH host.')
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
