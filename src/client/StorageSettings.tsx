import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { DirectorController } from './controller'
import type { DirectorSnapshot } from './types'
import { getLanguage, t, useLanguage } from './i18n'

interface StorageInfo {
  dataDir: string
  defaultDataDir: string
  isDefault: boolean
  openLabel: string
  canChange: boolean
  blockedReason: string | null
}

export function StorageSettings({ snapshot, director }: { snapshot: DirectorSnapshot; director: DirectorController }): ReactNode {
  useLanguage()
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [busy, setBusy] = useState<'opening' | 'choosing' | 'changing' | 'resetting' | null>(null)
  const [message, setMessage] = useState<{ text: string; values?: string[]; error?: boolean } | null>(null)
  const chooser = useRef<AbortController | null>(null)
  useEffect(() => () => { chooser.current?.abort() }, [])
  const running = snapshot.project?.jobs.some(job => job.status === 'queued' || job.status === 'running')
    || snapshot.workflowRuns.some(run => run.status === 'queued' || run.status === 'running')

  useEffect(() => {
    if (busy) return
    const controller = new AbortController()
    const refresh = async (): Promise<void> => {
      try {
        const info = await director.storage<StorageInfo>('info', {}, controller.signal)
        if (!controller.signal.aborted) setStorage(info)
      } catch (error) {
        if (!controller.signal.aborted) setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [busy, director])

  const openFolder = async (): Promise<void> => {
    setBusy('opening')
    setMessage(null)
    try { await director.storage('open') }
    catch (error) { setMessage({ text: error instanceof Error ? error.message : String(error), error: true }) }
    finally { setBusy(null) }
  }

  const changeFolder = async (reset = false): Promise<void> => {
    if (!storage || busy) return
    setBusy(reset ? 'resetting' : 'choosing')
    setMessage(null)
    try {
      let newPath = storage.defaultDataDir
      if (!reset) {
        const controller = new AbortController()
        chooser.current = controller
        const selected = await director.storage<{ dataDir: string | null }>('choose', { language: getLanguage() }, controller.signal)
        if (controller.signal.aborted || !selected.dataDir || selected.dataDir === storage.dataDir) return
        newPath = selected.dataDir
        setBusy('changing')
      }
      await director.flushDrafts()
      const current = director.getSnapshot()
      if (current.conflict || current.saving) throw new Error('Wait for the current save before changing its data folder.')
      const result = await director.storage<StorageInfo & { previousDataDir: string; backupDataDir: string | null }>(reset ? 'reset' : 'change', {
        dataDir: newPath, expectedDataDir: storage.dataDir,
      })
      setStorage(result)
      setMessage({ text: reset ? 'Default folder restored. Your latest data is available here. Backups: {0}' : 'Data folder changed. Your projects and media are available here. Backup: {0}', values: [[result.previousDataDir, result.backupDataDir].filter(Boolean).join(' · ')] })
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally { chooser.current = null; setBusy(null) }
  }

  return (
    <div aria-label={t('Storage settings')}>
      <div className="vd-settings-intro">
        <strong>{t('Storage')}</strong>
        <p>{t('Manage where Video Director saves projects, generated media, and workflow history. Harness manages conversations and connection settings.')}</p>
      </div>
      <section className="vd-settings-card">
        <header><strong>{t('Current data folder')}</strong>{storage?.isDefault ? <span>{t('Default')}</span> : null}</header>
        <p className="vd-storage-path" aria-label={t('Current data folder')}>{storage?.dataDir ?? t('Loading…')}</p>
        <div className="vd-storage-actions">
          <button type="button" className="vd-secondary" disabled={!storage || busy !== null} onClick={() => { void openFolder() }}>
            {t(busy === 'opening' ? 'Opening…' : storage?.openLabel ?? 'Open Folder')}
          </button>
          <button type="button" className="vd-primary" disabled={!storage?.canChange || busy !== null || running || snapshot.saving || snapshot.conflict} onClick={() => { void changeFolder() }}>
            {t(busy === 'choosing' ? 'Choosing folder…' : busy === 'changing' ? 'Changing folder…' : 'Change folder')}
          </button>
          <button type="button" className="vd-secondary" title={t('Restore the default data folder: {0}', storage?.defaultDataDir ?? '')} disabled={!storage?.canChange || storage.isDefault || busy !== null || running || snapshot.saving || snapshot.conflict} onClick={() => { void changeFolder(true) }}>
            {t(busy === 'resetting' ? 'Resetting…' : 'Reset')}
          </button>
        </div>
        <p className="vd-settings-note">{t('Choose a new or empty folder. Canvas caches your drafts, copies your data, and remembers the new location. Reset returns your latest data to the default folder. Previous folders are kept as backups.')}</p>
        {storage && !storage.isDefault ? <p className="vd-storage-default">{t('Default folder: {0}', storage.defaultDataDir)}</p> : null}
        {storage?.blockedReason || running ? <p className="vd-settings-note">{t(storage?.blockedReason ?? 'Wait for generation and workflows to finish before changing storage.')}</p> : null}
        {snapshot.conflict ? <p className="vd-settings-note">{t('Resolve the canvas save conflict before changing storage.')}</p> : null}
      </section>
      {message ? <p className="vd-settings-message" role={message.error ? 'alert' : 'status'}>{t(message.text, ...message.values ?? [])}</p> : null}
    </div>
  )
}
