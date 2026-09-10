import { t, useLanguage } from './i18n'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { parseImageProperties, type ImageProperties } from './image-properties'
import type { AssetRef, VdNodeResult } from './types'

export interface PreviewArtifact {
  id: string
  kind: 'text' | 'image' | 'audio' | 'video'
  name: string
  text?: string
  asset?: AssetRef
}

function previewKind(asset: AssetRef): PreviewArtifact['kind'] {
  if (asset.kind === 'audio' || asset.kind === 'video') return asset.kind
  return 'image'
}

export function previewArtifactFromAsset(asset: AssetRef): PreviewArtifact {
  return { id: asset.id, kind: previewKind(asset), name: asset.name, asset }
}

export function previewArtifactFromText(text: string, name = 'Text output'): PreviewArtifact {
  return { id: `text:${name}:${text.length}`, kind: 'text', name, text }
}

export function previewArtifactsFromResult(result: VdNodeResult | undefined): PreviewArtifact[] {
  if (result === undefined) return []
  if (result.kind === 'assets') return result.assets.map(previewArtifactFromAsset)
  if (result.kind === 'text') return [previewArtifactFromText(result.text)]
  return [previewArtifactFromText(JSON.stringify(result.result, null, 2), 'MCP result')]
}

function ThumbnailContent({ artifact }: { artifact: PreviewArtifact }): ReactNode {
  useLanguage()
  if (artifact.kind === 'image' && artifact.asset !== undefined) {
    return <img src={artifact.asset.url} alt="" draggable={false} loading="lazy" />
  }
  if (artifact.kind === 'video' && artifact.asset !== undefined) {
    return (
      <span className="vd-artifact-video-thumbnail">
        <video src={artifact.asset.url} aria-hidden="true" muted playsInline preload="metadata" />
        <i aria-hidden="true">▶</i>
      </span>
    )
  }
  if (artifact.kind === 'audio') {
    return <span className="vd-artifact-kind-thumbnail" aria-hidden="true"><strong>♫</strong><small>audio</small></span>
  }
  return <span className="vd-artifact-text-thumbnail">{artifact.text?.trim() || 'No text output'}</span>
}

export function ArtifactThumbnail(props: {
  artifact: PreviewArtifact
  variant?: 'node' | 'job'
  onOpen(artifact: PreviewArtifact): void
}): ReactNode {
  useLanguage()
  return (
    <button
      type="button"
      className={`nodrag nowheel vd-artifact-thumbnail is-${props.variant ?? 'node'} is-${props.artifact.kind}`}
      aria-label={`Preview ${props.artifact.name}`}
      title={`Preview ${props.artifact.name}`}
      onClick={() => props.onOpen(props.artifact)}
    >
      <ThumbnailContent artifact={props.artifact} />
    </button>
  )
}

export function ArtifactPreviewDialog(props: {
  artifact: PreviewArtifact
  initialPropertiesOpen?: boolean
  onClose(): void
}): ReactNode {
  useLanguage()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [copied, setCopied] = useState(false)
  const [properties, setProperties] = useState<ImageProperties | null>(null)
  const [propertyError, setPropertyError] = useState<string | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [videoProperties, setVideoProperties] = useState<{ width: number; height: number; duration: number } | null>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null)
  const titleId = useId()
  const propertiesTitleId = useId()
  const asset = props.artifact.asset

  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setCopied(false)
    setProperties(null)
    setPropertyError(null)
    setNaturalSize(null)
    setContextMenu(null)
    setPropertiesOpen(props.initialPropertiesOpen === true)
    setVideoProperties(null)
  }, [props.artifact.id, props.initialPropertiesOpen])

  useEffect(() => {
    const bodyOverflow = document.body.style.overflow
    const rootOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = rootOverflow
    }
  }, [])

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (propertiesOpen) setPropertiesOpen(false)
      else if (contextMenu !== null) setContextMenu(null)
      else props.onClose()
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [contextMenu, propertiesOpen, props.onClose])

  useEffect(() => {
    if (props.artifact.kind !== 'image' || asset === undefined) return
    const controller = new AbortController()
    void fetch(asset.url, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Could not read image (${String(response.status)}).`)
        return response.arrayBuffer()
      })
      .then(buffer => setProperties(parseImageProperties(buffer, asset.mimeType)))
      .catch(error => {
        if (controller.signal.aborted) return
        setPropertyError(error instanceof Error ? error.message : String(error))
      })
    return () => controller.abort()
  }, [asset, props.artifact.kind])

  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const copyText = async (): Promise<void> => {
    if (props.artifact.text === undefined) return
    try {
      await navigator.clipboard.writeText(props.artifact.text)
      setCopied(true)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = props.artifact.text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      setCopied(copied)
    }
  }

  const resetImageView = (): void => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const saveArtifact = (): void => {
    if (asset === undefined) return
    const anchor = document.createElement('a')
    anchor.href = asset.url
    anchor.download = asset.name
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setContextMenu(null)
  }

  const dimensions = properties?.width !== undefined && properties.height !== undefined
    ? `${String(properties.width)} × ${String(properties.height)} px`
    : naturalSize === null
      ? 'Reading…'
      : `${String(naturalSize.width)} × ${String(naturalSize.height)} px`
  const format = properties?.format ?? asset?.mimeType.split('/')[1]?.toUpperCase() ?? 'Reading…'
  const bitDepth = properties === null && propertyError === null ? 'Reading…' : properties?.bitDepth ?? 'Unavailable'
  const date = asset === undefined ? '—' : new Date(asset.createdAt).toLocaleString()
  const mediaLabel = props.artifact.kind === 'video' ? 'Video' : 'Image'
  const videoDimensions = videoProperties === null
    ? 'Reading…'
    : `${String(videoProperties.width)} × ${String(videoProperties.height)} px`
  const videoDuration = videoProperties === null || !Number.isFinite(videoProperties.duration)
    ? 'Reading…'
    : `${videoProperties.duration.toFixed(videoProperties.duration < 10 ? 2 : 1)} s`

  return createPortal(
    <div
      className="vd-artifact-dialog-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        className={`vd-artifact-dialog nodrag nowheel${props.artifact.kind === 'image' ? ' is-image-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()}
      >
        <header>
          <div>
            <strong id={titleId}>{props.artifact.name}</strong>
            <span>{props.artifact.kind}</span>
          </div>
          <div className="vd-artifact-dialog-actions">
            {props.artifact.kind === 'text' ? (
              <button type="button" onClick={() => { void copyText() }}>{copied ? 'Copied' : t("Copy")}</button>
            ) : null}
            <button type="button" className="vd-artifact-dialog-close" aria-label={t("Close artifact preview")} title={t("Close")} onClick={props.onClose}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          </div>
        </header>
        {props.artifact.kind === 'image' && props.artifact.asset !== undefined ? (
          <>
            <div className="vd-artifact-image-info" aria-label={t("Image properties")}>
              <span><small>{t("Dimensions")}</small><strong>{dimensions}</strong></span>
              <span><small>{t("Bit depth")}</small><strong>{bitDepth}</strong></span>
              <span><small>{t("Format")}</small><strong>{format}</strong></span>
              <span><small>{t("Date")}</small><strong>{date}</strong></span>
            </div>
            <div
              className={`vd-artifact-dialog-content is-image${drag.current === null ? '' : ' is-dragging'}`}
              aria-label={`Image view, ${String(Math.round(zoom * 100))}% zoom`}
              onWheel={event => {
                event.preventDefault()
                event.stopPropagation()
                const nextZoom = Math.min(8, Math.max(.1, zoom * Math.exp(-event.deltaY * .002)))
                if (nextZoom === zoom) return
                const rect = event.currentTarget.getBoundingClientRect()
                const cursorX = event.clientX - rect.left - rect.width / 2
                const cursorY = event.clientY - rect.top - rect.height / 2
                const ratio = nextZoom / zoom
                setPan(current => ({
                  x: cursorX - (cursorX - current.x) * ratio,
                  y: cursorY - (cursorY - current.y) * ratio,
                }))
                setZoom(nextZoom)
              }}
              onPointerDown={event => {
                if (event.button !== 0) return
                drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={event => {
                if (drag.current?.pointerId !== event.pointerId) return
                setPan({
                  x: drag.current.panX + event.clientX - drag.current.startX,
                  y: drag.current.panY + event.clientY - drag.current.startY,
                })
              }}
              onPointerUp={event => {
                if (drag.current?.pointerId !== event.pointerId) return
                drag.current = null
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onPointerCancel={() => { drag.current = null }}
              onContextMenu={event => {
                event.preventDefault()
                setContextMenu({ x: event.clientX, y: event.clientY })
              }}
            >
              <img
                src={props.artifact.asset.url}
                alt={props.artifact.name}
                draggable={false}
                onLoad={event => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                style={{ transform: `translate3d(${String(pan.x)}px, ${String(pan.y)}px, 0) scale(${String(zoom)})` }}
              />
            </div>
          </>
        ) : props.artifact.kind === 'video' && props.artifact.asset !== undefined ? (
          <div
            className="vd-artifact-dialog-content is-video"
            onContextMenu={event => {
              event.preventDefault()
              setContextMenu({ x: event.clientX, y: event.clientY })
            }}
          >
            <video
              src={props.artifact.asset.url}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={event => setVideoProperties({
                width: event.currentTarget.videoWidth,
                height: event.currentTarget.videoHeight,
                duration: event.currentTarget.duration,
              })}
            />
          </div>
        ) : props.artifact.kind === 'audio' && props.artifact.asset !== undefined ? (
          <div className="vd-artifact-dialog-content is-audio">
            <audio src={props.artifact.asset.url} controls preload="metadata" />
          </div>
        ) : (
          <div className="vd-artifact-dialog-content is-text">
            <pre>{props.artifact.text ?? 'No text output'}</pre>
          </div>
        )}
        {contextMenu !== null ? (
          <div
            className="vd-image-context-menu"
            role="menu"
            aria-label={`${mediaLabel} actions`}
            style={{
              left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 210)),
              top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 146)),
            }}
            onPointerDown={event => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={saveArtifact}>{t("Save")} {mediaLabel.toLowerCase()}…</button>
            <button type="button" role="menuitem" onClick={() => { setContextMenu(null); setPropertiesOpen(true) }}>{mediaLabel} {t("properties…")}</button>
            {props.artifact.kind === 'image' ? (
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); resetImageView() }}>{t("Reset view")}</button>
            ) : null}
          </div>
        ) : null}
        {propertiesOpen && asset !== undefined ? (
          <div
            className="vd-image-properties-backdrop"
            onPointerDown={event => {
              if (event.target === event.currentTarget) setPropertiesOpen(false)
            }}
          >
            <section className="vd-image-properties-dialog" role="dialog" aria-modal="true" aria-labelledby={propertiesTitleId}>
              <header>
                <div><strong id={propertiesTitleId}>{mediaLabel} {t("properties")}</strong><span>{asset.name}</span></div>
                <button type="button" aria-label={`Close ${mediaLabel.toLowerCase()} properties`} onClick={() => setPropertiesOpen(false)}>×</button>
              </header>
              <dl>
                <div><dt>{t("Dimensions")}</dt><dd>{props.artifact.kind === 'video' ? videoDimensions : dimensions}</dd></div>
                {props.artifact.kind === 'video' ? <div><dt>{t("Duration")}</dt><dd>{videoDuration}</dd></div> : <div><dt>{t("Bit depth")}</dt><dd>{bitDepth}</dd></div>}
                <div><dt>{t("Format")}</dt><dd>{format}</dd></div>
                <div><dt>{t("Date")}</dt><dd>{date}</dd></div>
                <div><dt>{t("MIME type")}</dt><dd>{asset.mimeType}</dd></div>
                <div><dt>{t("File size")}</dt><dd>{new Intl.NumberFormat(undefined, { style: 'unit', unit: 'byte', unitDisplay: 'short' }).format(asset.size)}</dd></div>
                <div><dt>SHA-256</dt><dd className="is-code">{asset.sha256}</dd></div>
              </dl>
              {props.artifact.kind === 'image' ? <div className="vd-image-metadata">
                <strong>{t("Metadata")}</strong>
                {propertyError !== null ? <p>{propertyError}</p> : properties === null ? <p>{t("Reading embedded metadata…")}</p> : properties.metadata.length === 0 ? <p>{t("No embedded metadata found.")}</p> : (
                  <dl>{properties.metadata.map((entry, index) => <div key={`${entry.name}:${String(index)}`}><dt>{entry.name}</dt><dd>{entry.value}</dd></div>)}</dl>
                )}
              </div> : null}
            </section>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
