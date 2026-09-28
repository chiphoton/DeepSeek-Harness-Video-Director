import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { CHAT_ALIAS_MIME, type ChatAttachment } from './chat-attachments'

export interface ChatPromptEditorHandle { insert(alias: string): void; focus(): void }
interface Props {
  value: string
  attachments: ChatAttachment[]
  placeholder: string
  onChange(value: string): void
  onPreview(item: ChatAttachment): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onFiles(files: File[]): void
}

function content(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof HTMLElement && node.dataset.alias) return node.dataset.alias
  if (node.nodeName === 'BR') return '\n'
  return [...node.childNodes].map((child, i) => `${i && child.nodeName === 'DIV' ? '\n' : ''}${content(child)}`).join('')
}

function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const selected = selection.getRangeAt(0)
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null
  const prefix = selected.cloneRange()
  prefix.selectNodeContents(root); prefix.setEnd(selected.startContainer, selected.startOffset)
  const start = content(prefix.cloneContents()).length
  return { start, end: start + content(selected.cloneContents()).length }
}
function caret(root: HTMLElement): number | null { return selectionOffsets(root)?.end ?? null }

function positionCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange()
  for (const node of root.childNodes) {
    const length = content(node).length
    if (offset <= length) {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, offset)
      else if (offset === 0) range.setStartBefore(node)
      else range.setStartAfter(node)
      range.collapse(true); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
      return
    }
    offset -= length
  }
  range.selectNodeContents(root); range.collapse(false)
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
}

/** Plain text storage with atomic, editable-in-place attachment references. */
export const ChatPromptEditor = forwardRef<ChatPromptEditorHandle, Props>(function ChatPromptEditor(props, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null)
  const savedCaret = useRef<number | null>(null)
  const savedSelection = useRef<{ start: number; end: number } | null>(null)
  const [compositionVersion, setCompositionVersion] = useState(0)
  const composing = useRef(false)
  const dragged = useRef<{ alias: string; offset: number } | null>(null)
  const insert = (text: string): void => {
    const root = ref.current!
    const selected = selectionOffsets(root) ?? savedSelection.current ?? { start: props.value.length, end: props.value.length }
    root.focus()
    savedCaret.current = selected.start + text.length
    savedSelection.current = { start: savedCaret.current, end: savedCaret.current }
    props.onChange(props.value.slice(0, selected.start) + text + props.value.slice(selected.end))
  }
  useImperativeHandle(forwardedRef, () => ({ insert, focus: () => ref.current?.focus() }))
  useLayoutEffect(() => {
    const root = ref.current!
    if (composing.current) return
    const at = savedCaret.current ?? caret(root)
    const aliases = new Map(props.attachments.map(item => [item.alias, item]))
    const tokenized = [...root.querySelectorAll<HTMLElement>('[data-alias]')].map(node => node.dataset.alias)
    const wanted = (props.value.match(/<(?:Image|Audio|Video|Folder|Node) [1-9]\d*>/g) ?? []).filter(alias => aliases.has(alias))
    if (content(root) === props.value && tokenized.join('\0') === wanted.join('\0')) { savedCaret.current = null; return }
    const parts = props.value.split(/(<(?:Image|Audio|Video|Folder|Node) [1-9]\d*>)/g)
    root.replaceChildren(...parts.filter(Boolean).map(part => {
      const item = aliases.get(part)
      if (!item) return document.createTextNode(part)
      const token = document.createElement('span')
      token.className = 'vd-chat-alias'; token.contentEditable = 'false'; token.draggable = true
      token.dataset.alias = part; token.dataset.attachmentId = item.id; token.tabIndex = 0
      token.textContent = part; token.setAttribute('role', 'button'); token.title = item.name
      return token
    }))
    if (at !== null && document.activeElement === root) positionCaret(root, Math.min(at, props.value.length))
    savedCaret.current = null
  }, [props.value, props.attachments, compositionVersion])
  const clipboard = (event: ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    const selection = window.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', content(selection.getRangeAt(0).cloneContents()))
    if (cut) { selection.deleteFromDocument(); savedCaret.current = caret(ref.current!); props.onChange(content(ref.current!)) }
  }
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    const alias = event.dataTransfer.getData(CHAT_ALIAS_MIME)
    if (!alias || !props.attachments.some(item => item.alias === alias)) return
    event.preventDefault(); event.stopPropagation()
    const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
    const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY)
    if (range && ref.current?.contains(range.startContainer)) { window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range) }
    const at = caret(ref.current!) ?? props.value.length
    ref.current?.focus()
    const source = dragged.current
    const text = source ? props.value.slice(0, source.offset) + props.value.slice(source.offset + alias.length) : props.value
    const target = source && at > source.offset ? Math.max(source.offset, at - alias.length) : at
    savedCaret.current = target + alias.length
    props.onChange(text.slice(0, target) + alias + text.slice(target))
    dragged.current = null
  }
  return <div ref={ref} className="vd-chat-prompt" role="textbox" aria-label={props.placeholder} aria-multiline="true"
    contentEditable suppressContentEditableWarning data-placeholder={props.placeholder}
    onInput={() => { savedCaret.current = caret(ref.current!); props.onChange(content(ref.current!)) }}
    onBlur={() => { savedSelection.current = selectionOffsets(ref.current!) ?? savedSelection.current }}
    onKeyUp={() => { savedSelection.current = selectionOffsets(ref.current!) }}
    onMouseUp={() => { savedSelection.current = selectionOffsets(ref.current!) }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; props.onChange(content(ref.current!)); setCompositionVersion(value => value + 1) }}
    onClick={event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-attachment-id]'); const item = props.attachments.find(item => item.id === target?.dataset.attachmentId); if (item) props.onPreview(item) }}
    onKeyDown={event => {
      const token = (event.target as HTMLElement).closest<HTMLElement>('[data-attachment-id]')
      if (token && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); const item = props.attachments.find(item => item.id === token.dataset.attachmentId); if (item) props.onPreview(item)
      } else props.onKeyDown(event)
    }}
    onCopy={event => clipboard(event, false)} onCut={event => clipboard(event, true)}
    onPaste={event => { event.preventDefault(); if (event.clipboardData.files.length) props.onFiles([...event.clipboardData.files]); else insert(event.clipboardData.getData('text/plain')) }}
    onDragStart={event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-alias]')
      if (!target?.dataset.alias) return
      const range = document.createRange(); range.selectNodeContents(ref.current!); range.setEndBefore(target)
      dragged.current = { alias: target.dataset.alias, offset: content(range.cloneContents()).length }
      event.dataTransfer.setData(CHAT_ALIAS_MIME, target.dataset.alias); event.dataTransfer.setData('text/plain', target.dataset.alias)
      event.dataTransfer.effectAllowed = 'copyMove'
    }} onDragEnd={() => { dragged.current = null }} onDragOver={event => { if (event.dataTransfer.types.includes(CHAT_ALIAS_MIME)) event.preventDefault() }} onDrop={drop} />
})
