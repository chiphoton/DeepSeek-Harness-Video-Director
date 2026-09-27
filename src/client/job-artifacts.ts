import type { PreviewArtifact } from './ArtifactPreview'

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name
  document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Uncompressed ZIP retains original UTF-8 filenames, including long provider names.
export function artifactZip(files: Array<{ name: string; bytes: Uint8Array }>): Blob {
  const parts: BlobPart[] = [], directory: BlobPart[] = []
  const encoder = new TextEncoder()
  let offset = 0, directorySize = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    let crc = 0xffffffff
    for (const byte of file.bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer)
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true)
    h.setUint32(14, crc, true); h.setUint32(18, file.bytes.length, true); h.setUint32(22, file.bytes.length, true)
    h.setUint16(26, name.length, true); header.set(name, 30)
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer)
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true)
    c.setUint32(16, crc, true); c.setUint32(20, file.bytes.length, true); c.setUint32(24, file.bytes.length, true)
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46)
    parts.push(header, new Uint8Array(file.bytes)); directory.push(central)
    offset += header.length + file.bytes.length; directorySize += central.length
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true)
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true)
  return new Blob([...parts, ...directory, end], { type: 'application/zip' })
}

export async function downloadJobArtifacts(artifacts: PreviewArtifact[], name: string): Promise<void> {
  const files = []
  let total = 0
  for (const [index, artifact] of artifacts.entries()) {
    const size = artifact.asset?.size ?? new TextEncoder().encode(artifact.text ?? '').length
    if (total + size > 512 * 1024 * 1024) throw new Error('This download exceeds 512 MiB. Download individual artifacts from their previews.')
    const response = artifact.asset ? await fetch(artifact.asset.url, { credentials: 'same-origin' }) : null
    if (response && !response.ok) throw new Error(`Could not download ${artifact.name} (${response.status}).`)
    const bytes = response ? new Uint8Array(await response.arrayBuffer()) : new TextEncoder().encode(artifact.text ?? '')
    total += bytes.length
    if (total > 512 * 1024 * 1024) throw new Error('This download exceeds 512 MiB. Download individual artifacts from their previews.')
    const filename = (artifact.asset?.name ?? `${artifact.name}.txt`).replace(/[\/\\\u0000-\u001f]/gu, '_')
    files.push({ name: artifacts.length === 1 ? filename : `${String(index + 1).padStart(2, '0')}/${filename}`, bytes })
  }
  if (files.length === 1) downloadBlob(new Blob([files[0].bytes]), files[0].name)
  else if (files.length) downloadBlob(artifactZip(files), `${name.replace(/[\/\\]/gu, '_')}-artifacts.zip`)
}
