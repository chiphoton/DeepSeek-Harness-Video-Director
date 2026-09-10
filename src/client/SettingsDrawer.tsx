import { t, useLanguage } from './i18n'
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import type { DirectorController } from './controller'
import { CloseIcon } from './icons'
import { StorageSettings } from './StorageSettings'
import { LanguageSettings } from './LanguageSettings'
import type {
  DirectorSnapshot,
  VdNodeDefinitionDescriptor,
  ProviderDescriptor,
  ComfyWorkflowDescriptor,
  ComfyWorkflowKind,
} from './types'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function healthLabel(provider: ProviderDescriptor, snapshot: DirectorSnapshot): string {
  const check = snapshot.providerChecks[provider.id]
  if (check?.state === 'checking') return t("检查中…")
  if (check?.state === 'ok') return provider.kind === 'codex-plan' ? t("{0} models available", String(provider.availableModels?.length ?? 0)) : t("可用 · {0} ms", String(check.latencyMs ?? 0))
  if (check?.state === 'error') return check.message ?? t("连接失败")
  if (!provider.configured) return t("配置不完整")
  return t("尚未检查")
}

function ProviderCard({
  provider,
  snapshot,
  director,
}: {
  provider: ProviderDescriptor
  snapshot: DirectorSnapshot
  director: DirectorController
}): ReactNode {
  useLanguage()
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [model, setModel] = useState(provider.model ?? '')
  const [imageModel, setImageModel] = useState(provider.imageModel ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const editRevision = useRef(0)
  const markEdited = (): void => {
    editRevision.current += 1
    setEdited(true)
  }

  useEffect(() => {
    if (edited) return
    setBaseUrl(provider.baseUrl ?? '')
    setModel(provider.model ?? '')
    setImageModel(provider.imageModel ?? '')
    setApiKey('')
    setClearApiKey(false)
  }, [edited, provider.apiKeySet, provider.baseUrl, provider.id, provider.imageModel, provider.model])

  const save = async (): Promise<void> => {
    const revision = editRevision.current
    setBusy(true)
    setMessage(null)
    try {
      await director.updateProvider(provider.id, {
        baseUrl,
        ...(provider.kind === 'ollama' || provider.kind === 'openai-compatible' ? { model } : {}),
        ...(provider.kind === 'openai-compatible' ? { imageModel } : {}),
        ...(apiKey === '' ? {} : { apiKey }),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      })
      if (editRevision.current === revision) {
        setApiKey('')
        setClearApiKey(false)
        setEdited(false)
        setMessage(t("配置已保存并实时生效"))
      } else {
        setMessage(t("先前配置已保存；保存期间的新修改尚未保存。"))
      }
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const check = snapshot.providerChecks[provider.id]
  const availableModels = provider.availableModels ?? []
  const selectedModelMissing = model !== '' && !availableModels.includes(model)
  return (
    <section className="vd-settings-card">
      <header>
        <div>
          <strong>{provider.label}</strong>
          <span>{provider.kind}</span>
        </div>
        <span className={`vd-health vd-health-${check?.state ?? (provider.configured ? 'idle' : 'error')}`}>
          {healthLabel(provider, snapshot)}
        </span>
      </header>
      {provider.kind === 'comfyui' ? (
        <p className="vd-settings-note">{t("只需填写 ComfyUI 的 IP 和端口。Video Director 会在 Host 内自动探测并选择 REST 或 ComfyUI MCP；节点和用户无需选择传输方式。")}</p>
      ) : null}
      {provider.kind === 'codex-plan' ? (
        <>
          <p className="vd-settings-note">{t("Uses your local Codex sign-in. Models sync from Codex and use their default reasoning effort. Choose a model in text/image nodes.")}</p>
          <label className="vd-clear-secret">
            <input type="checkbox" checked={provider.fastMode === true} disabled={busy} onChange={event => {
              const fastMode = event.target.checked
              setBusy(true)
              setMessage(null)
              void director.updateProvider(provider.id, { fastMode })
                .catch(error => setMessage(messageOf(error)))
                .finally(() => setBusy(false))
            }} />
            {t("Fast (priority)")}
          </label>
          <p className="vd-settings-note">{t("Faster responses with increased usage. Applies to supported Codex models in text/image nodes. Off by default.")}</p>
          {provider.codexCatalog?.source === 'cache' ? <p className="vd-settings-note">{t("Using the saved model list. Refresh models to check for updates.")}</p> : null}
        </>
      ) : null}
      {provider.kind === 'comfyui' && provider.modelDiscovery?.state === 'ready' ? (
        <p className="vd-settings-note">{t("已从 ComfyUI 同步模型枚举；模型只会出现在对应 Workflow 已声明开放的参数下拉中，Workflow 仍是节点的主选择。")}</p>
      ) : null}
      {provider.modelDiscovery?.state === 'error' ? (
        <p className="vd-settings-note">{t("模型列表刷新失败：")}{provider.modelDiscovery.message ?? t("未知错误")}{t("。当前选择已保留，可用下面的按钮重试。")}</p>
      ) : null}
      {provider.kind === 'codex-plan' ? null : <div className="vd-settings-grid">
        <label className="vd-span-2">
          <span>{provider.kind === 'comfyui' ? 'ComfyUI IP / Port' : 'Base URL'}</span>
          <input value={baseUrl} placeholder={provider.kind === 'comfyui' ? '127.0.0.1:8188' : 'https://api.example.com/v1'} onChange={event => { setBaseUrl(event.target.value); markEdited() }} />
        </label>
        {provider.kind === 'ollama' ? (
          <label>
            <span>{t("默认文字 / 多模态模型")}</span>
            <select
              value={model}
              disabled={availableModels.length === 0 && !selectedModelMissing}
              onChange={event => { setModel(event.target.value); markEdited() }}
            >
              {model === '' ? (
                <option value="">{provider.modelDiscovery?.state === 'loading' ? t("正在从 Ollama 获取模型…") : t("尚未检测到可用模型")}</option>
              ) : null}
              {selectedModelMissing ? <option value={model}>{model} {t("· 当前配置（API 未返回）")}</option> : null}
              {availableModels.map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </label>
        ) : provider.kind === 'openai-compatible' ? (
          <label>
            <span>{t("默认文字 / 多模态模型")}</span>
            <input value={model} placeholder="qwen3-vl" onChange={event => { setModel(event.target.value); markEdited() }} />
          </label>
        ) : null}
        {provider.kind === 'openai-compatible' ? (
          <label>
            <span>{t("默认图像模型")}</span>
            <input value={imageModel} placeholder="gpt-image-2" onChange={event => { setImageModel(event.target.value); markEdited() }} />
          </label>
        ) : null}
        {(provider.kind === 'openai-compatible' || provider.requiresApiKey || provider.apiKeySet) ? (
          <label className="vd-span-2">
            <span>API Key {provider.apiKeySet ? t("· 已保存（不会回显）") : ''}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={clearApiKey}
              placeholder={provider.apiKeySet ? t("留空以保留当前密钥") : t("输入密钥")}
              onChange={event => { setApiKey(event.target.value); markEdited() }}
            />
          </label>
        ) : null}
      </div>}
      <footer>
        {provider.apiKeySet ? (
          <label className="vd-clear-secret">
            <input type="checkbox" checked={clearApiKey} onChange={event => { setClearApiKey(event.target.checked); markEdited() }} />
            {t("清除已保存密钥")}
          </label>
        ) : <span />}
        <div>
          <button type="button" className="vd-secondary" disabled={check?.state === 'checking' || provider.modelDiscovery?.state === 'loading'} onClick={() => { void director.checkProvider(provider.id) }}>
            {provider.kind === 'codex-plan'
              ? t("Refresh models")
              : provider.kind === 'ollama' || provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp'
                ? t("检查连接并刷新模型")
                : t("检查连接")}
          </button>
          {provider.kind === 'codex-plan' ? null : (
            <button type="button" className="vd-primary" disabled={busy} onClick={() => { void save() }}>{busy ? t("保存中…") : t("保存配置")}</button>
          )}
        </div>
      </footer>
      {message !== null ? <div className="vd-settings-message">{message}</div> : null}
    </section>
  )
}

function workflowKindLabel(kind: ComfyWorkflowKind): string {
  return ({
    'image-generation': t("图像生成"),
    'image-edit': t("图像编辑"),
    'video-generation': t("视频生成"),
    'audio-generation': t("音频生成"),
  })[kind]
}

function ComfyWorkflowRow({ workflow, director }: { workflow: ComfyWorkflowDescriptor; director: DirectorController }): ReactNode {
  useLanguage()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    if (workflow.builtIn || busy || !window.confirm(t("删除 workflow“{0}”？", workflow.name))) return
    setBusy(true)
    setMessage(null)
    try {
      await director.deleteWorkflow(workflow.id)
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="vd-workflow-row">
      <div className="vd-workflow-icon">⌘</div>
      <div>
        <strong>{workflow.name}</strong>
        <span>{workflowKindLabel(workflow.kind)} · {workflow.parameters.length} {t("个可配置参数")}{workflow.builtIn ? t(" · 内置") : ''}</span>
        {workflow.description !== '' ? <p>{workflow.description}</p> : null}
      </div>
      {!workflow.builtIn ? <button type="button" className="vd-danger-text" disabled={busy} onClick={() => { void remove() }}>{busy ? t("删除中…") : t("删除")}</button> : null}
      {message !== null ? <div className="vd-settings-message vd-workflow-row-message">{message}</div> : null}
    </article>
  )
}

function VdNodeLibrarySettings({ snapshot, director }: { snapshot: DirectorSnapshot; director: DirectorController }): ReactNode {
  useLanguage()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ComfyWorkflowKind>('image-generation')
  const [description, setDescription] = useState('')
  const [document, setDocument] = useState<Record<string, unknown> | null>(null)
  const [filename, setFilename] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [nodePack, setNodePack] = useState<Record<string, unknown> | null>(null)
  const [nodeFilename, setNodeFilename] = useState('')
  const [nodeBusy, setNodeBusy] = useState(false)
  const [nodeMessage, setNodeMessage] = useState<string | null>(null)
  const grouped = useMemo(() => snapshot.workflows.reduce<Record<string, ComfyWorkflowDescriptor[]>>((result, workflow) => {
    ;(result[workflow.kind] ??= []).push(workflow)
    return result
  }, {}), [snapshot.workflows])

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setMessage(null)
    try {
      const value: unknown = JSON.parse(await file.text())
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(t("comfyui-workflow JSON 必须是对象。"))
      setDocument(value as Record<string, unknown>)
      setFilename(file.name)
      if (name.trim() === '') setName(file.name.replace(/\.json$/iu, ''))
    } catch (error) {
      setDocument(null)
      setFilename('')
      setMessage(messageOf(error))
    }
  }

  const importWorkflow = async (): Promise<void> => {
    if (document === null || name.trim() === '') return
    setBusy(true)
    setMessage(null)
    try {
      const workflow = await director.importWorkflow({ name: name.trim(), kind, description: description.trim(), document })
      setName('')
      setDescription('')
      setDocument(null)
      setFilename('')
      setMessage(t("已导入 {0}，节点现在可以直接选择它。", workflow.name))
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const chooseNodePack = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setNodeMessage(null)
    try {
      const value: unknown = JSON.parse(await file.text())
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(t("vd-node pack 必须是 JSON 对象。"))
      setNodePack(value as Record<string, unknown>)
      setNodeFilename(file.name)
    } catch (error) {
      setNodePack(null)
      setNodeFilename('')
      setNodeMessage(messageOf(error))
    }
  }

  const installNodePack = async (): Promise<void> => {
    if (nodePack === null || nodeBusy) return
    setNodeBusy(true)
    setNodeMessage(null)
    try {
      const definition = await director.installNode(nodePack)
      setNodePack(null)
      setNodeFilename('')
      setNodeMessage(t("已安装 {0} · {1}@{2}，现在可从画布底栏添加。", definition.title, definition.type, definition.version))
    } catch (error) {
      setNodeMessage(messageOf(error))
    } finally {
      setNodeBusy(false)
    }
  }

  return (
    <div className="vd-workflow-settings">
      <section className="vd-import-card">
        <div>
          <strong>{t("导入 Video Director Custom Node")}</strong>
          <p>{t("接受")} <b>video-director.node/v1</b> {t("单文件 manifest。普通导入只能声明 ComfyUI workflow、typed ports 和 Primary/Advanced 字段，不能携带 JavaScript、Shell 或任意 MCP tool。")}</p>
        </div>
        <label className="vd-file-picker">
          <input hidden type="file" accept="application/json,.json,.director-node.json" onChange={event => { void chooseNodePack(event) }} />
          <span>{nodeFilename === '' ? t("选择 .director-node.json…") : t("已选择 {0}", nodeFilename)}</span>
        </label>
        <button type="button" className="vd-primary" disabled={nodeBusy || nodePack === null} onClick={() => { void installNodePack() }}>
          {nodeBusy ? t("校验并安装中…") : t("校验并安装 Node")}
        </button>
        {nodeMessage !== null ? <div className="vd-settings-message">{nodeMessage}</div> : null}
      </section>
      <section className="vd-workflow-group">
        <h3>{t("Node Catalog ·")} {snapshot.nodeDefinitions.length}</h3>
        {snapshot.nodeDefinitions.map((definition: VdNodeDefinitionDescriptor) => (
          <article className="vd-workflow-row" key={`${definition.type}@${definition.version}`}>
            <div className="vd-workflow-icon">{definition.behavior === 'preview' ? '◫' : definition.behavior === 'save' ? '⇩' : '◇'}</div>
            <div>
              <strong>{definition.title}</strong>
              <span>{definition.type}@{definition.version} · {definition.fields.filter(field => field.placement === 'primary').length} {t("primary /")} {definition.fields.filter(field => field.placement === t("advanced")).length} {t("advanced")}</span>
              {definition.description !== '' ? <p>{definition.description}</p> : null}
            </div>
          </article>
        ))}
      </section>
      <section className="vd-import-card">
        <div>
          <strong>{t("导入 ComfyUI Workflow")}</strong>
          <p>{t("请在 ComfyUI 中使用")} <b>Save (API Format)</b>{t("。导入后会自动识别 prompt、seed、尺寸、帧数等绑定，并把其余基础输入提取成节点参数。")}</p>
        </div>
        <div className="vd-import-grid">
          <label>
            <span>{t("名称")}</span>
            <input value={name} placeholder="My image workflow" onChange={event => setName(event.target.value)} />
          </label>
          <label>
            <span>{t("用途")}</span>
            <select value={kind} onChange={event => setKind(event.target.value as ComfyWorkflowKind)}>
              <option value="image-generation">{t("图像生成")}</option>
              <option value="image-edit">{t("图像编辑")}</option>
              <option value="video-generation">{t("视频生成")}</option>
              <option value="audio-generation">{t("音频生成")}</option>
            </select>
          </label>
          <label className="vd-span-2">
            <span>{t("说明（可选）")}</span>
            <input value={description} placeholder={t("适用模型、输入要求或用途")} onChange={event => setDescription(event.target.value)} />
          </label>
          <label className="vd-file-picker vd-span-2">
            <input hidden type="file" accept="application/json,.json" onChange={event => { void chooseFile(event) }} />
            <span>{filename === '' ? t("选择 API-format workflow JSON…") : t("已选择 {0}", filename)}</span>
          </label>
        </div>
        <button type="button" className="vd-primary" disabled={busy || document === null || name.trim() === ''} onClick={() => { void importWorkflow() }}>
          {busy ? t("导入中…") : t("导入并保存")}
        </button>
        {message !== null ? <div className="vd-settings-message">{message}</div> : null}
      </section>
      {(['image-generation', 'image-edit', 'video-generation', 'audio-generation'] as ComfyWorkflowKind[]).map(group => (
        <section className="vd-workflow-group" key={group}>
          <h3>{workflowKindLabel(group)}</h3>
          {(grouped[group] ?? []).length === 0 ? <p className="vd-settings-empty">{t("还没有这个用途的 workflow。")}</p> : null}
          {(grouped[group] ?? []).map(workflow => <ComfyWorkflowRow key={workflow.id} workflow={workflow} director={director} />)}
        </section>
      ))}
    </div>
  )
}

export function SettingsDrawer({
  snapshot,
  director,
  onClose,
}: {
  snapshot: DirectorSnapshot
  director: DirectorController
  onClose(): void
}): ReactNode {
  useLanguage()
  const [tab, setTab] = useState<'providers' | 'workflows' | 'storage' | 'language'>('providers')
  return (
    <aside className="vd-settings-drawer" aria-label={t("Video Director 设置")}>
      <header className="vd-settings-header">
        <div><span>VIDEO DIRECTOR</span><strong>{t("设置")}</strong></div>
        <button type="button" className="vd-close-icon-button" aria-label={t("关闭设置")} onClick={onClose}><CloseIcon /></button>
      </header>
      <nav className="vd-settings-tabs" role="tablist" aria-label={t("设置分类")}>
        <button type="button" role="tab" aria-selected={tab === 'providers'} className={tab === 'providers' ? 'is-active' : ''} onClick={() => setTab('providers')}>{t("连接")}</button>
        <button type="button" role="tab" aria-selected={tab === 'workflows'} className={tab === 'workflows' ? 'is-active' : ''} onClick={() => setTab('workflows')}>{t("Nodes & Workflows")}</button>
        <button type="button" role="tab" aria-selected={tab === 'storage'} className={tab === 'storage' ? 'is-active' : ''} onClick={() => setTab('storage')}>{t("Storage")}</button>
        <button type="button" role="tab" aria-selected={tab === 'language'} className={tab === 'language' ? 'is-active' : ''} onClick={() => setTab('language')}>{t('Language')}</button>
      </nav>
      <div className="vd-settings-body">
        {tab === 'providers' ? (
          <>
            <div className="vd-settings-intro">
              <strong>{t("Provider 连接")}</strong>
              <p>{t("这些是全局连接设置，会通过 DSH 原生设置 持久化并实时应用；API Key 不会发送回浏览器。")}</p>
            </div>
            {snapshot.providers.map(provider => (
              <ProviderCard key={provider.id} provider={provider} snapshot={snapshot} director={director} />
            ))}
          </>
        ) : tab === 'storage' ? <StorageSettings snapshot={snapshot} director={director} /> : tab === 'language' ? <LanguageSettings /> : <VdNodeLibrarySettings snapshot={snapshot} director={director} />}
      </div>
    </aside>
  )
}
