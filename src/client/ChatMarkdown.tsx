import { memo, useState } from 'react'
import Markdown, { type AllowElement, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArtifactPreviewDialog, type PreviewArtifact } from './ArtifactPreview'
import { skillMentions } from './chat-skills'
import { t } from './i18n'

const assetPath = /^\/api\/video-director\/assets\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i
const remarkPlugins = [remarkGfm]

type MarkdownChild = NonNullable<Parameters<AllowElement>[2]>['children'][number]

function highlightSkillMentions(source: string) {
  const mentions = new Map(skillMentions(source).map(({ start, name }) => [start, name]))
  return () => (tree: { children: MarkdownChild[] }) => {
    function highlight(child: MarkdownChild): MarkdownChild[] {
      if (child.type === 'element' && child.tagName !== 'code' && child.tagName !== 'pre') {
        child.children = child.children.flatMap(highlight) as typeof child.children
      }
      if (child.type !== 'text' || !child.value.includes('$')) return [child]
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (start === undefined || end === undefined) return [child]

      // Markdown decodes escapes and entities. Pair the dollar words in the source
      // with their rendered occurrences so a literal dollar never looks invoked.
      const raw = source.slice(start, end)
      const original = [...raw.matchAll(/(?:\$|&dollar;|&#0*36;|&#[xX]0*24;)([a-z][\w-]*)/g)]
      const rendered = [...child.value.matchAll(/\$([a-z][\w-]*)/g)]
      if (original.length !== rendered.length || original.some((match, index) => match[1] !== rendered[index]?.[1])) return [child]

      const parts: MarkdownChild[] = []
      let from = 0
      for (const [index, match] of rendered.entries()) {
        if (mentions.get(start + original[index]!.index) !== match[1]) continue
        if (match.index > from) parts.push({ type: 'text', value: child.value.slice(from, match.index) })
        parts.push({ type: 'element', tagName: 'span', properties: { className: ['vd-chat-skill-mention'] },
          children: [{ type: 'text', value: match[0] }] })
        from = match.index + match[0].length
      }
      if (parts.length === 0) return [child]
      if (from < child.value.length) parts.push({ type: 'text', value: child.value.slice(from) })
      return parts
    }
    tree.children = tree.children.flatMap(highlight)
  }
}

function chatUrl(url: string): string {
  return assetPath.test(url) || /^(https?:\/\/|mailto:)/i.test(url) ? url : ''
}

function playbackKind(name: string): 'video' | 'audio' | undefined {
  if (/\.(mp4|webm|mov|m4v)$/i.test(name)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(name)) return 'audio'
}

function Playback({ kind, url, name }: { kind: 'video' | 'audio'; url: string; name: string }) {
  return <span className="vd-chat-markdown-media">
    {kind === 'video' ? <video src={url} controls playsInline preload="none" aria-label={name} />
      : <audio src={url} controls preload="none" aria-label={name} />}
    <a href={url} target="_blank" rel="noreferrer">{name}</a>
  </span>
}

function MarkdownImage({ url, id, name }: { url: string; id: string; name: string }) {
  const [open, setOpen] = useState(false)
  const artifact: PreviewArtifact = {
    id, name, kind: 'image',
    asset: { id, name, url, kind: 'image', projectId: '', mimeType: '', size: 0, sha256: '', createdAt: '' },
  }
  return <>
    <button className="vd-chat-markdown-image" type="button" aria-label={t('Preview {0}', name)} onClick={() => setOpen(true)}>
      <img src={url} alt={name} loading="lazy" />
    </button>
    {open && <ArtifactPreviewDialog artifact={artifact} onClose={() => setOpen(false)} />}
  </>
}

const components: Components = {
  table: ({ children }) => <div className="vd-chat-markdown-table"><table>{children}</table></div>,
  a: ({ href, children, node }) => {
    if (!href) return <>{children}</>
    const name = node?.children.length === 1 && node.children[0].type === 'text' ? node.children[0].value : ''
    const kind = assetPath.test(href) ? playbackKind(name) : undefined
    return kind ? <Playback kind={kind} url={href} name={name} />
      : <a href={href} target="_blank" rel="noreferrer">{children}</a>
  },
  img: ({ src, alt }) => {
    const name = alt || t('Image')
    if (!src) return <>{name}</>
    const id = assetPath.exec(src)?.[1]
    // Third-party media is opened explicitly so a reply cannot trigger remote requests.
    if (id === undefined) return <a href={src} target="_blank" rel="noreferrer">{name}</a>
    const kind = playbackKind(name)
    return kind ? <Playback kind={kind} url={src} name={name} /> : <MarkdownImage url={src} id={id} name={name} />
  },
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, showSkills = false }: { text: string; showSkills?: boolean }) {
  return <div className="vd-chat-markdown">
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={showSkills && text.includes('$') ? [highlightSkillMentions(text)] : undefined}
      components={components} urlTransform={chatUrl} skipHtml>{text}</Markdown>
  </div>
})
