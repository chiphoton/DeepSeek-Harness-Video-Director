import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArtifactPreviewDialog } from './ArtifactPreview'
import { chatAttachmentPreview, type ChatAttachment } from './chat-attachments'
import type { DirectorNode } from './types'
import { CloseIcon } from './icons'
import { t } from './i18n'

export function ChatAttachmentPreview({ item, nodes, onClose }: { item: ChatAttachment; nodes: DirectorNode[]; onClose(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialogRef.current?.focus(); return () => previous?.focus() }, [])
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [limit, setLimit] = useState(100)
  const files = useMemo(() => item.manifest ?? (item.files ?? []).map(file => ({ name: file.name, path: file.webkitRelativePath || file.name, mimeType: file.type, size: file.size })), [item.manifest, item.files])
  const rows = useMemo(() => files.filter(file => (!query || file.path.toLowerCase().includes(query.toLowerCase()))
    && (!kind || file.mimeType.startsWith(`${kind}/`))).sort((a, b) => a.path.localeCompare(b.path)), [files, query, kind])
  const tree = useMemo(() => {
    const result: Array<{ path: string; depth: number; folder: boolean; name: string; size?: number }> = []
    const seen = new Set<string>()
    for (const file of rows) {
      const parts = file.path.split('/')
      let hidden = false
      for (let depth = 0; depth < parts.length - 1; depth++) {
        const path = parts.slice(0, depth + 1).join('/')
        if (!seen.has(path)) { seen.add(path); result.push({ path, depth, folder: true, name: parts[depth] }) }
        if (!query && closedFolders.has(path)) { hidden = true; break }
      }
      if (!hidden) result.push({ path: file.path, depth: parts.length - 1, folder: false, name: file.name, size: file.size })
    }
    return result
  }, [rows, closedFolders, query])
  const preview = chatAttachmentPreview(item)
  if (preview) return <ArtifactPreviewDialog artifact={preview} onClose={onClose} />
  const node = nodes.find(node => node.id === item.nodeId)
  return createPortal(<div className="vd-chat-reference-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="vd-chat-reference-dialog" role="dialog" aria-modal="true" aria-label={`${t('Preview')} ${item.alias}`} tabIndex={-1}
      ref={dialogRef} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header><div><strong>{item.alias}</strong><small>{item.name}</small></div><button className="vd-close-icon-button" aria-label={t('Close preview')} onClick={onClose}><CloseIcon /></button></header>
      {item.kind === 'folder' ? <>
        <p>{t('{0} files · {1} bytes', String(files.length), String(files.reduce((sum, file) => sum + file.size, 0)))}</p>
        <div className="vd-chat-folder-filter"><input aria-label={t('Search files')} placeholder={t('Search files')} value={query} onChange={event => { setQuery(event.target.value); setLimit(100) }} />
          <select aria-label={t('File type')} value={kind} onChange={event => { setKind(event.target.value); setLimit(100) }}>
            <option value="">{t('All files')}</option>{['image', 'audio', 'video', 'text'].map(kind => <option key={kind} value={kind}>{t(kind[0].toUpperCase() + kind.slice(1))}</option>)}
          </select></div>
        <ul className="vd-chat-folder-tree" aria-label={t('Folder files')}> {tree.slice(0, limit).map(row => <li key={`${row.folder}:${row.path}`} style={{ paddingLeft: Math.min(8, row.depth) * 14 }}>
          {row.folder ? <button aria-expanded={!closedFolders.has(row.path)} onClick={() => setClosedFolders(current => { const next = new Set(current); next.has(row.path) ? next.delete(row.path) : next.add(row.path); return next })}>{closedFolders.has(row.path) ? '▸' : '▾'} {row.name}</button>
            : <><span title={row.path}>{row.name}</span><small>{row.size?.toLocaleString()} B</small></>}
        </li>)}</ul>
        {tree.length > limit ? <button className="vd-secondary" onClick={() => setLimit(limit + 100)}>{t('Load more files')}</button> : null}
        {!rows.length ? <p>{t('No matching files')}</p> : null}
      </> : node ? <><dl><dt>{t('Node')}</dt><dd>{node.data.title}</dd><dt>{t('Type')}</dt><dd>{node.data.kind}</dd><dt>{t('Status')}</dt><dd>{node.data.status}</dd><dt>ID</dt><dd>{node.id}</dd></dl>
        <pre>{JSON.stringify(node.data, null, 2)}</pre></> : <p>{t('This node is no longer on the canvas.')}</p>}
    </section>
  </div>, document.body)
}
