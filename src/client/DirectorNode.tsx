import { t, useLanguage } from './i18n'
import {
  createContext,
  Fragment,
  memo,
  type CSSProperties,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type TextareaHTMLAttributes,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react'
import type {
  AssetRef,
  DirectorNode as DirectorFlowNode,
  DirectorNodeData,
  MediaKind,
  VdNodeDefinitionDescriptor,
  VdFieldDescriptor,
  VdPortDescriptor,
  ProviderDescriptor,
  ComfyWorkflowBinding,
  ComfyWorkflowDescriptor,
  ComfyWorkflowParameter,
} from './types'
import { referenceLabelsByKind, type DirectorReferencePreview } from './reference-previews'
import { DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT } from './default-system-prompt'
import { codexModelForNode, effectiveOllamaModel, modelChoicePresentation, ollamaModelSupports } from './model-choices'
import { fieldInputModeEnabled, fieldInputPortId, parameterInputCandidates } from './parameter-inputs'
import { embeddedWorkflowInputPortIds, inputPortsFor, nodeDefinition, portHandleId, portsFor, shouldShowPortLabel, shouldShowReferencePanel } from './ports'
import { createImeDraft, reduceImeDraft, type ImeDraftEvent, type ImeDraftState } from './ime-draft.js'
import {
  ArtifactPreviewDialog,
  ArtifactThumbnail,
  type PreviewArtifact,
  previewArtifactFromAsset,
  previewArtifactFromText,
} from './ArtifactPreview'

export interface DirectorRuntimeValue {
  providers: ProviderDescriptor[]
  workflows: ComfyWorkflowDescriptor[]
  nodeDefinitions: VdNodeDefinitionDescriptor[]
  references: Readonly<Record<string, readonly DirectorReferencePreview[]>>
  onChange(nodeId: string, patch: Partial<DirectorNodeData>): void
  onEditSketch(nodeId: string): void
  onRefreshModels(providerId: string): Promise<void>
  onEjectModel(providerId: string, model: string): Promise<void>
  onRunNode(nodeId: string): Promise<void>
}

const DirectorRuntimeContext = createContext<DirectorRuntimeValue | null>(null)

export function DirectorRuntimeProvider(props: PropsWithChildren<{ value: DirectorRuntimeValue }>): ReactNode {
  useLanguage()
  return (
    <DirectorRuntimeContext.Provider value={props.value}>
      {props.children}
    </DirectorRuntimeContext.Provider>
  )
}

export function useDirectorRuntime(): DirectorRuntimeValue | null {
  return useContext(DirectorRuntimeContext)
}

const palette = {
  panel: 'var(--vd-node-panel, #fbfdff)',
  raised: 'var(--vd-node-raised, #eef2ff)',
  field: '#ffffff',
  border: 'var(--vd-node-border, #cbd5e1)',
  subtleBorder: '#dbe3ee',
  ink: '#172033',
  secondary: '#475569',
  muted: '#64748b',
  accent: 'var(--vd-node-accent, #4338ca)',
  danger: '#b42318',
  success: '#067647',
}

const VIDEO_MODE_OPTIONS: Array<{ value: NonNullable<DirectorNodeData['videoMode']>; label: string }> = [
  { value: 'text-to-video', label: 'Text-to-Video' },
  { value: 'first-frame-locked', label: 'First Frame Locked' },
  { value: 'last-frame-locked', label: 'Last Frame Locked' },
  { value: 'first-to-last-frame', label: 'First-to-Last Frame' },
]

const H3_TEXT_IMAGE_VIDEO_WORKFLOW_ID = 'builtin-minimax-h3-video-turbo'
const H3_REFERENCE_VIDEO_WORKFLOW_ID = 'builtin-minimax-h3-reference-to-video-turbo'

const VIDEO_SIZE_REFERENCE = [
  ['0.2', '16:9', '608 × 352'],
  ['0.3', '16:9', '736 × 416'],
  ['0.4', '16:9', '864 × 480'],
  ['0.5', '16:9', '960 × 544'],
  ['0.6', '16:9', '1056 × 608'],
  ['0.7', '16:9', '1152 × 640'],
  ['0.8', '16:9', '1216 × 672'],
  ['0.9', '16:9', '1280 × 736'],
  ['0.98', '16:9', '1344 × 768'],
  ['1.0', '16:9', '1376 × 768'],
  ['1.2', '16:9', '1504 × 832'],
  ['1.5', '16:9', '1664 × 928'],
  ['1.8', '16:9', '1824 × 1024'],
  ['2.0', '16:9', '1920 × 1088'],
] as const

interface NodeTheme {
  panel: string
  raised: string
  border: string
  accent: string
}

type ThemedNodeStyle = CSSProperties & {
  '--vd-node-panel': string
  '--vd-node-raised': string
  '--vd-node-border': string
  '--vd-node-accent': string
}

const NODE_THEMES = {
  text: { panel: '#fbfdff', raised: '#dbeafe', border: '#93c5fd', accent: '#1d4ed8' },
  image: { panel: '#fefcff', raised: '#ede9fe', border: '#c4b5fd', accent: '#6d28d9' },
  audio: { panel: '#fbfffc', raised: '#dcfce7', border: '#86efac', accent: '#047857' },
  video: { panel: '#fffdfb', raised: '#ffedd5', border: '#fdba74', accent: '#c2410c' },
  sketch: { panel: '#fffef9', raised: '#fef3c7', border: '#fcd34d', accent: '#a16207' },
  output: { panel: '#fbfdff', raised: '#f1f5f9', border: '#cbd5e1', accent: '#334155' },
  workflow: { panel: '#fcfcff', raised: '#e0e7ff', border: '#a5b4fc', accent: '#4338ca' },
  utility: { panel: '#f8feff', raised: '#cffafe', border: '#67e8f9', accent: '#0e7490' },
} satisfies Record<string, NodeTheme>

const FLOW_PORT_COLOR = '#16a34a'

const fieldStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  border: `1px solid ${palette.subtleBorder}`,
  borderRadius: 8,
  background: palette.field,
  color: palette.ink,
  padding: '7px 8px',
  font: 'inherit',
  fontSize: 11,
  outline: 'none',
}

const PROMPT_PLACEHOLDER = 'Describe the prompt...'

function useImeSafeValue(value: string, onValueChange: (value: string) => void): {
  draft: string
  onInput(value: string, isComposing: boolean): void
  onCompositionStart(): void
  onCompositionEnd(value: string): void
} {
  const [state, setState] = useState<ImeDraftState>(() => createImeDraft(value))
  const stateRef = useRef(state)
  const lastCommitRef = useRef(value)
  const transition = (event: ImeDraftEvent): void => {
    const next = reduceImeDraft(stateRef.current, event)
    stateRef.current = next
    setState(next)
    if (next.commit !== undefined && next.commit !== lastCommitRef.current) {
      lastCommitRef.current = next.commit
      onValueChange(next.commit)
    }
  }
  useEffect(() => {
    const next = reduceImeDraft(stateRef.current, { type: 'external', value })
    stateRef.current = next
    if (!next.composing) lastCommitRef.current = value
    setState(next)
  }, [value])
  return {
    draft: state.draft,
    onInput: (next, isComposing) => transition({ type: 'input', value: next, isComposing }),
    onCompositionStart: () => transition({ type: 'composition-start' }),
    onCompositionEnd: next => transition({ type: 'composition-end', value: next }),
  }
}

type ImeSafeTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'
> & {
  value: string
  onValueChange(value: string): void
}

function ImeSafeTextarea({ value, onValueChange, ...props }: ImeSafeTextareaProps): ReactNode {
  useLanguage()
  const ime = useImeSafeValue(value, onValueChange)
  return (
    <textarea
      {...props}
      value={ime.draft}
      onChange={event => ime.onInput(
        event.currentTarget.value,
        event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing,
      )}
      onCompositionStart={ime.onCompositionStart}
      onCompositionEnd={event => ime.onCompositionEnd(event.currentTarget.value)}
    />
  )
}

type ImeSafeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'
> & {
  value: string
  onValueChange(value: string): void
}

function ImeSafeInput({ value, onValueChange, ...props }: ImeSafeInputProps): ReactNode {
  useLanguage()
  const ime = useImeSafeValue(value, onValueChange)
  return (
    <input
      {...props}
      value={ime.draft}
      onChange={event => ime.onInput(
        event.currentTarget.value,
        event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing,
      )}
      onCompositionStart={ime.onCompositionStart}
      onCompositionEnd={event => ime.onCompositionEnd(event.currentTarget.value)}
    />
  )
}

const buttonStyle: CSSProperties = {
  border: `1px solid ${palette.border}`,
  borderRadius: 8,
  background: '#f8fafc',
  color: palette.ink,
  minHeight: 28,
  padding: '0 9px',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  color: palette.muted,
  fontSize: 10,
  letterSpacing: '.02em',
}

const WORKFLOW_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
])

function themeFor(kind: DirectorNodeData['kind']): NodeTheme {
  if (kind.startsWith('output-') || kind === 'preview' || kind === 'save') return NODE_THEMES.output
  if (kind === 'vram-trigger' || kind === 'ollama-eject' || kind === 'comfyui-clear') return NODE_THEMES.utility
  if (WORKFLOW_KINDS.has(kind)) return NODE_THEMES.workflow
  if (kind === 'load-sketch') return NODE_THEMES.sketch
  if (kind.includes('image')) return NODE_THEMES.image
  if (kind.includes('audio')) return NODE_THEMES.audio
  if (kind.includes('video')) return NODE_THEMES.video
  return NODE_THEMES.text
}

const ASPECTS = ['', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

function kindLabel(kind: DirectorNodeData['kind']): string {
  return ({
    'load-text': 'TEXT INPUT',
    'load-image': 'IMAGE INPUT',
    'load-audio': 'AUDIO INPUT',
    'load-video': 'VIDEO INPUT',
    'load-sketch': 'SKETCH INPUT',
    'prompt-enhancer': 'TEXT WORKFLOW',
    'image-generation': 'IMAGE WORKFLOW',
    'image-edit': 'IMAGE EDIT WORKFLOW',
    'video-generation': 'VIDEO WORKFLOW',
    'audio-generation': 'AUDIO WORKFLOW',
    'vram-trigger': 'VRAM TRIGGER',
    'ollama-eject': 'VRAM TRIGGER',
    'comfyui-clear': 'VRAM TRIGGER',
    'output-text': 'TEXT OUTPUT',
    'output-image': 'IMAGE OUTPUT',
    'output-audio': 'AUDIO OUTPUT',
    'output-video': 'VIDEO OUTPUT',
    'preview': 'OUTPUT PREVIEW',
    'save': 'SAVE OUTPUT',
  })[kind]
}

function mediaKind(data: DirectorNodeData): 'text' | 'image' | 'audio' | 'video' | 'sketch' | undefined {
  if (data.mediaKind === 'text' || data.mediaKind === 'image' || data.mediaKind === 'audio' || data.mediaKind === 'video' || data.mediaKind === 'sketch') {
    return data.mediaKind
  }
  if (data.kind.endsWith('text')) return 'text'
  if (data.kind.endsWith('image')) return 'image'
  if (data.kind.endsWith('audio')) return 'audio'
  if (data.kind.endsWith('video')) return 'video'
  if (data.kind === 'load-sketch') return 'sketch'
  return undefined
}

function requiredCapability(kind: DirectorNodeData['kind']): string | undefined {
  if (kind === 'prompt-enhancer') return 'text'
  if (kind === 'image-generation' || kind === 'image-edit') return 'image'
  if (kind === 'video-generation') return 'video'
  if (kind === 'audio-generation') return 'audio'
  return undefined
}

function providersFor(kind: DirectorNodeData['kind'], providers: ProviderDescriptor[]): ProviderDescriptor[] {
  const capability = requiredCapability(kind)
  if (capability === undefined) return providers
  return providers.filter(provider => {
    if (kind === 'prompt-enhancer' && (provider.kind === 'comfyui' || provider.kind === 'comfyui-mcp')) return false
    return provider.capabilities.includes(capability) || provider.capabilities.includes('workflow')
  })
}

function providerLabel(provider: ProviderDescriptor): string {
  return provider.kind === 'openai-compatible' ? 'OpenAI' : provider.label
}

function ModelActionButton(props: {
  action: 'refresh' | 'eject'
  label: string
  disabled: boolean
  busy?: boolean
  onClick(): void
}): ReactNode {
  useLanguage()
  return (
    <span className="vd-model-action">
      <button
        type="button"
        className={`nodrag nowheel vd-model-action-button${props.busy ? ' is-busy' : ''}`}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.action === 'refresh' ? (
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M19 8a7.5 7.5 0 1 0 .25 7.5M19 4v4h-4" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m12 5-6 9h12l-6-9ZM6 18h12" />
          </svg>
        )}
      </button>
      <span className="vd-model-action-tooltip" aria-hidden="true">{props.label}</span>
    </span>
  )
}

function numberValue(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stopWheel(event: React.WheelEvent): void {
  event.stopPropagation()
}

function StatusView(props: { data: DirectorNodeData }): ReactNode {
  useLanguage()
  const status = props.data.status ?? 'idle'
  const frozen = props.data.frozen === true
  const progress = Math.max(0, Math.min(1, props.data.progress ?? 0))
  const color = frozen
    ? '#2563eb'
    : status === 'failed'
    ? palette.danger
    : status === 'completed'
      ? palette.success
      : status === 'queued' || status === 'running'
        ? palette.accent
        : palette.muted
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color, fontSize: 10 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
        <span style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>{t(frozen ? 'FROZEN' : status)}</span>
        {!frozen && props.data.phase !== undefined && props.data.phase !== '' ? (
          <span style={{ color: palette.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t(props.data.phase)}
          </span>
        ) : null}
        {!frozen && (status === 'queued' || status === 'running') ? <span style={{ marginLeft: 'auto' }}>{Math.round(progress * 100)}%</span> : null}
      </div>
      {!frozen && (status === 'queued' || status === 'running') ? (
        <div style={{ height: 3, borderRadius: 99, overflow: 'hidden', background: 'rgba(15,23,42,.1)' }}>
          <div style={{ height: '100%', width: `${Math.max(3, progress * 100)}%`, borderRadius: 99, background: palette.accent, transition: 'width .2s ease' }} />
        </div>
      ) : null}
      {props.data.error !== undefined && props.data.error !== '' ? (
        <div title={props.data.error} style={{ color: palette.danger, fontSize: 10, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {props.data.error}
        </div>
      ) : null}
    </div>
  )
}

function JsonEditor<T>(props: {
  label: string
  value: T
  rows: number
  validate(value: unknown): value is T
  invalidMessage: string
  onApply(value: T): void
}): ReactNode {
  useLanguage()
  const encoded = useMemo(() => JSON.stringify(props.value, null, 2) ?? '', [props.value])
  const [draft, setDraft] = useState(encoded)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(encoded)
    setError(null)
  }, [encoded])

  const apply = (): void => {
    try {
      const parsed: unknown = JSON.parse(draft)
      if (!props.validate(parsed)) throw new Error(props.invalidMessage)
      props.onApply(parsed)
      setDraft(JSON.stringify(parsed, null, 2) ?? '')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <label style={labelStyle}>
      <span>{props.label}</span>
      <textarea
        className="nodrag nowheel"
        value={draft}
        rows={props.rows}
        spellCheck={false}
        onWheel={stopWheel}
        onChange={event => setDraft(event.target.value)}
        style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <span style={{ display: 'flex', alignItems: 'center', minHeight: 28, gap: 8 }}>
        <button type="button" className="nodrag" onClick={apply} style={buttonStyle}>{t("Apply JSON")}</button>
        {error !== null ? <span style={{ color: palette.danger, fontSize: 10, lineHeight: 1.3 }}>{error}</span> : null}
      </span>
    </label>
  )
}

function TextBody(props: { id: string; data: DirectorNodeData; runtime: DirectorRuntimeValue | null }): ReactNode {
  useLanguage()
  return (
    <ImeSafeTextarea
      className="nodrag nowheel"
      value={props.data.text ?? ''}
      rows={7}
      placeholder={t("Write or paste text…")}
      onWheel={stopWheel}
      onValueChange={value => props.runtime?.onChange(props.id, { text: value })}
      style={{ ...fieldStyle, resize: 'vertical', minHeight: 112, lineHeight: 1.5 }}
    />
  )
}

function MediaPreview(props: { data: DirectorNodeData; onDuration(duration: number): void; onEditSketch(): void }): ReactNode {
  useLanguage()
  const kind = mediaKind(props.data)
  const asset = props.data.asset
  if (asset === undefined) {
    return (
      <div style={{ minHeight: 90, borderRadius: 10, border: `1px dashed ${palette.border}`, display: 'grid', placeItems: 'center', color: palette.muted, fontSize: 11 }}>
        {t("No media attached")}
      </div>
    )
  }
  if (kind === 'sketch') {
    return (
      <button
        type="button"
        className="nodrag nowheel vd-sketch-edit-preview"
        aria-label={`Edit sketch ${asset.name}`}
        title={t("Edit sketch")}
        onClick={props.onEditSketch}
        onWheel={stopWheel}
      >
        <img src={asset.url} alt={asset.name} draggable={false} loading="lazy" />
        <span>{t("Edit sketch")}</span>
      </button>
    )
  }
  if (kind === 'image') {
    return (
      <div style={{ minHeight: 100, maxHeight: 230, border: `1px solid ${palette.subtleBorder}`, borderRadius: 10, overflow: 'hidden', background: '#f1f5f9', display: 'grid', placeItems: 'center' }}>
        <img src={asset.url} alt={asset.name} draggable={false} loading="lazy" style={{ display: 'block', maxWidth: '100%', maxHeight: 230, objectFit: 'contain' }} />
      </div>
    )
  }
  if (kind === 'audio') {
    return (
      <div className="nodrag nowheel" onWheel={stopWheel} style={{ padding: 10, border: `1px solid ${palette.subtleBorder}`, borderRadius: 10, background: '#f1f5f9' }}>
        <audio
          src={asset.url}
          controls
          preload="metadata"
          onLoadedMetadata={event => props.onDuration(event.currentTarget.duration)}
          style={{ display: 'block', width: '100%' }}
        />
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="nodrag nowheel" onWheel={stopWheel} style={{ minHeight: 120, maxHeight: 250, borderRadius: 10, overflow: 'hidden', background: '#080808', display: 'grid', placeItems: 'center' }}>
        <video
          src={asset.url}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={event => props.onDuration(event.currentTarget.duration)}
          style={{ display: 'block', width: '100%', maxHeight: 250, objectFit: 'contain' }}
        />
      </div>
    )
  }
  return null
}

function ReferenceAssetPreview(props: {
  asset: AssetRef
  kind: MediaKind
  label: string
}): ReactNode {
  useLanguage()
  if (props.kind === 'image' || props.kind === 'sketch' || props.kind === 'mask') {
    return <img src={props.asset.url} alt={props.label} draggable={false} loading="lazy" />
  }
  if (props.kind === 'audio') {
    return <audio className="nodrag nowheel" src={props.asset.url} controls preload="metadata" onWheel={stopWheel} />
  }
  if (props.kind === 'video') {
    return <video className="nodrag nowheel" src={props.asset.url} controls playsInline preload="metadata" onWheel={stopWheel} />
  }
  return null
}

function ReferenceThumbnail(props: {
  reference: DirectorReferencePreview
}): ReactNode {
  useLanguage()
  const { reference } = props
  if (reference.asset !== undefined && (reference.kind === 'image' || reference.kind === 'sketch' || reference.kind === 'mask')) {
    return <img src={reference.asset.url} alt="" draggable={false} loading="lazy" />
  }
  if (reference.asset !== undefined && reference.kind === 'video') {
    return <video src={reference.asset.url} aria-hidden="true" muted playsInline preload="metadata" />
  }
  if (reference.kind === 'text') {
    return (
      <span className="vd-prompt-reference-text-thumbnail" aria-hidden="true">
        {reference.text?.trim() || 'No text content'}
      </span>
    )
  }
  return (
    <span className="vd-prompt-reference-kind-thumbnail" aria-hidden="true">
      <strong>{reference.kind === 'audio' ? '♫' : '?'}</strong>
      <small>{reference.kind}</small>
    </span>
  )
}

function ReferencePreviewDialog(props: {
  reference: DirectorReferencePreview
  index: number
  label?: string
  onClose(): void
}): ReactNode {
  useLanguage()
  const label = props.label ?? `Reference ${String(props.index + 1)}`
  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [props.onClose])

  return createPortal(
    <div
      className="vd-reference-dialog-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        className="vd-reference-dialog nodrag nowheel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vd-reference-dialog-title"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onWheel={stopWheel}
      >
        <header>
          <div>
            <strong id="vd-reference-dialog-title">{label}</strong>
            <span>{props.reference.kind}</span>
          </div>
          <button type="button" aria-label={`Close ${label} preview`} title={t("Close")} onClick={props.onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </header>
        <div className={`vd-reference-dialog-content is-${props.reference.kind}`}>
          {props.reference.asset !== undefined ? (
            <ReferenceAssetPreview asset={props.reference.asset} kind={props.reference.kind} label={label} />
          ) : props.reference.kind === 'text' ? (
            <p>{props.reference.text?.trim() || 'No text content'}</p>
          ) : (
            <p>{t("No preview available")}</p>
          )}
        </div>
        <footer title={props.reference.sourceTitle}>{props.reference.sourceTitle}</footer>
      </section>
    </div>,
    document.body,
  )
}

function SystemPromptEditorDialog(props: {
  value: string
  onClose(): void
  onSave(value: string): void
}): ReactNode {
  useLanguage()
  const [history, setHistory] = useState(() => [props.value])
  const [historyIndex, setHistoryIndex] = useState(0)
  const draft = history[historyIndex] ?? props.value
  const canUndo = historyIndex > 0
  const canRedo = historyIndex < history.length - 1

  const replaceDraft = (value: string): void => {
    if (value === draft) return
    setHistory([...history.slice(0, historyIndex + 1), value])
    setHistoryIndex(historyIndex + 1)
  }
  const undo = (): void => setHistoryIndex(index => Math.max(0, index - 1))
  const redo = (): void => setHistoryIndex(index => Math.min(history.length - 1, index + 1))

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [props.onClose])

  return createPortal(
    <div
      className="vd-system-prompt-editor-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        className="vd-system-prompt-editor nodrag nowheel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vd-system-prompt-editor-title"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onWheel={stopWheel}
      >
        <header>
          <div>
            <strong id="vd-system-prompt-editor-title">{t("System Prompt")}</strong>
            <span>{t("Markdown editor")}</span>
          </div>
          <button type="button" className="vd-system-prompt-editor-close" aria-label={t("Close system prompt editor")} title={t("Close")} onClick={props.onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </header>
        <div className="vd-system-prompt-editor-toolbar">
          <button type="button" onClick={() => replaceDraft(DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT)} disabled={draft === DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT}>{t("Reset")}</button>
          <span aria-hidden="true" />
          <button type="button" onClick={undo} disabled={!canUndo}>{t("Undo")}</button>
          <button type="button" onClick={redo} disabled={!canRedo}>{t("Redo")}</button>
          <small>{draft.length.toLocaleString()} {t("characters")}</small>
        </div>
        <textarea
          autoFocus
          aria-label={t("System Prompt Markdown editor")}
          spellCheck={false}
          value={draft}
          onChange={event => replaceDraft(event.target.value)}
          onKeyDown={event => {
            const modifier = event.metaKey || event.ctrlKey
            if (modifier && event.key.toLowerCase() === 'z') {
              event.preventDefault()
              if (event.shiftKey) redo()
              else undo()
            } else if (modifier && event.key.toLowerCase() === 'y') {
              event.preventDefault()
              redo()
            }
          }}
        />
        <footer>
          <span>{draft === props.value ? t("No unsaved changes") : 'Unsaved changes'}</span>
          <button type="button" onClick={() => props.onSave(draft)}>{t("Save")}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function VideoSizeReferenceDialog(props: { onClose(): void }): ReactNode {
  useLanguage()
  return createPortal(
    <div
      className="vd-system-prompt-editor-backdrop"
      role="presentation"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        className="vd-size-reference-dialog nodrag nowheel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vd-size-reference-title"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onWheel={stopWheel}
      >
        <header>
          <div>
            <strong id="vd-size-reference-title">{t("Note: Size Settings Reference")}</strong>
            <span>{t("Read only · source workflow table")}</span>
          </div>
          <button type="button" className="vd-system-prompt-editor-close" aria-label={t("Close size settings reference")} title={t("Close")} onClick={props.onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </header>
        <div className="vd-size-reference-table-wrap">
          <table>
            <thead>
              <tr><th>{t("megapixels")}</th><th>{t("Aspect")}</th><th>{t("Output (multiple=32)")}</th></tr>
            </thead>
            <tbody>
              {VIDEO_SIZE_REFERENCE.map(([megapixels, aspect, output]) => (
                <tr key={megapixels}><td>{megapixels}</td><td>{aspect}</td><td>{output}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function PromptReferencesPanel(props: {
  references: readonly DirectorReferencePreview[]
  referencePort?: VdPortDescriptor
  inputPorts: readonly VdPortDescriptor[]
}): ReactNode {
  useLanguage()
  const [openReferenceId, setOpenReferenceId] = useState<string | null>(null)
  const labels = referenceLabelsByKind(props.references)
  const openReferenceIndex = props.references.findIndex(reference => reference.edgeId === openReferenceId)
  const openReference = openReferenceIndex < 0 ? undefined : props.references[openReferenceIndex]
  return (
    <>
      <section className="vd-prompt-references nodrag nowheel" aria-label={t("References")} onWheel={stopWheel}>
        {props.referencePort === undefined ? null : (
          <PromptReferenceHandle port={props.referencePort} ports={props.inputPorts} top={16} />
        )}
        <header>
          <strong>{t("References")}</strong>
          <span>{String(props.references.length)}</span>
        </header>
        {props.references.length === 0 ? (
          <div className="vd-prompt-references-empty">{t("No references connected")}</div>
        ) : (
          <div className="vd-prompt-reference-list">
            {props.references.map((reference, index) => {
              const label = labels[index]
              return (
                <button
                  key={reference.edgeId}
                  type="button"
                  className="vd-prompt-reference-thumbnail nodrag"
                  aria-label={`Preview ${label}`}
                  title={`${label} · ${reference.sourceTitle}`}
                  onClick={() => setOpenReferenceId(reference.edgeId)}
                >
                  <span className={`vd-prompt-reference-thumbnail-media is-${reference.kind}`}>
                    <ReferenceThumbnail reference={reference} />
                  </span>
                  <strong>{label}</strong>
                </button>
              )
            })}
          </div>
        )}
      </section>
      {openReference === undefined ? null : (
        <ReferencePreviewDialog
          reference={openReference}
          index={openReferenceIndex}
          label={labels[openReferenceIndex]}
          onClose={() => setOpenReferenceId(null)}
        />
      )}
    </>
  )
}

function TrimFields(props: { id: string; data: DirectorNodeData; duration?: number; runtime: DirectorRuntimeValue | null }): ReactNode {
  useLanguage()
  const start = props.data.trim?.start ?? 0
  const end = props.data.trim?.end
  const update = (patch: Partial<NonNullable<DirectorNodeData['trim']>>): void => {
    props.runtime?.onChange(props.id, { trim: { start, ...props.data.trim, ...patch } })
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <label style={labelStyle}>
        <span>{t("Trim start · sec")}</span>
        <input
          className="nodrag nowheel"
          type="number"
          min={0}
          max={end ?? props.duration}
          step="0.01"
          value={start}
          onWheel={stopWheel}
          onChange={event => update({ start: Math.max(0, numberValue(event.target.value) ?? 0) })}
          style={fieldStyle}
        />
      </label>
      <label style={labelStyle}>
        <span>{t("Trim end · sec")}{props.duration === undefined ? '' : ` / ${props.duration.toFixed(2)}`}</span>
        <input
          className="nodrag nowheel"
          type="number"
          min={start}
          max={props.duration}
          step="0.01"
          value={end ?? ''}
          placeholder={props.duration === undefined ? 'Full length' : props.duration.toFixed(2)}
          onWheel={stopWheel}
          onChange={event => update({ end: numberValue(event.target.value) })}
          style={fieldStyle}
        />
      </label>
    </div>
  )
}

function TransformFields(props: { id: string; data: DirectorNodeData; runtime: DirectorRuntimeValue | null }): ReactNode {
  useLanguage()
  const transform = props.data.transform ?? {}
  const update = (patch: NonNullable<DirectorNodeData['transform']>): void => {
    props.runtime?.onChange(props.id, { transform: { ...transform, ...patch } })
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr .9fr .9fr', gap: 8 }}>
      <label style={labelStyle}>
        <span>{t("Aspect")}</span>
        <select
          className="nodrag"
          value={transform.aspectRatio ?? ''}
          onChange={event => update({ aspectRatio: event.target.value || undefined })}
          style={fieldStyle}
        >
          {ASPECTS.map(aspect => <option key={aspect || 'source'} value={aspect}>{aspect || 'Source'}</option>)}
        </select>
      </label>
      <label style={labelStyle}>
        <span>{t("Width")}</span>
        <input className="nodrag nowheel" type="number" min={1} value={transform.width ?? ''} placeholder={t("auto")} onWheel={stopWheel} onChange={event => update({ width: numberValue(event.target.value) })} style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        <span>{t("Height")}</span>
        <input className="nodrag nowheel" type="number" min={1} value={transform.height ?? ''} placeholder={t("auto")} onWheel={stopWheel} onChange={event => update({ height: numberValue(event.target.value) })} style={fieldStyle} />
      </label>
    </div>
  )
}

function MediaBody(props: { id: string; data: DirectorNodeData; runtime: DirectorRuntimeValue | null }): ReactNode {
  useLanguage()
  const kind = mediaKind(props.data)
  const [duration, setDuration] = useState<number | undefined>(undefined)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <MediaPreview
        data={props.data}
        onDuration={value => setDuration(Number.isFinite(value) ? value : undefined)}
        onEditSketch={() => props.runtime?.onEditSketch(props.id)}
      />
      {props.data.asset !== undefined ? (
        <div title={props.data.asset.name} style={{ display: 'flex', alignItems: 'center', gap: 7, color: palette.muted, fontSize: 10, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.data.asset.name}</span>
          <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}>{Math.max(1, Math.round(props.data.asset.size / 1024))} KB</span>
        </div>
      ) : null}
      {(kind === 'audio' || kind === 'video') ? <TrimFields id={props.id} data={props.data} duration={duration} runtime={props.runtime} /> : null}
      {(kind === 'image' || kind === 'video') ? <TransformFields id={props.id} data={props.data} runtime={props.runtime} /> : null}
      {props.data.maskAsset !== undefined ? <span style={{ alignSelf: 'flex-end', color: palette.accent, fontSize: 10 }}>{t("MASK ATTACHED")}</span> : null}
    </div>
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBindings(value: unknown): value is ComfyWorkflowBinding[] {
  return Array.isArray(value) && value.every(item => isObject(item)
    && typeof item.nodeId === 'string'
    && typeof item.input === 'string'
    && typeof item.from === 'string')
}

function hasTurboTopology(workflow: Record<string, unknown> | undefined): boolean {
  if (workflow === undefined) return false
  return Object.values(workflow).some(node => isObject(node)
    && (node.class_type === 'MiniMaxH3TurboLoRA' || node.class_type === 'MiniMaxH3TurboSampler'))
}

function usesComfyWorkflowRegistry(provider: ProviderDescriptor | undefined): boolean {
  return provider?.kind === 'comfyui' || provider?.kind === 'comfyui-mcp'
}

function comfyWorkflowMatchesVdNode(workflow: ComfyWorkflowDescriptor, kind: DirectorNodeData['kind']): boolean {
  if (kind === 'image-generation' || kind === 'image-edit') {
    return workflow.kind === 'image-generation' || workflow.kind === 'image-edit'
  }
  return workflow.kind === kind
}

function parameterValue(data: DirectorNodeData, parameter: ComfyWorkflowParameter): string | number | boolean {
  return data.workflowValues?.[parameter.id] ?? parameter.default
}

function ParameterInputPlaceholder(props: {
  label: string
  fieldId: string
  inputPorts: readonly VdPortDescriptor[]
}): ReactNode {
  useLanguage()
  const port = props.inputPorts.find(candidate => candidate.id === fieldInputPortId(props.fieldId))
  return (
    <div
      className="vd-field-input-placeholder nodrag"
      role="group"
      aria-label={t("{0} 文本输入端口", props.label)}
    >
      {port === undefined ? null : <PromptReferenceHandle port={port} ports={props.inputPorts} top="50%" />}
      <span className="vd-field-input-placeholder-heading">
        <strong>{props.label}</strong>
        <small>{t("INPUT · TEXT")}</small>
      </span>
      <span className="vd-field-input-placeholder-copy">
        <span aria-hidden>◉</span>
        <span>{t("由上游文本驱动")}</span>
      </span>
      <small>{t("未连接时使用当前值；连接后由上游覆盖。")}</small>
    </div>
  )
}

function discoveredModelChoices(
  provider: ProviderDescriptor | undefined,
  workflowId: string,
  parameterId: string,
): string[] | undefined {
  if (provider?.kind !== 'comfyui' && provider?.kind !== 'comfyui-mcp') return undefined
  return provider.workflowModels?.find(candidate => (
    candidate.workflowId === workflowId && candidate.parameterId === parameterId
  ))?.models
}

function ComfyWorkflowParameterField(props: {
  id: string
  data: DirectorNodeData
  parameter: ComfyWorkflowParameter
  runtime: DirectorRuntimeValue | null
  inputPorts: readonly VdPortDescriptor[]
  choices?: string[]
}): ReactNode {
  useLanguage()
  const value = parameterValue(props.data, props.parameter)
  const update = (next: string | number | boolean): void => {
    props.runtime?.onChange(props.id, {
      workflowValues: { ...props.data.workflowValues, [props.parameter.id]: next },
    })
  }

  if (props.parameter.type === 'text' && fieldInputModeEnabled(props.data, props.parameter.id)) {
    return <ParameterInputPlaceholder label={props.parameter.label} fieldId={props.parameter.id} inputPorts={props.inputPorts} />
  }

  if (props.parameter.type === 'boolean') {
    return (
      <label title={props.parameter.label} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: palette.secondary, fontSize: 10 }}>
        <input
          className="nodrag"
          type="checkbox"
          checked={value === true}
          onChange={event => update(event.target.checked)}
          style={{ accentColor: palette.accent }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.parameter.label}</span>
      </label>
    )
  }

  const current = String(value)
  const choicePresentation = modelChoicePresentation(props.choices, props.parameter.choices, current)
  if (choicePresentation !== undefined) {
    const { choices } = choicePresentation
    return (
      <label title={props.parameter.description || props.parameter.label} style={labelStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.parameter.label}</span>
        <select className="nodrag" value={current} disabled={choicePresentation.disabled} onChange={event => update(event.target.value)} style={fieldStyle}>
          {choicePresentation.currentUnavailable ? <option value={current}>{current} {t("· workflow default（API 未返回）")}</option> : null}
          {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
    )
  }

  if (props.parameter.control === 'textarea') {
    return (
      <label title={props.parameter.description || props.parameter.label} style={labelStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.parameter.label}</span>
        <ImeSafeTextarea
          className="nodrag nowheel"
          value={String(value)}
          rows={3}
          placeholder={props.parameter.id === 'prompt' ? t(PROMPT_PLACEHOLDER) : undefined}
          onWheel={stopWheel}
          onValueChange={update}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </label>
    )
  }

  return (
    <label title={props.parameter.label} style={labelStyle}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.parameter.label}</span>
      {props.parameter.type === 'number' ? <input
        className="nodrag nowheel"
        type="number"
        value={value as string | number}
        onWheel={stopWheel}
        onChange={event => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) update(next)
        }}
        style={fieldStyle}
      /> : <ImeSafeInput
        className="nodrag nowheel"
        type="text"
        value={String(value)}
        placeholder={props.parameter.id === 'prompt' ? t(PROMPT_PLACEHOLDER) : undefined}
        onWheel={stopWheel}
        onValueChange={update}
        style={fieldStyle}
      />}
    </label>
  )
}

function ComfyWorkflowParameters(props: {
  id: string
  data: DirectorNodeData
  workflow: ComfyWorkflowDescriptor
  runtime: DirectorRuntimeValue | null
  inputPorts: readonly VdPortDescriptor[]
  placement: 'primary' | 'advanced'
  provider?: ProviderDescriptor
}): ReactNode {
  useLanguage()
  const groups = useMemo(() => {
    const grouped = new Map<string, ComfyWorkflowParameter[]>()
    const parameters = props.workflow.parameters
      .filter(parameter => (parameter.placement ?? 'advanced') === props.placement)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    for (const parameter of parameters) {
      const group = parameter.group.trim() || 'Parameters'
      grouped.set(group, [...(grouped.get(group) ?? []), parameter])
    }
    return [...grouped.entries()]
  }, [props.placement, props.workflow])

  if (groups.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ color: palette.secondary, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{props.placement === 'primary' ? t("Main parameters") : 'Workflow parameters'}</span>
      {groups.map(([group, parameters]) => (
        <fieldset key={group} style={{ display: 'grid', gridTemplateColumns: parameters.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
          <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{group}</legend>
          {parameters.map(parameter => (
            <ComfyWorkflowParameterField
              key={parameter.id}
              id={props.id}
              data={props.data}
              parameter={parameter}
              runtime={props.runtime}
              inputPorts={props.inputPorts}
              choices={discoveredModelChoices(props.provider, props.workflow.id, parameter.id)}
            />
          ))}
        </fieldset>
      ))}
    </div>
  )
}

const NODE_DATA_FIELD_IDS = new Set([
  'prompt', 'negativePrompt', 'seed', 'width', 'height', 'duration', 'fps',
  'steps', 'scheduler', 'variant', 'includeAudio',
])

function DefinitionField(props: {
  id: string
  data: DirectorNodeData
  field: VdFieldDescriptor
  runtime: DirectorRuntimeValue | null
  inputPorts: readonly VdPortDescriptor[]
  choices?: string[]
}): ReactNode {
  useLanguage()
  const stored = NODE_DATA_FIELD_IDS.has(props.field.id)
    ? props.data[props.field.id]
    : props.data.workflowValues?.[props.field.id]
  const value = (stored ?? props.field.default) as string | number | boolean
  const update = (next: string | number | boolean): void => {
    if (NODE_DATA_FIELD_IDS.has(props.field.id)) {
      props.runtime?.onChange(props.id, { [props.field.id]: next } as Partial<DirectorNodeData>)
    } else {
      props.runtime?.onChange(props.id, { workflowValues: { ...props.data.workflowValues, [props.field.id]: next } })
    }
  }
  if (props.field.type === 'text' && fieldInputModeEnabled(props.data, props.field.id)) {
    return <ParameterInputPlaceholder label={props.field.label} fieldId={props.field.id} inputPorts={props.inputPorts} />
  }
  if (props.field.type === 'boolean') {
    return (
      <label title={props.field.description || props.field.label} style={{ display: 'flex', alignItems: 'center', gap: 7, color: palette.secondary, fontSize: 10 }}>
        <input className="nodrag" type="checkbox" checked={value === true} onChange={event => update(event.target.checked)} />
        {props.field.label}
      </label>
    )
  }
  const current = String(value)
  const choicePresentation = modelChoicePresentation(props.choices, props.field.choices, current)
  if (choicePresentation !== undefined) {
    const { choices } = choicePresentation
    return (
      <label title={props.field.description || props.field.label} style={labelStyle}>
        <span>{props.field.label}</span>
        <select className="nodrag" value={current} disabled={choicePresentation.disabled} onChange={event => update(event.target.value)} style={fieldStyle}>
          {choicePresentation.currentUnavailable ? <option value={current}>{current} {t("· workflow default（API 未返回）")}</option> : null}
          {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
    )
  }
  if (props.field.control === 'textarea') {
    return (
      <label title={props.field.description || props.field.label} style={labelStyle}>
        <span>{props.field.label}</span>
        <ImeSafeTextarea
          className="nodrag nowheel"
          value={String(value)}
          rows={props.field.id === 'prompt' ? 4 : 2}
          placeholder={props.field.id === 'prompt' ? t(PROMPT_PLACEHOLDER) : undefined}
          onWheel={stopWheel}
          onValueChange={update}
          style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.45 }}
        />
      </label>
    )
  }
  return (
    <label title={props.field.description || props.field.label} style={labelStyle}>
      <span>{props.field.label}</span>
      {props.field.type === 'number' ? <input
        className="nodrag nowheel"
        type={props.field.control === 'slider' ? 'range' : 'number'}
        value={value as string | number}
        min={props.field.min}
        max={props.field.max}
        step={props.field.step ?? (props.field.integer === true ? 1 : 'any')}
        onWheel={stopWheel}
        onChange={event => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) update(next)
        }}
        style={fieldStyle}
      /> : <ImeSafeInput
        className="nodrag nowheel"
        type="text"
        value={String(value)}
        minLength={props.field.minLength}
        maxLength={props.field.maxLength}
        placeholder={props.field.id === 'prompt' ? t(PROMPT_PLACEHOLDER) : undefined}
        onWheel={stopWheel}
        onValueChange={update}
        style={fieldStyle}
      />}
    </label>
  )
}

function DefinitionFields(props: {
  id: string
  data: DirectorNodeData
  definition: VdNodeDefinitionDescriptor
  placement: 'primary' | 'advanced'
  runtime: DirectorRuntimeValue | null
  inputPorts: readonly VdPortDescriptor[]
  provider?: ProviderDescriptor
  workflow?: ComfyWorkflowDescriptor
}): ReactNode {
  useLanguage()
  const fields = props.definition.fields
    .filter(field => field.placement === props.placement)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  if (fields.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 9 }}>
      {fields.map(field => (
        <DefinitionField
          key={field.id}
          id={props.id}
          data={props.data}
          field={field}
          runtime={props.runtime}
          inputPorts={props.inputPorts}
          choices={props.workflow === undefined ? undefined : discoveredModelChoices(props.provider, props.workflow.id, field.id)}
        />
      ))}
    </div>
  )
}

function GenerationNodeBody(props: {
  id: string
  data: DirectorNodeData
  runtime: DirectorRuntimeValue | null
  inputPorts: readonly VdPortDescriptor[]
  referencePort?: VdPortDescriptor
}): ReactNode {
  useLanguage()
  const [systemPromptEditorOpen, setSystemPromptEditorOpen] = useState(false)
  const [sizeReferenceOpen, setSizeReferenceOpen] = useState(false)
  const textWorkflow = props.data.kind === 'prompt-enhancer'
  const imageWorkflow = props.data.kind === 'image-generation' || props.data.kind === 'image-edit'
  const videoWorkflow = props.data.kind === 'video-generation'
  const audioWorkflow = props.data.kind === 'audio-generation'
  const referencePanelWorkflow = shouldShowReferencePanel(props.data.kind, props.referencePort)
  const available = providersFor(props.data.kind, props.runtime?.providers ?? [])
  const selectedProviderId = textWorkflow ? (props.data.providerId || 'ollama') : props.data.providerId
  const provider = props.runtime?.providers.find(item => item.id === selectedProviderId)
  const registryProvider = usesComfyWorkflowRegistry(provider)
  const workflows = (props.runtime?.workflows ?? []).filter(workflow => comfyWorkflowMatchesVdNode(workflow, props.data.kind))
  const definition = props.runtime?.nodeDefinitions.find(candidate => (
    candidate.type === props.data.nodeType && candidate.version === (props.data.nodeVersion ?? '1.0.0')
  ))
  const selectedWorkflow = workflows.find(workflow => workflow.id === (definition?.workflowId ?? props.data.workflowId))
  const pinnedWorkflow = definition?.behavior === 'workflow'
  const legacyInlineWorkflow = props.data.workflowId === undefined && props.data.workflow !== undefined
  const h3 = props.data.modelFamily === 'minimax-h3'
  const turboTopology = h3 && (hasTurboTopology(props.data.workflow) || selectedWorkflow?.defaults.variant === 'turbo')
  const h3Locked = h3 && provider?.minimaxH3Unlocked !== true
  const dimensioned = props.data.kind === 'image-generation' || props.data.kind === 'image-edit' || props.data.kind === 'video-generation' || props.data.kind === 'audio-generation'
  const timed = props.data.kind === 'video-generation' || props.data.kind === 'audio-generation'
  const modelPlaceholder = provider?.imageModel ?? provider?.model ?? (h3 ? 'minimax-h3' : 'model or family')
  const legacyModelId = props.data.modelFamily === 'minimax-h3' ? undefined : props.data.modelFamily
  const selectedModelId = props.data.modelId ?? legacyModelId ?? ''
  const needsImageInput = imageWorkflow || (props.runtime?.references[props.id] ?? []).some(reference => ['image', 'sketch', 'mask'].includes(reference.kind))
  const availableModels = (provider?.availableModels ?? []).filter(id => provider?.kind !== 'codex-plan' || !needsImageInput
    || provider.codexModels?.find(model => model.id === id)?.inputModalities.includes('image') !== false)
  const effectiveModelId = provider?.kind === 'ollama'
    ? effectiveOllamaModel(availableModels, provider.model, props.data.modelId) ?? ''
    : provider?.kind === 'codex-plan'
      ? codexModelForNode(props.data, provider) ?? ''
      : selectedModelId
  const selectedModelDetails = provider?.modelDetails?.find(details => details.id === effectiveModelId)
  const thinkingSupported = ollamaModelSupports(provider?.modelDetails, effectiveModelId || undefined, 'thinking')
  const modelDiscoveryLoading = provider?.modelDiscovery?.state === 'loading'
  const selectedModelLoaded = effectiveModelId !== '' && provider?.loadedModels?.includes(effectiveModelId) === true
  const effectiveSystemPrompt = props.data.systemPrompt ?? DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT
  const workflowAdvancedCount = pinnedWorkflow && definition !== undefined
    ? definition.fields.filter(field => field.placement === 'advanced').length
    : (selectedWorkflow?.parameters.filter(parameter => (parameter.placement ?? 'advanced') === 'advanced').length ?? 0)
  const registeredWorkflow = registryProvider && selectedWorkflow !== undefined
  const registeredImageWorkflow = imageWorkflow && registeredWorkflow
  const textImageVideoWorkflow = videoWorkflow
    && registeredWorkflow
    && selectedWorkflow.id === H3_TEXT_IMAGE_VIDEO_WORKFLOW_ID
  const referenceVideoWorkflow = videoWorkflow
    && registeredWorkflow
    && selectedWorkflow.id === H3_REFERENCE_VIDEO_WORKFLOW_ID
  const registeredVideoWorkflow = textImageVideoWorkflow || referenceVideoWorkflow
  const registeredAudioWorkflow = audioWorkflow && registeredWorkflow
  const registeredImageDimensions = registeredImageWorkflow
    && selectedWorkflow?.defaults.width !== undefined
    && selectedWorkflow.defaults.height !== undefined
  const registrySpecificControls = registeredImageWorkflow || registeredVideoWorkflow || registeredAudioWorkflow
  const workflowSeedControls = registeredWorkflow && selectedWorkflow.defaults.seedControlAfterGenerate !== undefined
  const audioPrimaryParameters = registeredAudioWorkflow
    ? selectedWorkflow.parameters
      .filter(parameter => (parameter.placement ?? 'advanced') === 'primary')
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    : []
  const videoPrimaryParameters = registeredVideoWorkflow
    ? selectedWorkflow.parameters
      .filter(parameter => (parameter.placement ?? 'advanced') === 'primary')
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    : []
  const videoAspectRatioParameter = videoPrimaryParameters.find(parameter => parameter.id === 'aspectRatio')
  const videoMegapixelsParameter = videoPrimaryParameters.find(parameter => parameter.id === 'megapixels')
  const videoReferences = props.runtime?.references[props.id] ?? []
  const advancedCount = workflowAdvancedCount
    + (workflowSeedControls ? 2 : 0)
    + (registeredAudioWorkflow ? 1 : 0)
    + (registeredVideoWorkflow ? 1 : 0)
    + (textWorkflow ? 1 : 0)
    + (provider?.kind === 'ollama' ? 2 : 0)
  const imageModeVisible = props.data.kind === 'image-generation' && !registryProvider
  const ollamaTextWorkflow = textWorkflow && provider?.kind === 'ollama'
  const registryMediaWorkflow = imageWorkflow || videoWorkflow || audioWorkflow

  const chooseWorkflow = (workflowId: string): void => {
    if (workflowId === '') {
      props.runtime?.onChange(props.id, {
        workflowId: undefined,
        workflowValues: undefined,
        modelFamily: undefined,
      })
      return
    }
    const workflow = workflows.find(candidate => candidate.id === workflowId)
    if (workflow === undefined) return
    props.runtime?.onChange(props.id, {
      ...workflow.defaults,
      kind: workflow.kind,
      workflowId: workflow.id,
      modelFamily: workflow.modelFamily ?? workflow.defaults.modelFamily,
      videoMode: workflow.kind === 'video-generation' && workflow.id === H3_TEXT_IMAGE_VIDEO_WORKFLOW_ID
        ? (workflow.defaults.videoMode ?? 'text-to-video')
        : undefined,
      workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
      workflow: undefined,
      bindings: undefined,
    })
  }

  useEffect(() => {
    if (!registryMediaWorkflow || !registryProvider || pinnedWorkflow || selectedWorkflow !== undefined) return
    if (workflows.length > 0) chooseWorkflow(workflows[0].id)
  }, [pinnedWorkflow, props.data.workflowId, provider?.id, registryMediaWorkflow, selectedWorkflow?.id, workflows.length])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: textWorkflow
        ? ollamaTextWorkflow
          ? 'minmax(0, .64fr) minmax(0, 1.36fr) 28px 28px'
          : 'minmax(0, .64fr) minmax(0, 1.36fr) 28px'
        : props.data.kind === 'image-generation' && imageModeVisible
          ? `minmax(105px, .72fr) minmax(0, 1fr) minmax(70px, .46fr)${provider?.kind === 'codex-plan' ? ' 28px' : ''}`
          : `minmax(105px, .62fr) minmax(0, 1.38fr)${imageWorkflow && provider?.kind === 'codex-plan' ? ' 28px' : ''}`, gap: textWorkflow ? 6 : 8 }}>
        <label style={labelStyle}>
          <span>{t("Provider")}</span>
          <select
            className="nodrag"
            value={selectedProviderId ?? ''}
            onChange={event => {
              const providerId = event.target.value || undefined
              const nextProvider = props.runtime?.providers.find(item => item.id === providerId)
              const workflow = registryMediaWorkflow && usesComfyWorkflowRegistry(nextProvider) && workflows.length === 1
                ? workflows[0]
                : undefined
              props.runtime?.onChange(props.id, workflow === undefined ? {
                providerId,
                modelId: undefined,
              } : {
                providerId,
                modelId: undefined,
                ...workflow.defaults,
                kind: workflow.kind,
                workflowId: workflow.id,
                modelFamily: workflow.modelFamily ?? workflow.defaults.modelFamily,
                workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
                workflow: undefined,
                bindings: undefined,
              })
            }}
            style={fieldStyle}
          >
            {available.map(item => (
              <option key={item.id} value={item.id} disabled={!item.configured}>
                {providerLabel(item)}{item.configured ? '' : ' · not configured'}
              </option>
            ))}
          </select>
        </label>
        {registryProvider && !pinnedWorkflow ? (
          <label style={labelStyle}>
            <span>{t("Workflow")}</span>
            <select
              className="nodrag"
              value={registryMediaWorkflow
                ? (props.data.workflowId ?? workflows[0]?.id ?? '')
                : legacyInlineWorkflow ? '__legacy-inline__' : (props.data.workflowId ?? '')}
              onChange={event => {
                if (event.target.value !== '__legacy-inline__') chooseWorkflow(event.target.value)
              }}
              style={fieldStyle}
            >
              {registryMediaWorkflow ? null : <option value="">{t("Select workflow")}</option>}
              {!registryMediaWorkflow && legacyInlineWorkflow ? <option value="__legacy-inline__">{t("Legacy inline workflow")}</option> : null}
              {props.data.workflowId !== undefined && selectedWorkflow === undefined ? (
                <option value={props.data.workflowId}>{t("Missing workflow ·")} {props.data.workflowId}</option>
              ) : null}
              {workflows.length === 0 ? <option value="" disabled>{t("No compatible workflows")}</option> : null}
              {workflows.map(workflow => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}{registryMediaWorkflow ? '' : `${workflow.kind === 'image-edit' ? ' · image edit' : ''}${workflow.builtIn ? ' · built-in' : ''}`}
                </option>
              ))}
            </select>
          </label>
        ) : pinnedWorkflow ? (
          <label style={labelStyle}>
            <span>{t("Custom Node")}</span>
            <div style={{ ...fieldStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: '#f8fafc' }} title={`${definition?.type ?? ''}@${definition?.version ?? ''}`}>
              {definition?.title ?? props.data.title}
            </div>
          </label>
        ) : provider?.kind === 'ollama' || provider?.kind === 'codex-plan' ? (
          <label style={labelStyle}>
            <span>{t("Model")}</span>
            <select
              className="nodrag"
              value={effectiveModelId}
              disabled={availableModels.length === 0}
              onChange={event => props.runtime?.onChange(props.id, {
                modelId: event.target.value || undefined,
                modelFamily: undefined,
              })}
              style={fieldStyle}
            >
              {effectiveModelId !== '' && !availableModels.includes(effectiveModelId) ? <option value={effectiveModelId} disabled>{effectiveModelId} · {t("Unavailable")}</option> : null}
              {effectiveModelId === '' ? (
                <option value="">{provider.modelDiscovery?.state === 'loading' ? t("Loading models…") : t("No available models")}</option>
              ) : null}
              {availableModels.map(model => <option key={model} value={model}>{provider.codexModels?.find(candidate => candidate.id === model)?.displayName ?? model}</option>)}
            </select>
          </label>
        ) : (
          <label style={labelStyle}>
            <span>{t("Model")}</span>
            <input
              className="nodrag"
              value={selectedModelId}
              placeholder={modelPlaceholder}
              onChange={event => props.runtime?.onChange(props.id, {
                modelId: event.target.value || undefined,
                modelFamily: undefined,
              })}
              style={fieldStyle}
            />
          </label>
        )}
        {imageModeVisible ? (
          <label style={labelStyle}>
            <span>{t("Mode")}</span>
            <select
              className="nodrag"
              aria-label={t("Image mode")}
              value={props.data.imageMode ?? 'generate'}
              onChange={event => props.runtime?.onChange(props.id, {
                imageMode: event.target.value === 'edit' ? 'edit' : 'generate',
              })}
              style={fieldStyle}
            >
              <option value="generate">{t("Gen")}</option>
              <option value="edit">{t("Edit")}</option>
            </select>
          </label>
        ) : null}
        {textWorkflow || (imageWorkflow && provider?.kind === 'codex-plan') ? (
          <ModelActionButton
            action="refresh"
            label={modelDiscoveryLoading ? t('Refreshing models…') : t('Refresh models')}
            disabled={(provider?.kind !== 'ollama' && provider?.kind !== 'codex-plan') || provider.configured === false || modelDiscoveryLoading}
            busy={modelDiscoveryLoading}
            onClick={() => {
              if (provider !== undefined) void props.runtime?.onRefreshModels(provider.id)
            }}
          />
        ) : null}
        {ollamaTextWorkflow ? (
          <ModelActionButton
            action="eject"
            label={modelDiscoveryLoading
              ? 'Checking model status…'
              : selectedModelLoaded
                ? `Eject ${effectiveModelId}`
                : 'Model is not loaded'}
            disabled={provider?.kind !== 'ollama' || modelDiscoveryLoading || !selectedModelLoaded}
            onClick={() => {
              if (provider !== undefined && effectiveModelId !== '') {
                void props.runtime?.onEjectModel(provider.id, effectiveModelId)
              }
            }}
          />
        ) : null}
      </div>

      {(registryProvider || pinnedWorkflow) && selectedWorkflow !== undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 9px', border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
          <span style={{ color: palette.ink, fontSize: 11, fontWeight: 650 }}>{selectedWorkflow.name}</span>
          {selectedWorkflow.description !== '' ? <span style={{ color: palette.muted, fontSize: 10, lineHeight: 1.45 }}>{selectedWorkflow.description}</span> : null}
        </div>
      ) : null}

      {pinnedWorkflow && definition !== undefined ? (
        <DefinitionFields id={props.id} data={props.data} definition={definition} placement="primary" runtime={props.runtime} inputPorts={props.inputPorts} provider={provider} workflow={selectedWorkflow} />
      ) : (
        <>
          {fieldInputModeEnabled(props.data, 'prompt') ? (
            <ParameterInputPlaceholder label={t("Prompt")} fieldId="prompt" inputPorts={props.inputPorts} />
          ) : (
            <label style={labelStyle}>
              <span>{t("Prompt")}</span>
              <div style={{ position: 'relative' }}>
                {referencePanelWorkflow || props.referencePort === undefined ? null : (
                  <PromptReferenceHandle port={props.referencePort} ports={props.inputPorts} />
                )}
                <ImeSafeTextarea
                  className="nodrag nowheel"
                  aria-label={t("Prompt")}
                  value={props.data.prompt ?? ''}
                  rows={4}
                  placeholder={t(PROMPT_PLACEHOLDER)}
                  onWheel={stopWheel}
                  onValueChange={value => props.runtime?.onChange(props.id, { prompt: value })}
                  style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.45 }}
                />
              </div>
            </label>
          )}
          {referencePanelWorkflow && !registeredVideoWorkflow ? (
            <PromptReferencesPanel
              references={props.runtime?.references[props.id] ?? []}
              referencePort={props.referencePort}
              inputPorts={props.inputPorts}
            />
          ) : null}
          {registeredVideoWorkflow && selectedWorkflow !== undefined ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ color: palette.secondary, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{t("Main parameters")}</span>
              <fieldset style={{ display: 'grid', gridTemplateColumns: textImageVideoWorkflow ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
                <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Video")}</legend>
                {textImageVideoWorkflow ? (
                  <label style={labelStyle}>
                    <span>{t("Mode")}</span>
                    <select
                      className="nodrag"
                      aria-label={t("Video mode")}
                      value={props.data.videoMode ?? 'text-to-video'}
                      onChange={event => props.runtime?.onChange(props.id, {
                        videoMode: event.target.value as NonNullable<DirectorNodeData['videoMode']>,
                      })}
                      style={fieldStyle}
                    >
                      {VIDEO_MODE_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                    </select>
                  </label>
                ) : null}
                <label style={labelStyle}>
                  <span>{t("Duration")}</span>
                  <input
                    className="nodrag nowheel"
                    type="number"
                    min={0.1}
                    max={15}
                    step="0.1"
                    value={props.data.duration ?? selectedWorkflow.defaults.duration ?? ''}
                    onWheel={stopWheel}
                    onChange={event => props.runtime?.onChange(props.id, { duration: numberValue(event.target.value) })}
                    style={fieldStyle}
                  />
                </label>
              </fieldset>
              <fieldset style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
                <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Resolution Selector")}</legend>
                {videoAspectRatioParameter === undefined ? null : (
                  <ComfyWorkflowParameterField
                    id={props.id}
                    data={props.data}
                    parameter={videoAspectRatioParameter}
                    runtime={props.runtime}
                    inputPorts={props.inputPorts}
                    choices={discoveredModelChoices(provider, selectedWorkflow.id, videoAspectRatioParameter.id)}
                  />
                )}
                {videoMegapixelsParameter === undefined ? null : (
                  <label style={labelStyle}>
                    <button
                      type="button"
                      className="nodrag vd-megapixels-help"
                      aria-label={t("Open Note: Size Settings Reference")}
                      title={t("Open the read-only size settings reference")}
                      onClick={() => setSizeReferenceOpen(true)}
                    >
                      {t("MegaPixels ↗")}
                    </button>
                    <select
                      className="nodrag"
                      aria-label={t("MegaPixels")}
                      value={String(parameterValue(props.data, videoMegapixelsParameter))}
                      onChange={event => props.runtime?.onChange(props.id, {
                        workflowValues: {
                          ...props.data.workflowValues,
                          [videoMegapixelsParameter.id]: Number(event.target.value),
                        },
                      })}
                      style={fieldStyle}
                    >
                      {VIDEO_SIZE_REFERENCE.map(([megapixels]) => (
                        <option key={megapixels} value={String(Number(megapixels))}>{megapixels}</option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>
            </div>
          ) : registeredImageDimensions && selectedWorkflow !== undefined ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ color: palette.secondary, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{t("Main parameters")}</span>
              <fieldset style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
                <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Image size")}</legend>
                <label style={labelStyle}>
                  <span>{t("Width")}</span>
                  <input
                    className="nodrag nowheel"
                    type="number"
                    min={1}
                    step={1}
                    value={props.data.width ?? selectedWorkflow.defaults.width}
                    onWheel={stopWheel}
                    onChange={event => props.runtime?.onChange(props.id, { width: numberValue(event.target.value) })}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  <span>{t("Height")}</span>
                  <input
                    className="nodrag nowheel"
                    type="number"
                    min={1}
                    step={1}
                    value={props.data.height ?? selectedWorkflow.defaults.height}
                    onWheel={stopWheel}
                    onChange={event => props.runtime?.onChange(props.id, { height: numberValue(event.target.value) })}
                    style={fieldStyle}
                  />
                </label>
              </fieldset>
            </div>
          ) : registeredAudioWorkflow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ color: palette.secondary, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{t("Main parameters")}</span>
              <fieldset style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
                <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Output")}</legend>
                <label style={labelStyle}>
                  <span>{t("Duration")}</span>
                  <input
                    className="nodrag nowheel"
                    type="number"
                    min={0.1}
                    max={15}
                    step="0.1"
                    value={props.data.duration ?? selectedWorkflow.defaults.duration ?? ''}
                    onWheel={stopWheel}
                    onChange={event => props.runtime?.onChange(props.id, { duration: numberValue(event.target.value) })}
                    style={fieldStyle}
                  />
                </label>
                {audioPrimaryParameters.map(parameter => (
                  <ComfyWorkflowParameterField
                    key={parameter.id}
                    id={props.id}
                    data={props.data}
                    parameter={parameter}
                    runtime={props.runtime}
                    inputPorts={props.inputPorts}
                    choices={discoveredModelChoices(provider, selectedWorkflow.id, parameter.id)}
                  />
                ))}
              </fieldset>
            </div>
          ) : selectedWorkflow !== undefined ? (
            <ComfyWorkflowParameters id={props.id} data={props.data} workflow={selectedWorkflow} runtime={props.runtime} inputPorts={props.inputPorts} placement="primary" provider={provider} />
          ) : null}
          {registeredVideoWorkflow && referencePanelWorkflow ? (
            <PromptReferencesPanel
              references={videoReferences}
              referencePort={props.referencePort}
              inputPorts={props.inputPorts}
            />
          ) : null}
        </>
      )}

      {pinnedWorkflow && referencePanelWorkflow ? (
        <PromptReferencesPanel
          references={props.runtime?.references[props.id] ?? []}
          referencePort={props.referencePort}
          inputPorts={props.inputPorts}
        />
      ) : null}

      <details className="nodrag nowheel" onWheel={stopWheel} style={{ border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
        <summary style={{ padding: '8px 9px', color: palette.secondary, cursor: 'pointer', fontSize: 11, fontWeight: 650, userSelect: 'none' }}>
          {t("Advanced ·")} {String(advancedCount)} {t("fields")}
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 9px 9px' }}>

      {pinnedWorkflow && definition !== undefined ? (
        <DefinitionFields id={props.id} data={props.data} definition={definition} placement="advanced" runtime={props.runtime} inputPorts={props.inputPorts} provider={provider} workflow={selectedWorkflow} />
      ) : (
        <>

      {textWorkflow ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={labelStyle}>
            <span className="vd-system-prompt-heading">
              <span>{t("System Prompt")}</span>
              <button type="button" className="nodrag" onClick={() => setSystemPromptEditorOpen(true)}>{t("(inspect default)")}</button>
            </span>
            <textarea
              className="nodrag nowheel"
              aria-label={t("System Prompt")}
              value={effectiveSystemPrompt}
              rows={3}
              readOnly
              title={t("Use (inspect default) to edit this Markdown system prompt.")}
              onWheel={stopWheel}
              style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.4 }}
            />
          </div>
          {provider?.kind === 'ollama' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={labelStyle}>
              <span>{t("Context length")}</span>
              <input
                className="nodrag nowheel"
                type="number"
                min={1}
                max={selectedModelDetails?.contextLength}
                step={1}
                value={props.data.contextLength ?? ''}
                placeholder={selectedModelDetails?.contextLength === undefined
                  ? 'Auto'
                  : `Auto · max ${String(selectedModelDetails.contextLength)}`}
                onWheel={stopWheel}
                onChange={event => props.runtime?.onChange(props.id, { contextLength: numberValue(event.target.value) })}
                style={fieldStyle}
              />
            </label>
            <label
              title={thinkingSupported ? 'This model reports Ollama thinking support.' : 'The selected model does not report Ollama thinking support.'}
              style={{ display: 'flex', alignItems: 'center', alignSelf: 'end', gap: 7, minHeight: 30, color: thinkingSupported ? palette.secondary : palette.muted, fontSize: 10, opacity: thinkingSupported ? 1 : 0.55 }}
            >
              <input
                className="nodrag"
                type="checkbox"
                disabled={!thinkingSupported}
                checked={thinkingSupported && props.data.thinking === true}
                onChange={event => props.runtime?.onChange(props.id, { thinking: event.target.checked })}
              />
              {t("Thinking")}{thinkingSupported ? '' : ' · unsupported'}
            </label>
          </div>
          ) : null}
        </div>
      ) : null}

      {!registrySpecificControls && props.data.kind !== 'prompt-enhancer' && fieldInputModeEnabled(props.data, 'negativePrompt') ? (
        <ParameterInputPlaceholder label={t("Negative prompt")} fieldId="negativePrompt" inputPorts={props.inputPorts} />
      ) : !registrySpecificControls && props.data.kind !== 'prompt-enhancer' ? (
        <label style={labelStyle}>
          <span>{t("Negative prompt")}</span>
          <ImeSafeTextarea
            className="nodrag nowheel"
            value={props.data.negativePrompt ?? ''}
            rows={2}
            placeholder={t("Optional exclusions…")}
            onWheel={stopWheel}
            onValueChange={value => props.runtime?.onChange(props.id, { negativePrompt: value })}
            style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.4 }}
          />
        </label>
      ) : null}

      {workflowSeedControls ? (
        <fieldset style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
          <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Seed")}</legend>
          <label style={labelStyle}>
            <span>{t("Seed")}</span>
            <input
              className="nodrag nowheel"
              type="number"
              min={0}
              step={1}
              value={props.data.seed ?? selectedWorkflow?.defaults.seed ?? ''}
              onWheel={stopWheel}
              onChange={event => props.runtime?.onChange(props.id, { seed: numberValue(event.target.value) })}
              style={fieldStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>{t("Control after generate")}</span>
            <select
              className="nodrag"
              value={props.data.seedControlAfterGenerate ?? 'fixed'}
              onChange={event => props.runtime?.onChange(props.id, {
                seedControlAfterGenerate: event.target.value as NonNullable<DirectorNodeData['seedControlAfterGenerate']>,
              })}
              style={fieldStyle}
            >
              <option value="fixed">{t("fixed")}</option>
              <option value="increment">{t("increment")}</option>
              <option value="decrement">{t("decrement")}</option>
              <option value="randomize">{t("randomize")}</option>
            </select>
          </label>
        </fieldset>
      ) : null}

      {selectedWorkflow !== undefined ? (
        <ComfyWorkflowParameters id={props.id} data={props.data} workflow={selectedWorkflow} runtime={props.runtime} inputPorts={props.inputPorts} placement="advanced" provider={provider} />
      ) : null}

      {registeredAudioWorkflow ? (
        <fieldset style={{ minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
          <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Sampling")}</legend>
          <label style={labelStyle}>
            <span>{t("Sampling steps")}</span>
            <input
              className="nodrag nowheel"
              type="number"
              min={4}
              max={8}
              step={1}
              value={props.data.steps ?? selectedWorkflow.defaults.steps ?? 4}
              onWheel={stopWheel}
              onChange={event => props.runtime?.onChange(props.id, { steps: numberValue(event.target.value) })}
              style={fieldStyle}
            />
          </label>
        </fieldset>
      ) : null}

      {registeredVideoWorkflow ? (
        <fieldset style={{ minWidth: 0, margin: 0, padding: 9, border: `1px solid ${palette.subtleBorder}`, borderRadius: 9, background: '#f8fafc' }}>
          <legend style={{ padding: '0 4px', color: palette.muted, fontSize: 9, fontWeight: 650 }}>{t("Sampling")}</legend>
          <label style={labelStyle}>
            <span>{t("Steps")}</span>
            <input
              className="nodrag nowheel"
              type="number"
              min={1}
              step={1}
              value={props.data.steps ?? selectedWorkflow?.defaults.steps ?? 4}
              onWheel={stopWheel}
              onChange={event => props.runtime?.onChange(props.id, { steps: numberValue(event.target.value) })}
              style={fieldStyle}
            />
          </label>
        </fieldset>
      ) : null}

      {dimensioned && !registrySpecificControls ? (
        <div style={{ display: 'grid', gridTemplateColumns: timed ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: 7 }}>
          <label style={labelStyle}>
            <span>{t("Width")}</span>
            <input className="nodrag nowheel" type="number" min={1} step={h3 ? 32 : 1} value={props.data.width ?? ''} onWheel={stopWheel} onChange={event => props.runtime?.onChange(props.id, { width: numberValue(event.target.value) })} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            <span>{t("Height")}</span>
            <input className="nodrag nowheel" type="number" min={1} step={h3 ? 32 : 1} value={props.data.height ?? ''} onWheel={stopWheel} onChange={event => props.runtime?.onChange(props.id, { height: numberValue(event.target.value) })} style={fieldStyle} />
          </label>
          {timed ? (
            <label style={labelStyle}>
              <span>{t("Duration")}</span>
              <input className="nodrag nowheel" type="number" min={0.1} max={h3 ? 15 : undefined} step="0.1" value={props.data.duration ?? ''} onWheel={stopWheel} onChange={event => props.runtime?.onChange(props.id, { duration: numberValue(event.target.value) })} style={fieldStyle} />
            </label>
          ) : null}
          <label style={labelStyle}>
            <span>{timed ? 'FPS' : t("Seed")}</span>
            <input
              className="nodrag nowheel"
              type="number"
              min={0}
              value={timed ? (props.data.fps ?? '') : (props.data.seed ?? '')}
              onWheel={stopWheel}
              onChange={event => props.runtime?.onChange(props.id, timed ? { fps: numberValue(event.target.value) } : { seed: numberValue(event.target.value) })}
              style={fieldStyle}
            />
          </label>
        </div>
      ) : null}

      {timed && !registrySpecificControls ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: palette.secondary, fontSize: 10 }}>
          <input
            className="nodrag"
            type="checkbox"
            checked={props.data.includeAudio === true}
            onChange={event => props.runtime?.onChange(props.id, { includeAudio: event.target.checked })}
          />
          {t("Include reference video audio when its role permits it")}
        </label>
      ) : null}

      {h3 && !registrySpecificControls ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr .8fr 1fr', gap: 7 }}>
            <label style={labelStyle}>
              <span>{t("H3 variant")}</span>
              <select
                className="nodrag"
                value={props.data.variant ?? 'standard'}
                onChange={event => {
                  const variant = event.target.value === 'turbo' ? 'turbo' : 'standard'
                  if (variant === 'standard' && turboTopology) return
                  props.runtime?.onChange(props.id, variant === 'turbo'
                    ? { variant, steps: props.data.steps !== undefined && props.data.steps >= 4 && props.data.steps <= 8 ? props.data.steps : 6, scheduler: 'simple' }
                    : { variant, steps: 20, scheduler: 'simple' })
                }}
                style={fieldStyle}
              >
                <option value="standard" disabled={turboTopology}>{t("Standard")}{turboTopology ? ' · replace graph first' : ''}</option>
                <option value="turbo">Turbo LoRA</option>
              </select>
            </label>
            <label style={labelStyle}>
              <span>{t("Steps")}{props.data.variant === 'turbo' ? ' · 4–8' : ''}</span>
              <input
                className="nodrag nowheel"
                type="number"
                min={props.data.variant === 'turbo' ? 4 : 1}
                max={props.data.variant === 'turbo' ? 8 : undefined}
                step={1}
                value={props.data.steps ?? (props.data.variant === 'turbo' ? 6 : 20)}
                onWheel={stopWheel}
                onChange={event => props.runtime?.onChange(props.id, { steps: numberValue(event.target.value) })}
                style={fieldStyle}
              />
            </label>
            <label style={labelStyle}>
              <span>{t("Scheduler")}</span>
              <select className="nodrag" value={props.data.scheduler ?? 'simple'} onChange={() => props.runtime?.onChange(props.id, { scheduler: 'simple' })} style={fieldStyle}>
                <option value="simple">simple</option>
              </select>
            </label>
          </div>
          <div style={{ padding: '7px 8px', borderRadius: 8, border: `1px solid ${h3Locked ? 'rgba(180,35,24,.35)' : palette.subtleBorder}`, color: h3Locked ? palette.danger : palette.muted, fontSize: 10, lineHeight: 1.4 }}>
            {h3Locked
              ? 'MiniMax H3 is locked until its model license is accepted in plugin settings.'
              : turboTopology
                ? 'This API graph contains Turbo LoRA/Sampler nodes. Replace the complete graph with a reviewed Standard workflow before selecting Standard; changing a label cannot rewrite topology. Dimensions must be multiples of 32 and duration is capped at 15 s.'
                : 'MiniMax H3: dimensions must be multiples of 32; duration is capped at 15 s and values below 5 s are experimental. Turbo requires 4–8 steps and the simple scheduler.'}
          </div>
        </>
      ) : null}

      {legacyInlineWorkflow && !registryMediaWorkflow ? (
        <details className="nodrag nowheel" onWheel={stopWheel} style={{ borderTop: `1px solid ${palette.subtleBorder}`, paddingTop: 8 }}>
          <summary style={{ color: palette.secondary, cursor: 'pointer', fontSize: 11, userSelect: 'none' }}>{t("Legacy inline workflow JSON & bindings")}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
            <JsonEditor
              label={t("ComfyUI API workflow")}
              value={props.data.workflow ?? {}}
              rows={9}
              validate={isObject}
              invalidMessage="comfyui-workflow must be a JSON object keyed by comfyui-node ID."
              onApply={workflow => props.runtime?.onChange(props.id, { workflow })}
            />
            <JsonEditor
              label={t("Bindings")}
              value={props.data.bindings ?? []}
              rows={6}
              validate={isBindings}
              invalidMessage="Bindings must be an array with string nodeId, input, and from fields."
              onApply={bindings => props.runtime?.onChange(props.id, { bindings })}
            />
          </div>
        </details>
      ) : null}

        </>
      )}

        </div>
      </details>

      {systemPromptEditorOpen ? (
        <SystemPromptEditorDialog
          value={effectiveSystemPrompt}
          onClose={() => setSystemPromptEditorOpen(false)}
          onSave={value => {
            if (value !== effectiveSystemPrompt) props.runtime?.onChange(props.id, { systemPrompt: value })
            setSystemPromptEditorOpen(false)
          }}
        />
      ) : null}

      {sizeReferenceOpen ? <VideoSizeReferenceDialog onClose={() => setSizeReferenceOpen(false)} /> : null}

    </div>
  )
}

function OutputTextBody(props: { data: DirectorNodeData }): ReactNode {
  useLanguage()
  return (
    <div>
      <div style={{ padding: 10, minHeight: 80, borderRadius: 9, background: palette.field, color: palette.ink, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {props.data.text ?? 'No text output'}
      </div>
    </div>
  )
}

function downloadUrl(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
}

function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  try { downloadUrl(url, name) } finally { setTimeout(() => URL.revokeObjectURL(url), 0) }
}

function outputFileName(base: string, assetName: string, index: number, total: number): string {
  if (base.trim() === '') return assetName
  const extension = assetName.includes('.') ? `.${assetName.split('.').at(-1)}` : ''
  return `${base.trim()}${total > 1 ? `-${String(index + 1)}` : ''}${extension}`
}

function OutputSinkBody(props: { id: string; data: DirectorNodeData; runtime: DirectorRuntimeValue | null }): ReactNode {
  useLanguage()
  const assets = props.data.assets ?? (props.data.asset === undefined ? [] : [props.data.asset])
  const text = props.data.text
  const isSave = props.data.kind === 'save'
  const empty = assets.length === 0 && (text === undefined || text === '')
  const [openArtifact, setOpenArtifact] = useState<PreviewArtifact | null>(null)
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {empty ? (
          <div style={{ minHeight: 92, borderRadius: 10, border: `1px dashed ${palette.border}`, display: 'grid', placeItems: 'center', padding: 12, color: palette.muted, fontSize: 11, textAlign: 'center' }}>
            {t("Connect a generator and run it to receive output.")}
          </div>
        ) : null}
        {text !== undefined && text !== '' ? (
          <ArtifactThumbnail artifact={previewArtifactFromText(text)} variant="node" onOpen={setOpenArtifact} />
        ) : null}
        {assets.map(asset => (
          <div key={asset.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ArtifactThumbnail artifact={previewArtifactFromAsset(asset)} variant="node" onOpen={setOpenArtifact} />
            <span title={asset.name} style={{ color: palette.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
          </div>
        ))}
        {isSave ? (
          <>
            <label style={labelStyle}>
              <span>{t("Output name")}</span>
              <input
                className="nodrag"
                value={props.data.outputName ?? ''}
                placeholder={assets[0]?.name ?? 'output.txt'}
                onChange={event => props.runtime?.onChange(props.id, { outputName: event.target.value })}
                style={fieldStyle}
              />
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {assets.map((asset, index) => (
                <button key={asset.id} type="button" className="nodrag" onClick={() => downloadUrl(asset.url, outputFileName(props.data.outputName ?? '', asset.name, index, assets.length))} style={{ ...buttonStyle, background: palette.accent, color: '#fff' }}>
                  {t("Download")}{assets.length > 1 ? ` ${String(index + 1)}` : ''}
                </button>
              ))}
              {text !== undefined && text !== '' ? (
                <button type="button" className="nodrag" onClick={() => downloadText(text, props.data.outputName?.trim() || 'output.txt')} style={{ ...buttonStyle, background: palette.accent, color: '#fff' }}>
                  {t("Download text")}
                </button>
              ) : null}
            </div>
            {!empty ? <span style={{ color: palette.muted, fontSize: 9, lineHeight: 1.4 }}>{t("Outputs already live in the project asset store; Download exports a local copy without duplicating server bytes.")}</span> : null}
          </>
        ) : null}
      </div>
      {openArtifact === null ? null : (
        <ArtifactPreviewDialog artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
      )}
    </>
  )
}

function PromptReferenceHandle(props: {
  port: VdPortDescriptor
  ports: readonly VdPortDescriptor[]
  top?: number | string
}): ReactNode {
  useLanguage()
  const label = `${props.port.label}${props.port.required ? ' *' : ''}`
  const description = `${label} · ${props.port.types.join(' / ')}${props.port.multiple ? ' · multiple' : ''}`
  return (
    <>
      <Handle
        className="vd-prompt-reference-handle"
        type="target"
        id={portHandleId('input', props.port, props.ports)}
        position={Position.Left}
        title={description}
        style={{
          top: props.top ?? 0,
          left: -11,
          width: 10,
          height: 10,
          border: `2px solid ${palette.panel}`,
          background: palette.accent,
        }}
      />
      <span className="vd-prompt-reference-tooltip" aria-hidden="true">{description}</span>
    </>
  )
}

function PortHandles(props: {
  direction: 'input' | 'output'
  ports: readonly VdPortDescriptor[]
  allPorts?: readonly VdPortDescriptor[]
  showLabels?: boolean
}): ReactNode {
  useLanguage()
  const incoming = props.direction === 'input'
  return props.ports.map((port, index) => {
    const top = props.ports.length === 1
      ? '50%'
      : `${String(18 + ((index + 1) / (props.ports.length + 1)) * 64)}%`
    const label = `${port.label}${port.required ? ' *' : ''}`
    const portColor = port.types.includes('flow') ? FLOW_PORT_COLOR : palette.accent
    return (
      <Fragment key={`${props.direction}:${port.id}`}>
        <Handle
          type={incoming ? 'target' : 'source'}
          id={portHandleId(props.direction, port, props.allPorts ?? props.ports)}
          position={incoming ? Position.Left : Position.Right}
          title={`${label} · ${port.types.join(' / ')}${port.multiple ? ' · multiple' : ''}`}
          style={{
            top,
            width: 10,
            height: 10,
            border: `2px solid ${palette.panel}`,
            background: portColor,
          }}
        />
        {shouldShowPortLabel(props.direction, port, props.showLabels) ? <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top,
            [incoming ? 'left' : 'right']: 12,
            transform: 'translateY(-50%)',
            maxWidth: '38%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: palette.muted,
            fontSize: 8,
            fontWeight: 650,
            lineHeight: 1,
            pointerEvents: 'none',
            textAlign: incoming ? 'left' : 'right',
          }}
        >
          {label}
        </span> : null}
      </Fragment>
    )
  })
}

function TriggerBody(props: {
  id: string
  data: DirectorNodeData
  runtime: DirectorRuntimeValue | null
}): ReactNode {
  useLanguage()
  const action = props.data.kind === 'ollama-eject'
    ? 'ollama-eject'
    : props.data.kind === 'comfyui-clear' ? 'comfyui-clear' : props.data.vramAction ?? 'skip'
  const releaseWaitSeconds = Number.isSafeInteger(props.data.vramReleaseWaitSeconds) ? props.data.vramReleaseWaitSeconds! : 10
  const running = props.data.status === 'queued' || props.data.status === 'running'
  const description = action === 'ollama-eject'
    ? 'eject all loaded models'
    : action === 'comfyui-clear' ? 'unload models & clear cache' : 'by pass & no actions to take'
  const resetStatus = {
    status: 'idle' as const,
    phase: undefined,
    progress: undefined,
    error: undefined,
    jobId: undefined,
  }
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 34px', gap: 7, alignItems: 'end' }}>
        <label style={labelStyle}>
          <span>{t("VRAM action")}</span>
          <select
            className="nodrag nowheel"
            aria-label={t("VRAM action")}
            value={action}
            disabled={running}
            onChange={event => props.runtime?.onChange(props.id, {
              vramAction: event.currentTarget.value as NonNullable<DirectorNodeData['vramAction']>,
              vramActionInitialized: true,
              ...resetStatus,
            })}
            style={{ ...fieldStyle, minWidth: 0 }}
          >
            <option value="skip">{t("-- SKIP -- — by pass & no actions to take")}</option>
            <option value="ollama-eject">{t("Ollama — eject all loaded models")}</option>
            <option value="comfyui-clear">{t("ComfyUI — unload models & clear cache")}</option>
          </select>
        </label>
        <button
          type="button"
          className="nodrag nopan"
          aria-label={t("Run VRAM trigger now")}
          title={t("Run VRAM trigger now")}
          disabled={running}
          onClick={() => { void props.runtime?.onRunNode(props.id).catch(() => {}) }}
          style={{
            ...buttonStyle,
            minWidth: 34,
            width: 34,
            height: 34,
            padding: 0,
            color: palette.accent,
            fontSize: 18,
            fontWeight: 800,
          }}
        >
          ⏏
        </button>
      </div>
      <span style={{ color: palette.muted, fontSize: 9, lineHeight: 1.35 }}>{description}</span>
      {action === 'comfyui-clear' ? <label style={labelStyle}>
        <span>{t("Release model wait (seconds)")}</span>
        <input
          className="nodrag nowheel"
          aria-label={t("Release model wait seconds")}
          type="number"
          min={0}
          max={300}
          step={1}
          value={releaseWaitSeconds}
          disabled={running}
          onChange={event => {
            const value = event.currentTarget.valueAsNumber
            if (!Number.isSafeInteger(value) || value < 0 || value > 300) return
            props.runtime?.onChange(props.id, {
              vramReleaseWaitSeconds: value,
              ...resetStatus,
            })
          }}
          style={fieldStyle}
        />
        <span style={{ color: palette.muted, fontSize: 8.5 }}>{t("Wait after ComfyUI accepts")} <code>/free</code> {t("before continuing.")}</span>
      </label> : null}
    </div>
  )
}

export const DirectorNodeView = memo(function DirectorNodeView(props: NodeProps<DirectorFlowNode>): ReactNode {
  useLanguage()
  const runtime = useDirectorRuntime()
  const updateNodeInternals = useUpdateNodeInternals()
  const isWorkflow = WORKFLOW_KINDS.has(props.data.kind)
  const isSink = props.data.kind === 'preview' || props.data.kind === 'save'
  const isTrigger = props.data.kind === 'vram-trigger' || props.data.kind === 'ollama-eject' || props.data.kind === 'comfyui-clear'
  const hasError = props.data.status === 'failed' || (props.data.error !== undefined && props.data.error !== '')
  const theme = themeFor(props.data.kind)
  const kind = mediaKind(props.data)
  const definition = nodeDefinition(props.data, runtime?.nodeDefinitions ?? [])
  const declaredInputs = inputPortsFor(props.data, definition)
  const embeddedInputIds = new Set(isWorkflow ? embeddedWorkflowInputPortIds(props.data, declaredInputs) : [])
  const promptReferencePort = declaredInputs.find(port => port.id === 'reference' && embeddedInputIds.has(port.id))
  const floatingInputs = declaredInputs.filter(port => !embeddedInputIds.has(port.id))
  const declaredOutputs = portsFor(definition, 'output')
  const fieldInputSignature = parameterInputCandidates(props.data, definition)
    .filter(candidate => fieldInputModeEnabled(props.data, candidate.id))
    .map(candidate => candidate.id)
    .join('\u0000')
  const inputPortSignature = declaredInputs
    .map(port => `${port.id}:${String(port.required === true)}:${String(port.multiple === true)}`)
    .join('\u0000')
  const hasSource = definition === undefined ? props.data.kind !== 'save' : declaredOutputs.length > 0

  useEffect(() => {
    updateNodeInternals(props.id)
  }, [fieldInputSignature, inputPortSignature, props.id, updateNodeInternals])

  const nodeStyle: ThemedNodeStyle = {
    '--vd-node-panel': theme.panel,
    '--vd-node-raised': theme.raised,
    '--vd-node-border': theme.border,
    '--vd-node-accent': theme.accent,
    width: isWorkflow ? 390 : isSink ? 360 : isTrigger ? 350 : 330,
    boxSizing: 'border-box',
    borderRadius: 14,
    border: `${hasError ? 2 : 1}px solid ${hasError ? palette.danger : props.selected ? palette.accent : palette.border}`,
    background: palette.panel,
    color: palette.ink,
    colorScheme: 'light',
    boxShadow: hasError
      ? '0 0 0 3px rgba(180,35,24,.2), 0 18px 42px rgba(15,23,42,.2)'
      : props.selected
        ? `0 0 0 3px ${theme.accent}26, 0 18px 42px rgba(15,23,42,.2)`
        : '0 12px 30px rgba(15,23,42,.17)',
    overflow: 'visible',
    fontFamily: 'var(--dsw-alias-font, Inter, ui-sans-serif, system-ui, sans-serif)',
  }

  return (
    <article
      data-director-node={props.data.kind}
      className={props.selected ? 'vd-node-selected' : undefined}
      style={nodeStyle}
    >
      {floatingInputs.length > 0 ? <PortHandles direction="input" ports={floatingInputs} allPorts={declaredInputs} /> : null}
      {definition !== undefined ? <PortHandles direction="output" ports={declaredOutputs} showLabels={props.data.kind !== 'preview' && !isTrigger} /> : null}
      {definition === undefined && hasSource ? <Handle type="source" id="out" position={Position.Right} style={{ width: 10, height: 10, border: `2px solid ${palette.panel}`, background: palette.accent }} /> : null}

      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 11px', borderBottom: `1px solid ${palette.subtleBorder}`, background: palette.raised, borderRadius: '13px 13px 0 0' }}>
        <span style={{ color: palette.accent, fontSize: 9, fontWeight: 750, letterSpacing: '.09em', flex: '0 0 auto' }}>{t(kindLabel(props.data.kind))}</span>
        <input
          className="nodrag"
          aria-label={t("Node title")}
          value={props.data.title}
          onChange={event => runtime?.onChange(props.id, { title: event.target.value })}
          style={{ minWidth: 0, flex: 1, border: 0, outline: 0, background: 'transparent', color: palette.ink, font: 'inherit', fontSize: 12, fontWeight: 650, textAlign: 'right' }}
        />
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 11 }}>
        {props.data.kind === 'load-text' ? <TextBody id={props.id} data={props.data} runtime={runtime} /> : null}
        {props.data.kind === 'output-text' ? <OutputTextBody data={props.data} /> : null}
        {isSink ? <OutputSinkBody id={props.id} data={props.data} runtime={runtime} /> : null}
        {!isWorkflow && !isSink && !isTrigger && kind !== 'text' ? <MediaBody id={props.id} data={props.data} runtime={runtime} /> : null}
        {isTrigger ? <TriggerBody id={props.id} data={props.data} runtime={runtime} /> : null}
        {isWorkflow ? (
          <GenerationNodeBody
            id={props.id}
            data={props.data}
            runtime={runtime}
            inputPorts={declaredInputs}
            referencePort={promptReferencePort}
          />
        ) : null}
        {isWorkflow || isTrigger || props.data.frozen === true || (props.data.status !== undefined && props.data.status !== 'idle')
          ? <StatusView data={props.data} />
          : null}
      </div>
    </article>
  )
})

export default DirectorNodeView
