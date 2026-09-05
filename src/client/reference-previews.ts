import type {
  AssetRef,
  DirectorGraph,
  DirectorNodeData,
  MediaKind,
  VdNodeDefinitionDescriptor,
} from './types'
import { resolveEdgePorts } from './ports'

export interface DirectorReferencePreview {
  edgeId: string
  sourceNodeId: string
  sourceTitle: string
  kind: MediaKind
  text?: string
  asset?: AssetRef
}

export function referenceLabelsByKind(
  references: readonly Pick<DirectorReferencePreview, 'kind'>[],
): string[] {
  const counts = new Map<MediaKind, number>()
  return references.map(reference => {
    const count = (counts.get(reference.kind) ?? 0) + 1
    counts.set(reference.kind, count)
    return `${reference.kind[0].toUpperCase()}${reference.kind.slice(1)} ${String(count)}`
  })
}

function resultText(data: DirectorNodeData): string | undefined {
  if (typeof data.text === 'string') return data.text
  if (data.kind === 'load-text' && typeof data.prompt === 'string') return data.prompt
  const result = data.result
  if (typeof result !== 'object' || result === null) return undefined
  if ('kind' in result && result.kind === 'text' && 'text' in result && typeof result.text === 'string') return result.text
  return undefined
}

export function referencePreviewsByTarget(
  graph: DirectorGraph,
  definitions: readonly VdNodeDefinitionDescriptor[],
): Readonly<Record<string, readonly DirectorReferencePreview[]>> {
  const previews: Record<string, DirectorReferencePreview[]> = {}
  for (const edge of graph.edges) {
    try {
      const ports = resolveEdgePorts(graph, definitions, edge)
      if (ports.targetPortId !== 'reference') continue
      const source = graph.nodes.find(node => node.id === edge.source)
      if (source === undefined) continue
      const asset = source.data.assets?.find(candidate => ports.sourceTypes.includes(candidate.kind))
        ?? source.data.asset
      const kind = asset?.kind
        ?? source.data.mediaKind
        ?? ports.sourceTypes.find(candidate => ports.targetTypes.includes(candidate))
        ?? 'text'
      const preview: DirectorReferencePreview = {
        edgeId: edge.id,
        sourceNodeId: source.id,
        sourceTitle: source.data.title,
        kind,
        text: resultText(source.data),
        asset,
      }
      const targetPreviews = previews[edge.target] ?? []
      targetPreviews.push(preview)
      previews[edge.target] = targetPreviews
    } catch {
      // Legacy or partially edited edges should not prevent the canvas from rendering.
    }
  }
  return previews
}
