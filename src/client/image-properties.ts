export interface ImageMetadataEntry {
  name: string
  value: string
}

export interface ImageProperties {
  format: string
  width?: number
  height?: number
  bitDepth?: string
  metadata: ImageMetadataEntry[]
}

function bytesFrom(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)))
}

function cleanText(value: string): string {
  return value.replaceAll('\0', '').replaceAll(/[\u0001-\u001f\u007f]/g, ' ').trim().slice(0, 2_000)
}

function formatFromMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toUpperCase()
  if (subtype === 'JPEG') return 'JPEG'
  if (subtype === 'SVG+XML') return 'SVG'
  return subtype || 'Unknown'
}

function pngProperties(bytes: Uint8Array): ImageProperties {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = bytes.length >= 24 ? view.getUint32(16, false) : undefined
  const height = bytes.length >= 24 ? view.getUint32(20, false) : undefined
  const sampleDepth = bytes[24]
  const colorType = bytes[25]
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  const bitDepth = sampleDepth === undefined
    ? undefined
    : colorType === 3
      ? `${String(sampleDepth)}-bit indexed`
      : channels === undefined
        ? `${String(sampleDepth)} bits/channel`
        : `${String(sampleDepth)} bits/channel · ${String(sampleDepth * channels)} bits/pixel`
  const metadata: ImageMetadataEntry[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = ascii(bytes, offset + 4, 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) break
    if (type === 'tEXt') {
      const raw = new TextDecoder('latin1').decode(bytes.subarray(dataStart, Math.min(dataEnd, dataStart + 65_536)))
      const separator = raw.indexOf('\0')
      if (separator > 0) metadata.push({ name: cleanText(raw.slice(0, separator)), value: cleanText(raw.slice(separator + 1)) })
    } else if (type === 'iTXt') {
      const raw = new TextDecoder().decode(bytes.subarray(dataStart, Math.min(dataEnd, dataStart + 65_536)))
      const parts = raw.split('\0')
      if (parts[0] !== '' && parts[4] !== undefined) {
        metadata.push({ name: cleanText(parts[0]), value: cleanText(parts.slice(4).join(' ')) })
      }
    } else if (type === 'pHYs' && length >= 9) {
      const x = view.getUint32(dataStart, false)
      const y = view.getUint32(dataStart + 4, false)
      metadata.push({ name: 'Pixel density', value: bytes[dataStart + 8] === 1 ? `${String(x)} × ${String(y)} px/m` : `${String(x)} × ${String(y)}` })
    } else if (type === 'eXIf') {
      metadata.push(...tiffMetadata(bytes, dataStart, dataEnd))
    }
    offset = dataEnd + 4
    if (type === 'IEND') break
  }
  return { format: 'PNG', width, height, bitDepth, metadata }
}

const EXIF_TAGS: Record<number, string> = {
  0x010e: 'Description',
  0x010f: 'Camera make',
  0x0110: 'Camera model',
  0x0131: 'Software',
  0x0132: 'Date/time',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x9003: 'Date taken',
  0x9004: 'Date digitized',
  0xa434: 'Lens model',
}

function tiffMetadata(bytes: Uint8Array, tiffStart: number, limit: number): ImageMetadataEntry[] {
  if (tiffStart + 8 > limit) return []
  const byteOrder = ascii(bytes, tiffStart, 2)
  const little = byteOrder === 'II'
  if (!little && byteOrder !== 'MM') return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (offset: number): number => view.getUint16(offset, little)
  const u32 = (offset: number): number => view.getUint32(offset, little)
  if (u16(tiffStart + 2) !== 42) return []
  const entries: ImageMetadataEntry[] = []
  const visited = new Set<number>()
  const parseIfd = (relativeOffset: number): void => {
    const start = tiffStart + relativeOffset
    if (visited.has(start) || start + 2 > limit) return
    visited.add(start)
    const count = Math.min(u16(start), 256)
    for (let index = 0; index < count; index += 1) {
      const entry = start + 2 + index * 12
      if (entry + 12 > limit) break
      const tag = u16(entry)
      const type = u16(entry + 2)
      const valueCount = u32(entry + 4)
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type]
      if (size === undefined || valueCount > 100_000) continue
      const byteLength = size * valueCount
      const valueStart = byteLength <= 4 ? entry + 8 : tiffStart + u32(entry + 8)
      if (valueStart < tiffStart || valueStart + byteLength > limit) continue
      if (tag === 0x8769 && (type === 3 || type === 4)) {
        parseIfd(type === 3 ? u16(valueStart) : u32(valueStart))
        continue
      }
      const name = EXIF_TAGS[tag]
      if (name === undefined) continue
      let value = ''
      if (type === 2) value = new TextDecoder('utf-8').decode(bytes.subarray(valueStart, valueStart + byteLength))
      else if (type === 3) value = Array.from({ length: Math.min(valueCount, 16) }, (_, item) => String(u16(valueStart + item * 2))).join(', ')
      else if (type === 4) value = Array.from({ length: Math.min(valueCount, 16) }, (_, item) => String(u32(valueStart + item * 4))).join(', ')
      value = cleanText(value)
      if (value !== '') entries.push({ name, value })
    }
  }
  const firstIfd = u32(tiffStart + 4)
  if (firstIfd > 0) parseIfd(firstIfd)
  return entries
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegProperties(bytes: Uint8Array): ImageProperties {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const metadata: ImageMetadataEntry[] = []
  let width: number | undefined
  let height: number | undefined
  let bitDepth: string | undefined
  let offset = 2
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = view.getUint16(offset, false)
    const dataStart = offset + 2
    const dataEnd = offset + length
    if (length < 2 || dataEnd > bytes.length) break
    if (JPEG_SOF_MARKERS.has(marker) && length >= 8) {
      const precision = bytes[dataStart]
      height = view.getUint16(dataStart + 1, false)
      width = view.getUint16(dataStart + 3, false)
      const components = bytes[dataStart + 5]
      bitDepth = `${String(precision)} bits/channel · ${String(precision * components)} bits/pixel`
    } else if (marker === 0xe1 && ascii(bytes, dataStart, 6) === 'Exif\0\0') {
      metadata.push(...tiffMetadata(bytes, dataStart + 6, dataEnd))
    } else if (marker === 0xe0 && ascii(bytes, dataStart, 5) === 'JFIF\0' && length >= 16) {
      const unit = bytes[dataStart + 7]
      const x = view.getUint16(dataStart + 8, false)
      const y = view.getUint16(dataStart + 10, false)
      metadata.push({ name: 'JFIF density', value: `${String(x)} × ${String(y)}${unit === 1 ? ' dpi' : unit === 2 ? ' dpcm' : ''}` })
    } else if (marker === 0xfe) {
      const comment = cleanText(new TextDecoder().decode(bytes.subarray(dataStart, dataEnd)))
      if (comment !== '') metadata.push({ name: 'Comment', value: comment })
    }
    offset = dataEnd
  }
  return { format: 'JPEG', width, height, bitDepth, metadata }
}

function gifProperties(bytes: Uint8Array): ImageProperties {
  if (bytes.length < 13) return { format: 'GIF', metadata: [] }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const packed = bytes[10]
  return {
    format: ascii(bytes, 0, 6),
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
    bitDepth: `${String(((packed >> 4) & 7) + 1)} bits/channel`,
    metadata: [],
  }
}

function webpProperties(bytes: Uint8Array): ImageProperties {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width: number | undefined
  let height: number | undefined
  const metadata: ImageMetadataEntry[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4)
    const length = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + length > bytes.length) break
    if (type === 'VP8X' && length >= 10) {
      width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16)
      height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16)
    } else if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
      const packed = view.getUint32(start + 1, true)
      width = (packed & 0x3fff) + 1
      height = ((packed >> 14) & 0x3fff) + 1
    } else if (type === 'EXIF') metadata.push(...tiffMetadata(bytes, start, start + length))
    else if (type === 'XMP ') metadata.push({ name: 'XMP', value: cleanText(new TextDecoder().decode(bytes.subarray(start, Math.min(start + length, start + 65_536)))) })
    offset = start + length + (length % 2)
  }
  return { format: 'WebP', width, height, bitDepth: '8 bits/channel', metadata }
}

export function parseImageProperties(input: ArrayBuffer | Uint8Array, mimeType = ''): ImageProperties {
  const bytes = bytesFrom(input)
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return pngProperties(bytes)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegProperties(bytes)
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return gifProperties(bytes)
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpProperties(bytes)
  return { format: formatFromMime(mimeType), metadata: [] }
}
