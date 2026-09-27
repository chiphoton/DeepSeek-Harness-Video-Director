import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { DirectorInputError } from './validation.js'
import { readVideoProperties } from './video-properties.js'

export const MEDIA_OPERATIONS = ['video-trim', 'video-crop', 'video-extract-frame']
const runFile = promisify(execFile)

function number(value, label, fallback, integer = false) {
  const result = value ?? fallback
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0 || result > 86400 || (integer && !Number.isSafeInteger(result))) {
    throw new DirectorInputError(`${label} must be a ${integer ? 'whole ' : ''}number between 0 and 86400`)
  }
  return result
}

/** Fixed operations and numeric arguments only; source paths come from the asset store. */
export async function runMediaOperation(store, input, signal, registerAsset, progress, execFileImpl = runFile) {
  const refs = (input.mediaInputs ?? []).filter(row => row.assetId)
  if (refs.length !== 1) throw new DirectorInputError('Connect exactly one video to this node.')
  const source = store.asset(refs[0].assetId)
  if (source.projectId !== input.projectId || source.kind !== 'video') throw new DirectorInputError('Choose a video owned by this workflow.')
  const options = input.mediaOptions ?? {}
  const properties = await readVideoProperties(join(store.assetsDir, source.filename), source.mimeType, { signal, execFileImpl })
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe']
  const frame = input.operation === 'video-extract-frame'
  const start = number(frame ? options.time : options.start, frame ? 'Frame time' : 'Start time', 0)
  if ((frame || input.operation === 'video-trim') && properties.duration !== undefined && start >= properties.duration) throw new DirectorInputError('Start time must be before the end of the video.')
  if (frame || input.operation === 'video-trim') args.push('-ss', String(start))
  args.push('-i', join(store.assetsDir, source.filename), '-map', '0:v:0')
  if (frame) args.push('-frames:v', '1')
  else {
    args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart')
    if (input.operation === 'video-trim') {
      const end = number(options.end, 'End time', properties.duration)
      if (end <= start || (properties.duration !== undefined && end > properties.duration + .05)) throw new DirectorInputError('End time must follow start time and remain within the video.')
      args.push('-t', String(end - start))
    } else if (input.operation === 'video-crop') {
      const x = number(options.x, 'Crop x', 0, true), y = number(options.y, 'Crop y', 0, true)
      const width = number(options.width, 'Crop width', properties.width, true)
      const height = number(options.height, 'Crop height', properties.height, true)
      if (!width || !height || width % 2 || height % 2 || x + width > properties.width || y + height > properties.height) throw new DirectorInputError('Use positive, even crop dimensions within the video bounds.')
      args.push('-vf', `crop=${width}:${height}:${x}:${y}`)
    } else throw new DirectorInputError('Unsupported media operation.')
    args.push('-pix_fmt', 'yuv420p')
  }
  const directory = await mkdtemp(join(tmpdir(), 'vd-ffmpeg-'))
  const output = join(directory, frame ? 'frame.png' : 'video.mp4')
  try {
    await progress({ phase: frame ? 'extracting-frame' : input.operation === 'video-trim' ? 'trimming' : 'cropping', progress: .1 })
    await execFileImpl('ffmpeg', [...args, output], { signal, maxBuffer: 1024 * 1024, windowsHide: true })
    const info = await stat(output)
    if (info.size > store.maxAssetBytes) throw new DirectorInputError('The processed video exceeds the configured asset size limit.')
    const asset = await store.putAsset({ projectId: input.projectId, origin: 'output', kind: frame ? 'image' : 'video',
      name: `${parse(source.name).name}-${input.operation.replace('video-', '')}.${frame ? 'png' : 'mp4'}`,
      mimeType: frame ? 'image/png' : 'video/mp4', dataBase64: (await readFile(output)).toString('base64') })
    await registerAsset(asset)
    return { kind: 'assets', assets: [asset], providerId: 'ffmpeg' }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Video processing requires ffmpeg on the DSH host.')
    throw error
  } finally { await rm(directory, { recursive: true, force: true }) }
}
