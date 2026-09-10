import { t, useLanguage } from './i18n'
import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'

export type CanvasInteractionMode = 'select' | 'hand'

export function isCanvasTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
}

/** Only a field/panel with scrollable content owns the wheel; the rest zooms. */
export function scrollableCanvasField(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !target.closest('.react-flow__node')) return false
  for (let element: Element | null = target; element && !element.classList.contains('react-flow__node'); element = element.parentElement) {
    const style = getComputedStyle(element)
    if ((/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight)
      || (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth)) return true
  }
  return false
}

function ModeIcon({ mode }: { mode: CanvasInteractionMode }) {
  useLanguage()
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={mode === 'select'
      ? 'M4 3 20 11 12 13 9 21 4 3Z'
      : 'M8.5 11V6.5a1.5 1.5 0 0 1 3 0V10 5.5a1.5 1.5 0 0 1 3 0V10 6.5a1.5 1.5 0 0 1 3 0v4-2a1.5 1.5 0 0 1 3 0v5.3c0 4-2.7 7.2-6.8 7.2h-1.4c-2.2 0-4.2-1.1-5.5-2.8l-3.1-4.1a1.6 1.6 0 0 1 .2-2.2 1.6 1.6 0 0 1 2.2.1l2.4 2.5V11Z'} />
  </svg>
}

function CanvasMenu({ label, className = '', style, children, anchor, onClose }: {
  label: string
  className?: string
  style?: CSSProperties
  anchor?: RefObject<HTMLElement>
  children: ReactNode
  onClose(): void
}) {
  useLanguage()
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !anchor?.current?.contains(event.target as Node)) closeRef.current()
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape)
    }
  }, [anchor])
  const navigate = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') { onClose(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div ref={menuRef} className={`vd-canvas-menu nodrag nopan ${className}`} style={style}
    role="menu" aria-label={label} onKeyDown={navigate}
    onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>{children}</div>
}

export function CanvasModeControl({ mode, onChange }: { mode: CanvasInteractionMode; onChange(mode: CanvasInteractionMode): void }) {
  useLanguage()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  return <div className="vd-mode-control">
    <button ref={buttonRef} type="button" className="react-flow__controls-button vd-mode-button"
      aria-label={t('Canvas mode: {0}', t(mode === 'select' ? 'Select' : 'Hand'))} aria-haspopup="menu" aria-expanded={open}
      title={t(mode === 'select' ? 'Select (V): click to select, drag nodes to move; Ctrl/⌘-drag to select a group' : 'Hand (H): drag anywhere to pan; Ctrl/⌘-drag to select a group')}
      onClick={() => setOpen(value => !value)}>
      <ModeIcon mode={mode} /><span className="vd-mode-chevron" aria-hidden>⌄</span>
    </button>
    {open ? <CanvasMenu label={t("Canvas interaction mode")} className="vd-mode-menu" anchor={buttonRef}
      onClose={() => { setOpen(false); buttonRef.current?.focus() }}>
      {(['select', 'hand'] as const).map(value => <button key={value} type="button" role="menuitemradio"
        aria-checked={mode === value} onClick={() => { onChange(value); setOpen(false); buttonRef.current?.focus() }}>
        <ModeIcon mode={value} /><span>{value === 'select' ? t("Select") : t("Hand")}</span><kbd>{value === 'select' ? 'V' : 'H'}</kbd>
      </button>)}
    </CanvasMenu> : null}
  </div>
}

export function CanvasContextMenu({ position, canPaste, resettingVram, onMap, onResetVram, onPaste, onClose }: {
  position: { x: number; y: number }
  canPaste: boolean
  resettingVram: boolean
  onMap(): void
  onResetVram(): void
  onPaste(): void
  onClose(): void
}) {
  useLanguage()
  return <CanvasMenu label={t("Canvas menu")} className="vd-pane-context-menu" style={{ left: position.x, top: position.y }} onClose={onClose}>
    <button type="button" role="menuitem" onClick={onMap}><span aria-hidden>⊞</span><span>{t("Add vd-node…")}</span></button>
    <button type="button" role="menuitem" disabled={resettingVram} onClick={onResetVram}><span aria-hidden>↻</span><span>{resettingVram ? t("Resetting VRAM…") : t("Reset VRAM")}</span></button>
    <button type="button" role="menuitem" disabled={!canPaste} onClick={onPaste}><span aria-hidden>▣</span><span>{t("Paste")}</span><kbd>Ctrl+V</kbd></button>
  </CanvasMenu>
}
