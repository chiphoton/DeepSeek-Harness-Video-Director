import { previewArtifactFromAsset, previewArtifactFromText, previewArtifactsFromResult, type PreviewArtifact } from './ArtifactPreview'
import type { GalleryProject } from './types'

export interface GalleryArtifact {
  artifact: PreviewArtifact
  sources: string[]
  createdAt?: string
}

/** Current canvas inputs and retained output history, deduplicated within each tab. */
export function projectGallery(project: GalleryProject): { input: GalleryArtifact[]; output: GalleryArtifact[] } {
  const input = new Map<string, GalleryArtifact>()
  const output = new Map<string, GalleryArtifact>()
  const add = (target: Map<string, GalleryArtifact>, artifact: PreviewArtifact, source: string, createdAt?: string): void => {
    if (artifact.kind === 'text' && !artifact.text?.trim()) return
    // Text preview IDs contain only the name and length; compare the actual content here.
    const key = artifact.asset === undefined ? `text:${artifact.text}` : `asset:${artifact.asset.id}`
    const existing = target.get(key)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      return
    }
    target.set(key, { artifact: { ...artifact, id: artifact.asset?.id ?? `text:${target.size}` }, sources: [source], createdAt: artifact.asset?.createdAt ?? createdAt })
  }
  const nodeNames = new Map(project.graph.nodes.map(node => [node.id, node.data.title]))
  // Newest completed results remain available even when a Preview is cleared or its node is deleted.
  for (const job of [...project.jobs].sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))) {
    for (const artifact of previewArtifactsFromResult(job.result)) {
      add(output, artifact, nodeNames.get(job.nodeId) ?? job.operation, job.completedAt ?? job.createdAt)
    }
  }
  for (const node of project.graph.nodes) {
    const data = node.data
    const target = data.kind?.startsWith('load-') ? input : output
    for (const asset of [...(data.assets ?? []), ...(data.asset ? [data.asset] : [])]) {
      add(target, previewArtifactFromAsset(asset), data.title)
    }
    if (data.text !== undefined) add(target, previewArtifactFromText(data.text, data.title), data.title, data.runCompletedAt)
    if (data.maskAsset) add(input, previewArtifactFromAsset(data.maskAsset), data.title)
    if (data.sketchDocument?.base) add(input, previewArtifactFromAsset(data.sketchDocument.base.asset), data.title)
  }
  return { input: [...input.values()], output: [...output.values()] }
}

export interface WorkflowGalleryArtifact extends GalleryArtifact {
  workflowId: string
  workflowName: string
}

export function allProjectGalleries(projects: GalleryProject[]): { input: WorkflowGalleryArtifact[]; output: WorkflowGalleryArtifact[] } {
  const combined: { input: WorkflowGalleryArtifact[]; output: WorkflowGalleryArtifact[] } = { input: [], output: [] }
  for (const project of projects) {
    const gallery = projectGallery(project)
    for (const tab of ['input', 'output'] as const) {
      combined[tab].push(...gallery[tab].map(entry => ({ ...entry, workflowId: project.id, workflowName: project.name })))
    }
  }
  for (const entries of Object.values(combined)) entries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return combined
}

export function filterGallery(entries: WorkflowGalleryArtifact[], workflowId: string, query: string): WorkflowGalleryArtifact[] {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  return entries.filter(entry => {
    if (workflowId !== '' && entry.workflowId !== workflowId) return false
    const searchable = [entry.artifact.name, entry.workflowName, ...entry.sources, entry.artifact.kind, entry.artifact.asset?.mimeType ?? '', entry.artifact.text ?? ''].join('\n').normalize('NFKC').toLocaleLowerCase()
    return terms.every(term => searchable.includes(term))
  })
}
