import type { BatchCase } from './types'

const encoder = new TextEncoder()
const safeName = (value: string): string => value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '').slice(0, 48) || 'output'

/** USTAR archive of immutable outputs plus their manifest, with no external library. */
export async function batchArchive(rows: BatchCase[], outputNodeId: string, signal?: AbortSignal): Promise<Blob> {
  if (!rows.length) throw new Error('Choose at least one case to save.')
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  let total = 0
  const manifest = rows.map(row => ({ ...row, artifacts: row.artifacts.filter(artifact => artifact.outputNodeId === outputNodeId).map(artifact => ({ ...artifact, exportPath: '' })) }))
  for (const row of manifest) {
    for (const [index, artifact] of row.artifacts.entries()) {
      signal?.throwIfAborted()
      let bytes: Uint8Array
      if (artifact.asset) {
        const response = await fetch(artifact.asset.url, { credentials: 'same-origin', signal })
        if (!response.ok) throw new Error(`Could not download ${artifact.asset.name} (${response.status}).`)
        if (total + artifact.asset.size > 512 * 1024 * 1024) throw new Error('This archive exceeds 512 MiB. Save fewer cases at a time.')
        bytes = new Uint8Array(await response.arrayBuffer())
      } else bytes = encoder.encode(artifact.text ?? '')
      total += bytes.length
      if (total > 512 * 1024 * 1024) throw new Error('This archive exceeds 512 MiB. Save fewer cases at a time.')
      const extension = artifact.asset?.name.split('.').at(-1)?.replace(/[^a-z0-9]/giu, '').slice(0, 10) || 'txt'
      // ASCII path components keep USTAR's byte-sized fields portable.
      const ascii = (value: string): string => safeName(value).replace(/[^\x20-\x7e]/gu, '_').slice(0, 24)
      artifact.exportPath = `${row.batchRunId}/${String(row.caseIndex).padStart(4, '0')}_${ascii(row.input.name)}/${ascii(artifact.sourceNodeId)}_${ascii(artifact.sourcePortId)}_${index + 1}.${extension}`
      files.push({ path: artifact.exportPath, bytes })
    }
  }
  files.push({ path: `${rows[0].batchRunId}/manifest.json`, bytes: encoder.encode(JSON.stringify({ version: 1, cases: manifest }, null, 2)) })
  return tarFiles(files)
}

export function tarFiles(files: Array<{ path: string; bytes: Uint8Array }>): Blob {
  const parts: BlobPart[] = []
  for (const file of files) {
    const header = new Uint8Array(512)
    const put = (offset: number, text: string): void => { header.set(encoder.encode(text), offset) }
    const slash = file.path.lastIndexOf('/')
    const name = file.path.slice(slash + 1); const prefix = slash < 0 ? '' : file.path.slice(0, slash)
    if (encoder.encode(name).length > 100 || encoder.encode(prefix).length > 155) throw new Error('Export filename is too long.')
    put(0, name); put(100, '0000644\0'); put(108, '0000000\0'); put(116, '0000000\0')
    put(124, file.bytes.length.toString(8).padStart(11, '0') + '\0'); put(136, '00000000000\0')
    put(148, '        '); put(156, '0'); put(257, 'ustar\0'); put(263, '00'); put(345, prefix)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    put(148, checksum.toString(8).padStart(6, '0') + '\0 ')
    parts.push(header, new Uint8Array(file.bytes), new Uint8Array((512 - file.bytes.length % 512) % 512))
  }
  parts.push(new Uint8Array(1024))
  return new Blob(parts, { type: 'application/x-tar' })
}

export function downloadBatchArchive(blob: Blob, batchRunId: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `batch-${batchRunId}.tar`
  document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
