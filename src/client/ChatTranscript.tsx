import { useEffect, useMemo, useState } from 'react'
import { ArtifactPreviewDialog, ArtifactThumbnail, type PreviewArtifact } from './ArtifactPreview'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatMessageImage, ProjectChatMessage, ProjectChatSource } from './chat-source'
import type { ChatModelDirectoryState } from './types'
import { t } from './i18n'

type ReadImage = ProjectChatSource['readImage']

function TranscriptImage({ image, sessionId, readImage, label }: {
  image: ChatMessageImage
  sessionId: string
  readImage: ReadImage
  label: string
}) {
  const { attachmentId, previewUrl } = image
  const [loaded, setLoaded] = useState<{ url: string; mimeType: string; size: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (attachmentId === undefined) return
    let live = true
    let url: string | undefined
    void readImage(sessionId, attachmentId).then(blob => {
      if (!live) return
      url = URL.createObjectURL(blob)
      setLoaded({ url, mimeType: blob.type, size: blob.size })
    }).catch(() => { if (live) setFailed(true) })
    return () => {
      live = false
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [attachmentId, readImage, sessionId])
  const source = previewUrl === undefined ? loaded : { url: previewUrl, mimeType: '', size: 0 }
  if (source === null) return <span className="vd-message-image-placeholder">{t(failed ? 'Image unavailable' : 'Loading image…')}</span>
  const name = image.name ?? label
  const id = attachmentId ?? source.url
  const artifact: PreviewArtifact = {
    id, kind: 'image', name,
    asset: { id, projectId: '', kind: 'image', name, sha256: '', createdAt: '', ...source },
  }
  return <>
    <ArtifactThumbnail artifact={artifact} variant="job" onOpen={() => setOpen(true)} />
    {open ? <ArtifactPreviewDialog artifact={artifact} onClose={() => setOpen(false)} /> : null}
  </>
}

function isToolMessage(message: ProjectChatMessage): boolean {
  return message.kind === 'tool-call' || message.kind === 'tool-result'
}

function MessageImages({ images, sessionId, readImage }: {
  images?: ChatMessageImage[]; sessionId: string | null; readImage: ReadImage
}) {
  if (sessionId === null || !images?.length) return null
  return <div className="vd-message-images">
    {images.map((image, index) => {
      const label = t('Image {0}', String(image.number ?? index + 1))
      return <figure key={`${sessionId}:${image.attachmentId ?? image.previewUrl}:${index}`}>
        <TranscriptImage image={image} sessionId={sessionId} readImage={readImage} label={label} />
        <figcaption>{label}</figcaption>
      </figure>
    })}
  </div>
}

function ToolActivity({ messages, sessionId, readImage }: {
  messages: ProjectChatMessage[]; sessionId: string | null; readImage: ReadImage
}) {
  const calls = new Map<string, ProjectChatMessage[]>()
  for (const message of messages) {
    const id = message.callId ?? message.id
    const existing = calls.get(id)
    if (existing) existing.push(message)
    else calls.set(id, [message])
  }
  const errors = [...calls.values()].filter(group => group.some(message => message.status === 'error')).length
  return <details className="vd-chat-tool-activity">
    <summary>
      {t('Tool activity')} ({calls.size})
      {errors > 0 ? <> <span className="vd-chat-tool-errors">{errors === 1 ? t('1 error') : t('{0} errors', String(errors))}</span></> : null}
    </summary>
    <ul>
      {[...calls].map(([id, group]) => {
        const first = group[0]
        const failed = group.some(message => message.status === 'error')
        const running = group.length === 1 && first.status === 'streaming'
        return <li key={id}>
          <details>
            <summary>
              {first.toolName ?? t('Tool result')}{first.toolCommand ? ` · ${first.toolCommand}` : ''}
              {failed ? <span className="vd-chat-tool-errors">{t('Tool error')}</span> : running ? <span className="vd-chat-tool-status">{t('Running…')}</span> : null}
            </summary>
            {group.map(message => <div className="vd-chat-tool-detail" key={message.id}>
              <strong>{message.kind === 'tool-call' ? t('Tool call') : t('Tool result')}</strong>
              {message.text && <pre>{message.text}</pre>}
              <MessageImages images={message.images} sessionId={sessionId} readImage={readImage} />
            </div>)}
          </details>
        </li>
      })}
    </ul>
  </details>
}

export function ChatTranscript({ messages, sessionId, readImage, models }: {
  messages: ProjectChatMessage[]
  sessionId: string | null
  readImage: ReadImage
  models: ChatModelDirectoryState
}) {
  const modelNames = useMemo(() => new Map(models.groups.flatMap(group =>
    group.models.map(model => [JSON.stringify([group.id, model.id]), model.name] as const)
  )), [models.groups])
  const groups: ProjectChatMessage[][] = []
  for (const message of messages) {
    const previous = groups.at(-1)
    if (previous !== undefined && isToolMessage(previous[0]) && isToolMessage(message)) previous.push(message)
    else groups.push([message])
  }
  return groups.map(group => {
    const message = group[0]
    if (isToolMessage(message)) return <ToolActivity key={message.id} messages={group} sessionId={sessionId} readImage={readImage} />
    const model = message.model
    const name = model ? modelNames.get(JSON.stringify([model.provider, model.model])) ?? model.model : t('Assistant')
    return <article key={message.id} className={`vd-message vd-message-${message.role}`}>
      <header title={model?.model}>{message.role === 'user' ? t('你') : name}</header>
      <MessageImages images={message.images} sessionId={sessionId} readImage={readImage} />
      {message.text !== '' && <ChatMarkdown text={message.text} showSkills={message.role === 'user'} />}
    </article>
  })
}
