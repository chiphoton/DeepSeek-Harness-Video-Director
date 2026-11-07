import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { ChatPromptEditor, type ChatPromptEditorHandle, type ChatPromptEditorProps } from './ChatPromptEditor'
import { skillAtCaret, type ChatSkill } from './chat-skills'
import type { DirectorController } from './controller'
import { t } from './i18n'

type Props = ChatPromptEditorProps & {
  director: DirectorController
  projectId: string
  sessionId: string | null
  refreshKey: number | string
  disabled: boolean
  automaticSkills?: boolean
  onManage(): void
}

/** The composer only requests skill metadata; instructions load through vd_library. */
export const ChatSkillComposer = forwardRef<ChatPromptEditorHandle, Props>(function ChatSkillComposer(props, forwardedRef) {
  const editor = useRef<ChatPromptEditorHandle>(null)
  useImperativeHandle(forwardedRef, () => ({ insert: text => editor.current?.insert(text), replace: (start, end, text) => editor.current?.replace(start, end, text), focus: () => editor.current?.focus() }))
  const [caret, setCaret] = useState({ offset: null as number | null, afterSkill: false })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState<ChatSkill[]>([])
  const [results, setResults] = useState<{ query: string; items: ChatSkill[]; more: boolean } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const busyRef = useRef(false)
  const current = useRef(props)
  current.current = props
  const listId = useId()
  const token = caret.afterSkill ? null : skillAtCaret(props.value, caret.offset)
  const tokenKey = token ? `${token.start}:${token.end}:${token.query}` : ''
  const query = token && tokenKey !== dismissed ? token.query : null
  const items = results?.query === query ? results.items : []
  const activeIndex = Math.min(highlight, Math.max(0, items.length - 1))
  useEffect(() => { if (query !== null) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, query, results, listId])
  useEffect(() => { setDismissed(null) }, [props.value])
  useEffect(() => {
    let live = true
    void props.director.workspace<{ items: ChatSkill[] }>('library', 'active').then(result => { if (live) setActive(result.items) }).catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [props.director, props.projectId, props.sessionId, props.refreshKey, revision])
  useEffect(() => {
    setHighlight(0)
    if (query === null) return
    let live = true
    void props.director.workspace<{ items: ChatSkill[]; nextOffset: number | null }>('library', 'list', { query, limit: 8 }).then(result => {
      if (live) setResults({ query, items: result.items, more: result.nextOffset !== null })
    }).catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [props.director, props.projectId, props.sessionId, props.refreshKey, query])
  const choose = async (skill: ChatSkill): Promise<void> => {
    if (!token || busyRef.current || props.disabled) return
    busyRef.current = true; setBusy(true); setError('')
    const value = props.value
    try {
      const pinned = active.find(item => item.id === skill.id) ?? skill
      await props.director.workspace('library', 'bind', { id: pinned.id, revision: pinned.revision })
      if (current.current.projectId !== props.projectId || current.current.sessionId !== props.sessionId) return
      if (current.current.value === value) editor.current?.replace(token.start, token.end, `$${pinned.name} `)
      setDismissed(tokenKey); setRevision(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const dismiss = (): void => setDismissed(tokenKey)
  return <div className="vd-chat-skill-composer"
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setCaret({ offset: null, afterSkill: false })
    }}
    onKeyDown={event => {
      if (query !== null && event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); dismiss(); editor.current?.focus()
      }
    }}>
    <ChatPromptEditor {...props} ref={editor} editingSkillStart={token?.start}
      onCaretChange={(offset, afterSkill = false) => setCaret(previous => (
        previous.offset === offset && previous.afterSkill === afterSkill ? previous : { offset, afterSkill }
      ))}
      suggestionsId={query !== null ? listId : undefined}
      activeSuggestionId={items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      onKeyDown={event => {
        if (query !== null && !event.nativeEvent.isComposing) {
          if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault(); setHighlight((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length); return
          }
          if (items.length && event.key === 'Enter' && !event.shiftKey && !event.altKey) {
            event.preventDefault(); void choose(items[activeIndex]!); return
          }
        }
        props.onKeyDown(event)
      }} />
    {query !== null && <div className="vd-chat-skill-picker">
      <header><strong>{t('Skills')}</strong><span>{t('↑ ↓ to browse · Enter to select')}</span></header>
      <div id={listId} role="listbox" aria-label={t('Choose a skill')}>
        {items.map((skill, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === activeIndex}
          key={skill.id} tabIndex={-1} disabled={busy || props.disabled} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => { void choose(skill) }}>
          <span><strong>${skill.name}</strong><small>{skill.description}</small></span><small className="vd-chat-skill-version">v{active.find(item => item.id === skill.id)?.revision ?? skill.revision}</small>
        </button>)}
      </div>
      {!items.length && <p role="status">{results?.query !== query ? t('Loading skills…') : t('No matching skills')}</p>}
      {results?.query === query && results.more && <p>{t('Keep typing to narrow the list.')}</p>}
      <footer><button type="button" className="vd-chat-skills-manage" onClick={() => { dismiss(); props.onManage() }}>
        {t('Manage skills')}<span aria-hidden>›</span>
      </button></footer>
    </div>}
    <div className="vd-chat-skill-row" aria-label={t('Chat skills')}>
      <button type="button" className="vd-chat-skills-trigger" disabled={props.disabled || busy} title={t('Type $ to choose a skill')}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          setDismissed(null)
          const prefix = props.value.slice(0, caret.offset ?? props.value.length)
          editor.current?.insert(prefix && !/[\s([{]$/.test(prefix) ? ' $' : '$')
        }}><span aria-hidden>$</span> {t('Skills')}</button>
      {props.automaticSkills && <span className="vd-chat-skills-auto" title={t('Built-in skills can be chosen from your request')}>{t('Auto skills')}</span>}
    </div>
    {error && <p className="vd-chat-attachment-error" role="alert">{error}</p>}
  </div>
})
