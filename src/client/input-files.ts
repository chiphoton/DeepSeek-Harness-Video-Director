import type { DirectorNodeData, MediaKind } from './types'

export type InputFileKind = 'text' | 'image' | 'audio' | 'video'

export const INPUT_FILE_ACCEPTS: Record<InputFileKind, string> = {
  text: 'text/*,.txt,.md,.markdown,.csv,.json,.srt,.vtt,.log',
  image: 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif',
  audio: 'audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/flac,audio/mp4,audio/webm,.mp3,.wav,.ogg,.flac,.m4a',
  video: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v',
}

export function inputFileKind(kind: DirectorNodeData['kind']): InputFileKind | undefined {
  const kinds: Partial<Record<DirectorNodeData['kind'], InputFileKind>> = {
    'load-text': 'text', 'load-image': 'image', 'load-audio': 'audio', 'load-video': 'video',
  }
  return kinds[kind]
}

export function isTextFile(file: File): boolean {
  return file.type.startsWith('text/') || /\.(txt|md|markdown|csv|json|srt|vtt|log)$/iu.test(file.name)
}

export function acceptsInputFile(file: File, kind?: InputFileKind): boolean {
  if (kind === 'text') return isTextFile(file)
  if (kind === undefined && isTextFile(file)) return true
  try {
    const media = fileKind(file)
    return (kind === undefined || kind === media)
      && INPUT_FILE_ACCEPTS[media].split(',').includes(inferredMimeType(file, media))
  } catch { return false }
}

export function fileKind(file: File): 'image' | 'audio' | 'video' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension ?? '')) return 'image'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(extension ?? '')) return 'audio'
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension ?? '')) return 'video'
  throw new Error(`Unsupported media type: ${file.type || file.name}`)
}

export function inferredMimeType(file: File, kind: Exclude<MediaKind, 'text' | 'mask' | 'flow'>): string {
  if (file.type !== '' && file.type !== 'application/octet-stream') return file.type
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  const byExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: kind === 'audio' ? 'audio/webm' : 'video/webm', mov: 'video/quicktime',
  }
  if (kind === 'sketch') return 'image/png'
  const inferred = extension === undefined ? undefined : byExtension[extension]
  if (inferred === undefined || !inferred.startsWith(`${kind}/`)) {
    throw new Error(`Cannot infer a supported ${kind} MIME type from ${file.name}`)
  }
  return inferred
}
