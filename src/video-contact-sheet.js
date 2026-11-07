import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { promisify } from 'node:util'
import { DirectorInputError, record, uuid } from './validation.js'
import { readVideoProperties } from './video-properties.js'

const runFile = promisify(execFile)

/** Sample one owned video into a bounded, chronological image for visual review. */
export async function videoContactSheet(store, input, signal, registerAsset) {
  const projectId = uuid(input.projectId, 'projectId')
  const source = store.asset(uuid(input.assetId, 'assetId'))
  if (source.projectId !== projectId || source.kind !== 'video') throw new DirectorInputError('Choose a video owned by this workflow.')
  const { frameCount = 6, columns = Math.min(3, frameCount) } = record(input.options ?? {}, 'contact sheet options')
  if (!Number.isSafeInteger(frameCount) || frameCount < 2 || frameCount > 9 || !Number.isSafeInteger(columns) || columns < 1 || columns > Math.min(3, frameCount)) {
    throw new DirectorInputError('Choose 2–9 frames and 1–3 columns, with no more columns than frames.')
  }
  const path = join(store.assetsDir, source.filename)
  const { duration } = await readVideoProperties(path, source.mimeType, { signal })
  if (duration === undefined || duration <= 0 || duration > 86400) throw new DirectorInputError('The video must have a known duration of up to 24 hours.')
  // Midpoints avoid container padding at the end and represent each time interval evenly.
  const times = Array.from({ length: frameCount }, (_, i) => duration * (i + .5) / frameCount)
  const rows = Math.ceil(frameCount / columns)
  const directory = await mkdtemp(join(tmpdir(), 'vd-contact-sheet-'))
  const output = join(directory, 'contact-sheet.png')
  const run = args => runFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file,pipe', '-filter_threads', '1', ...args], { signal, timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true })
  try {
    for (const [index, time] of times.entries()) {
      await run(['-ss', time.toFixed(6), '-i', path, '-map', '0:v:0', '-frames:v', '1',
        '-vf', 'scale=384:256:force_original_aspect_ratio=decrease,pad=384:256:(ow-iw)/2:(oh-ih)/2:color=0x12161f,setsar=1,format=rgb24',
        '-threads', '1', join(directory, `frame-${index}.png`)])
    }
    await run(['-framerate', '1', '-start_number', '0', '-i', join(directory, 'frame-%d.png'), '-frames:v', '1',
      '-vf', `tile=${columns}x${rows}:nb_frames=${frameCount}:margin=8:padding=8:color=0x12161f`, '-threads', '1', output])
    const asset = await store.putAsset({ projectId, kind: 'image', origin: 'output',
      name: `${parse(source.name).name.slice(0, 220)}-frames.png`, mimeType: 'image/png', dataBase64: (await readFile(output)).toString('base64') })
    await registerAsset(asset)
    return { asset, frameCount, columns, rows, times: times.map(time => Math.round(time * 1000) / 1000) }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error.code === 'ENOENT' && error.path === 'ffmpeg') throw new Error('Video frame sampling requires ffmpeg on the DSH host.')
    throw new Error('Could not sample this video. Check that the video stream is decodable and spans the clip duration.')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
