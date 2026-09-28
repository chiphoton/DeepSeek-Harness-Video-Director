import { useEffect, useId, useRef, useState } from 'react'
import type { DirectorController } from './controller'
import type { ComfyModelCategory, DirectorSnapshot, ProviderDescriptor } from './types'
import { RefreshIcon, UnloadIcon } from './icons'
import { t, useLanguage } from './i18n'

type Draft = { baseUrl: string; apiKey: string | null; fastMode: boolean }
type Field = keyof Draft
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// Serialize blur commits while allowing continued typing. Acknowledging an older
// write must never clear a newer draft (especially a replacement API key).
function useProviderAutosave(provider: ProviderDescriptor, director: DirectorController) {
  const [draft, setDraft] = useState<Draft>({ baseUrl: provider.baseUrl ?? '', apiKey: '', fastMode: provider.fastMode === true })
  const current = useRef(draft)
  const dirty = useRef(new Set<Field>())
  const versions = useRef({ baseUrl: 0, apiKey: 0, fastMode: 0 })
  const queued = useRef(new Map<Field, number>())
  const tail = useRef(Promise.resolve())
  const [pending, setPending] = useState(0)
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const updateDraft = (patch: Partial<Draft>): void => {
    current.current = { ...current.current, ...patch }
    setDraft(current.current)
  }
  useEffect(() => {
    const patch: Partial<Draft> = {}
    if (!dirty.current.has('baseUrl')) patch.baseUrl = provider.baseUrl ?? ''
    if (!dirty.current.has('fastMode')) patch.fastMode = provider.fastMode === true
    updateDraft(patch)
  }, [provider.baseUrl, provider.fastMode])
  const edit = <K extends Field>(field: K, value: Draft[K]): void => {
    versions.current[field]++
    dirty.current.add(field)
    setErrors(previous => { const next = { ...previous }; delete next[field]; return next })
    updateDraft({ [field]: value })
  }
  const flush = (): Promise<void> => {
    // An empty replacement means keep the saved secret. Clearing is explicit.
    if (current.current.apiKey === '') dirty.current.delete('apiKey')
    const fields = [...dirty.current].filter(field => queued.current.get(field) !== versions.current[field])
    if (!fields.length) return dirty.current.size ? tail.current : tail.current.catch(() => {})
    const revision = { ...versions.current }
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      if (field === 'apiKey' && current.current.apiKey === null) patch.clearApiKey = true
      else patch[field] = field === 'baseUrl' ? current.current.baseUrl.trim() : current.current[field]
      queued.current.set(field, revision[field])
    }
    setPending(count => count + 1)
    setErrors(previous => { const next = { ...previous }; fields.forEach(field => delete next[field]); return next })
    const saving = tail.current.catch(() => {}).then(() => director.updateProvider(provider.id, patch)).then(() => {
      const saved = director.getSnapshot().providers.find(item => item.id === provider.id)
      const accepted: Partial<Draft> = {}
      for (const field of fields) {
        if (versions.current[field] !== revision[field]) continue
        dirty.current.delete(field)
        if (field === 'baseUrl') accepted.baseUrl = saved?.baseUrl ?? ''
        if (field === 'apiKey') accepted.apiKey = ''
        if (field === 'fastMode') accepted.fastMode = saved?.fastMode === true
      }
      updateDraft(accepted)
    }).catch(error => {
      setErrors(previous => {
        const next = { ...previous }
        for (const field of fields) if (versions.current[field] === revision[field]) next[field] = messageOf(error)
        return next
      })
      throw error
    }).finally(() => {
      fields.forEach(field => { if (queued.current.get(field) === revision[field]) queued.current.delete(field) })
      setPending(count => count - 1)
    })
    tail.current = saving
    return saving
  }
  return { draft, edit, flush, saving: pending > 0, error: Object.values(errors).filter(Boolean).join(' · ') }
}

const order: Record<ProviderDescriptor['kind'], number> = { ollama: 0, comfyui: 1, 'comfyui-mcp': 1, 'openai-compatible': 2, 'codex-plan': 3 }
const modelCategories: ComfyModelCategory[] = ['checkpoints', 'diffusion_models', 'loras', 'vae']
const providerName = (provider: ProviderDescriptor): string => ({
  ollama: 'Ollama', comfyui: 'ComfyUI', 'comfyui-mcp': 'ComfyUI',
  'openai-compatible': 'OpenAI Compatible', 'codex-plan': 'Codex Coding Plan',
})[provider.kind]

function ProviderCard({ provider, snapshot, director }: { provider: ProviderDescriptor; snapshot: DirectorSnapshot; director: DirectorController }) {
  const form = useProviderAutosave(provider, director)
  const id = useId()
  const [action, setAction] = useState<'refresh' | 'unload' | null>(null)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(30)
  const [category, setCategory] = useState<ComfyModelCategory>('checkpoints')
  const check = snapshot.providerChecks[provider.id]
  const discovery = provider.modelDiscovery
  const codex = provider.kind === 'codex-plan'
  const comfy = provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp'
  const canUnload = provider.kind === 'ollama' || comfy
  const inventory = comfy ? provider.modelInventory?.[category] : undefined
  const models = [...new Set(comfy ? inventory?.models ?? [] : provider.availableModels ?? [])]
  const matching = models.filter(model => model.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const busy = action !== null || check?.state === 'checking' || discovery?.state === 'loading'
  const error = form.error || actionError || (check?.state === 'error' ? check.message : '') || (discovery?.state === 'error' ? discovery.message : '')
  const connected = check?.state === 'ok' || discovery?.state === 'ready'
  const status = busy ? t('Checking…') : error ? t('Connection error') : connected ? t('Connected') : provider.configured ? t('Not checked') : t('Not configured')
  const saveOnBlur = (): void => { void form.flush().catch(() => {}) }
  const runAction = async (next: 'refresh' | 'unload'): Promise<void> => {
    if (action) return
    setAction(next); setActionError(''); setNotice('')
    try {
      await form.flush()
      if (next === 'refresh') await director.checkProvider(provider.id)
      else {
        const endpoint = director.getSnapshot().providers.find(item => item.id === provider.id)?.baseUrl
        const result = await director.unloadProviderModels(provider.id)
        if (director.getSnapshot().providers.find(item => item.id === provider.id)?.baseUrl === endpoint) {
          setNotice(result === 'requested' ? t('Unload requested') : t('Models unloaded'))
        }
      }
    } catch (error) { setActionError(messageOf(error)) }
    finally { setAction(null) }
  }
  const actions = <div className="vd-provider-actions">
    <button type="button" className="vd-provider-action" disabled={busy} aria-label={t('Check connection and refresh models')} title={t('Check connection and refresh models')}
      onClick={() => { void runAction('refresh') }}><RefreshIcon /><span>{t('Refresh')}</span></button>
    {canUnload ? <button type="button" className="vd-provider-action" disabled={busy} aria-label={t('Unload Models')} title={t('Unload Models')}
      onClick={() => { void runAction('unload') }}><UnloadIcon /><span>{t('Unload Models')}</span></button> : null}
  </div>
  return <section className="vd-provider-card" aria-labelledby={`${id}-name`} data-provider-id={provider.id}>
    <header><h3 id={`${id}-name`}>{providerName(provider)}</h3><span className={`vd-provider-health is-${error ? 'error' : connected ? 'connected' : 'idle'}`}>
      <i aria-hidden="true" />{action === 'unload' ? t('Unloading…') : status}
      {connected && !busy && !error && check?.latencyMs !== undefined ? <small>{check.latencyMs} ms</small> : null}
    </span></header>
    {codex ? <div className="vd-provider-local"><span>{t('Uses your local Codex sign-in and coding plan.')}</span>{actions}</div>
      : <div className="vd-provider-endpoint">
        <label htmlFor={`${id}-url`}><span>Base URL</span><input id={`${id}-url`} value={form.draft.baseUrl} spellCheck={false} autoComplete="off"
          placeholder={comfy ? '127.0.0.1:8188' : provider.kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.example.com/v1'}
          onChange={event => { form.edit('baseUrl', event.target.value); setNotice('') }} onBlur={saveOnBlur}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveOnBlur() } }} /></label>
        {actions}
      </div>}
    {!codex && (provider.kind === 'openai-compatible' || provider.requiresApiKey || provider.apiKeySet) ? <div className="vd-provider-secret">
      <label htmlFor={`${id}-key`}><span>API Key</span><input id={`${id}-key`} type="password" autoComplete="new-password" value={form.draft.apiKey ?? ''}
        placeholder={provider.apiKeySet ? t('Saved key · leave blank to keep') : t('Enter API key')}
        onChange={event => { form.edit('apiKey', event.target.value); setNotice('') }} onBlur={saveOnBlur}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveOnBlur() } }} /></label>
      {provider.apiKeySet ? <button type="button" className="vd-provider-clear" onClick={() => { form.edit('apiKey', null); saveOnBlur() }}>{t('Clear saved key')}</button> : null}
    </div> : null}
    {codex ? <label className="vd-provider-fast"><input type="checkbox" checked={form.draft.fastMode}
      onChange={event => { form.edit('fastMode', event.target.checked); saveOnBlur() }} />{t('Fast (priority)')}</label> : null}
    <div className="vd-provider-models">
      {comfy ? <div className="vd-provider-model-tabs" role="tablist" aria-label={t('Model categories')}>
        {modelCategories.map((item, index) => <button key={item} type="button" role="tab" id={`${id}-${item}`} aria-selected={category === item}
          aria-controls={`${id}-models`} tabIndex={category === item ? 0 : -1}
          onClick={() => { setCategory(item); setSearch(''); setVisible(30) }}
          onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % modelCategories.length
              : event.key === 'ArrowLeft' ? (index + modelCategories.length - 1) % modelCategories.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? modelCategories.length - 1 : undefined
            if (next === undefined) return
            event.preventDefault()
            const target = event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined
            target?.focus(); target?.click()
          }}>{item}</button>)}
      </div> : null}
      <div key={comfy ? category : 'all'} id={`${id}-models`} role={comfy ? 'tabpanel' : undefined}
        aria-labelledby={comfy ? `${id}-${category}` : undefined}>
      <div className="vd-provider-models-heading"><span>{t('Models')} <b>{inventory?.error ? '—' : models.length}</b></span>
        {codex && provider.codexCatalog?.source === 'cache' ? <small>{t('Cached')}</small> : null}
        {models.length > 8 ? <input type="search" aria-label={t('Search models')} placeholder={t('Search models')} value={search}
          onChange={event => { setSearch(event.target.value); setVisible(30) }} /> : null}
      </div>
      {inventory?.error ? <p className="vd-provider-feedback is-error" role="alert">{inventory.error}</p> : models.length ? <div className="vd-provider-model-scroll" onScroll={event => {
        const list = event.currentTarget
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 24) setVisible(count => count + 30)
      }}>
        <ul aria-label={comfy ? `${category} ${t('Models')}` : t('Models')}>
          {matching.slice(0, visible).map(model => <li key={model}><span>{model}</span>{provider.loadedModels?.includes(model) ? <small>{t('Loaded')}</small> : null}</li>)}
        </ul>
        {!matching.length ? <p>{t('No matching models')}</p> : null}
        {matching.length > visible ? <button type="button" onClick={() => setVisible(count => count + 30)}>{t('Show more')}</button> : null}
      </div> : <p className="vd-provider-model-empty">{discovery?.state === 'loading' ? t('Loading models…') : connected ? t('No models available') : t('Refresh to discover models')}</p>}
      </div>
    </div>
    {error ? <div className="vd-provider-feedback is-error" role="alert"><span>{error}</span>{form.error ? <button type="button" onClick={saveOnBlur}>{t('Retry')}</button> : null}</div>
      : form.saving || notice ? <div className="vd-provider-feedback" role="status">{form.saving ? t('Saving…') : notice}</div> : null}
  </section>
}

export function ProviderConnections({ snapshot, director }: { snapshot: DirectorSnapshot; director: DirectorController }) {
  useLanguage()
  return <div className="vd-provider-connections">
    <p className="vd-provider-autosave">{t('Changes save automatically when you leave a field.')}</p>
    {[...snapshot.providers].sort((a, b) => order[a.kind] - order[b.kind]).map(provider => <ProviderCard key={provider.id} provider={provider} snapshot={snapshot} director={director} />)}
  </div>
}
