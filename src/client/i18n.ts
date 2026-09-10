import { useSyncExternalStore } from 'react'
import { messages } from './messages'

export type Language = 'en' | 'zh'
export const LANGUAGE_KEY = 'dsh-video-director.language'

export function preferredLanguage(saved: string | null, languages: readonly string[]): Language {
  if (saved === 'en' || saved === 'zh') return saved
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function initialLanguage(): Language {
  let saved = null
  try { saved = globalThis.localStorage?.getItem(LANGUAGE_KEY) ?? null } catch { /* Browser storage may be disabled. */ }
  return preferredLanguage(saved, globalThis.navigator?.languages ?? [])
}

let language = initialLanguage()
const listeners = new Set<() => void>()
export const getLanguage = (): Language => language
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setLanguage(value: Language): void {
  if (value !== 'en' && value !== 'zh') return
  try { globalThis.localStorage?.setItem(LANGUAGE_KEY, value) } catch { /* Still apply for this session. */ }
  language = value
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== LANGUAGE_KEY && event.key !== null) return
  language = preferredLanguage(event.newValue, navigator.languages)
  for (const listener of listeners) listener()
})

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage)
}

/** Only call for interface copy. Project names, prompts and generated content stay intact. */
export function t(message: string, ...values: Array<string | number>): string {
  const translated = messages[message]?.[language] ?? message
  return translated.replace(/\{(\d+)\}/gu, (placeholder, index: string) => String(values[Number(index)] ?? placeholder))
}
