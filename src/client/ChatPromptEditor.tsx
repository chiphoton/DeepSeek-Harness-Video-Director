import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { CHAT_ALIAS_MIME, type ChatAttachment } from './chat-attachments'
import { skillMentions } from './chat-skills'

export interface ChatPromptEditorHandle { insert(alias: string): void; replace(start: number, end: number, text: string): void; focus(): void }
export interface ChatPromptEditorProps {
  value: string
  attachments: ChatAttachment[]
  placeholder: string
  onChange(value: string): void
  onPreview(item: ChatAttachment): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onFiles(files: File[]): void
  onCaretChange?(offset: number | null, afterSkill?: boolean): void
  editingSkillStart?: number
  suggestionsId?: string
  activeSuggestionId?: string
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

function offsetBefore(root: HTMLElement, node: Node): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEndBefore(node)
  return content(range.cloneContents()).length
}

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

/** Plain text storage with inline boxes for attachment and skill references. */
export const ChatPromptEditor = forwardRef<ChatPromptEditorHandle, ChatPromptEditorProps>(function ChatPromptEditor(props, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null)
  const savedCaret = useRef<number | null>(null)
  const savedSelection = useRef<{ start: number; end: number } | null>(null)
  const [compositionVersion, setCompositionVersion] = useState(0)
  const composing = useRef(false)
  const dragged = useRef<{ alias: string; offset: number } | null>(null)
  const replace = (start: number, end: number, text: string): void => {
    ref.current!.focus()
    savedCaret.current = start + text.length
    savedSelection.current = { start: savedCaret.current, end: savedCaret.current }
    props.onChange(props.value.slice(0, start) + text + props.value.slice(end))
    props.onCaretChange?.(savedCaret.current)
  }
  const insert = (text: string): void => {
    const selected = selectionOffsets(ref.current!) ?? savedSelection.current ?? { start: props.value.length, end: props.value.length }
    replace(selected.start, selected.end, text)
  }
  useImperativeHandle(forwardedRef, () => ({ insert, replace, focus: () => ref.current?.focus() }))
  useLayoutEffect(() => {
    const root = ref.current!
    if (composing.current) return
    const at = savedCaret.current ?? caret(root)
    const aliases = new Map(props.attachments.map(item => [item.alias, item]))
    const tokens: { start: number; end: number; attachment?: ChatAttachment }[] = skillMentions(props.value)
      .filter(mention => mention.start !== props.editingSkillStart)
    for (const match of props.value.matchAll(/<(?:Image|Audio|Video|Folder|Node) [1-9]\d*>/g)) {
      const attachment = aliases.get(match[0])
      if (attachment) tokens.push({ start: match.index, end: match.index + match[0].length, attachment })
    }
    tokens.sort((a, b) => a.start - b.start)
    const tokenized = [...root.querySelectorAll<HTMLElement>('[data-alias], [data-skill-mention]')]
    if (content(root) === props.value && tokenized.length === tokens.length && tokens.every(({ start, end, attachment }, index) => {
      const token = tokenized[index]!
      return (attachment ? token.dataset.attachmentId === attachment.id : token.hasAttribute('data-skill-mention'))
        && token.textContent === props.value.slice(start, end) && offsetBefore(root, token) === start
    })) { savedCaret.current = null; return }
    const parts: (string | HTMLElement)[] = []
    let from = 0
    for (const { start, end, attachment } of tokens) {
      if (start > from) parts.push(props.value.slice(from, start))
      const text = props.value.slice(start, end)
      const token = document.createElement('span')
      token.contentEditable = 'false'
      token.textContent = text
      if (attachment) {
        token.className = 'vd-chat-alias'; token.draggable = true
        token.dataset.alias = text; token.dataset.attachmentId = attachment.id; token.tabIndex = 0
        token.setAttribute('role', 'button'); token.title = attachment.name
      } else {
        token.className = 'vd-chat-skill-mention'
        token.dataset.skillMention = text
      }
      parts.push(token)
      from = end
    }
    if (from < props.value.length) parts.push(props.value.slice(from))
    root.replaceChildren(...parts)
    if (at !== null && document.activeElement === root) positionCaret(root, Math.min(at, props.value.length))
    savedCaret.current = null
  }, [props.value, props.attachments, props.editingSkillStart, compositionVersion])
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
  const reportCaret = (): void => {
    const root = ref.current!
    savedSelection.current = selectionOffsets(root)
    const end = composing.current ? null : savedSelection.current?.end ?? null
    const afterSkill = end !== null && [...root.querySelectorAll<HTMLElement>('[data-skill-mention]')].some(token => (
      offsetBefore(root, token) + content(token).length === end
    ))
    props.onCaretChange?.(end, afterSkill)
  }
  return <div ref={ref} className="vd-chat-prompt" role="textbox" aria-label={props.placeholder} aria-multiline="true"
    aria-autocomplete="list" aria-controls={props.suggestionsId} aria-activedescendant={props.activeSuggestionId}
    contentEditable suppressContentEditableWarning data-placeholder={props.placeholder}
    onInput={() => { savedCaret.current = caret(ref.current!); props.onChange(content(ref.current!)); reportCaret() }}
    onBlur={() => { savedSelection.current = selectionOffsets(ref.current!) ?? savedSelection.current }}
    onKeyUp={reportCaret} onMouseUp={reportCaret} onFocus={reportCaret}
    onCompositionStart={() => { composing.current = true; props.onCaretChange?.(null) }} onCompositionEnd={() => { composing.current = false; props.onChange(content(ref.current!)); setCompositionVersion(value => value + 1); reportCaret() }}
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
      dragged.current = { alias: target.dataset.alias, offset: offsetBefore(ref.current!, target) }
      event.dataTransfer.setData(CHAT_ALIAS_MIME, target.dataset.alias); event.dataTransfer.setData('text/plain', target.dataset.alias)
      event.dataTransfer.effectAllowed = 'copyMove'
    }} onDragEnd={() => { dragged.current = null }} onDragOver={event => { if (event.dataTransfer.types.includes(CHAT_ALIAS_MIME)) event.preventDefault() }} onDrop={drop} />
})
