import type { DirectorNode, DirectorNodeData, DirectorEdge, DirectorGraph, VdNodeResult, MediaKind, VdNodeDefinitionDescriptor } from './types'
import { resolveEdgePorts } from './ports'
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function vdNodeResultPayload(result: VdNodeResult): Partial<DirectorNodeData> {
  if (result.kind === 'assets') {
    return {
      assets: result.assets,
      asset: result.assets[0],
      mediaKind: result.assets[0]?.kind,
      text: undefined,
    }
  }
  return {
    assets: undefined,
    asset: undefined,
    mediaKind: 'text',
    text: result.kind === 'text' ? result.text : JSON.stringify(result.result, null, 2),
  }
}

export function storedVdNodeResult(value: unknown): VdNodeResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<VdNodeResult>
  if (candidate.kind === 'assets' && Array.isArray(candidate.assets)) return candidate as VdNodeResult
  if (candidate.kind === 'text' && typeof candidate.text === 'string') return candidate as VdNodeResult
  if (candidate.kind === 'mcp-result' && 'result' in candidate) return candidate as VdNodeResult
  return undefined
}

export function nodeOutputPayload(data: DirectorNodeData): Partial<DirectorNodeData> | undefined {
  const result = storedVdNodeResult(data.result)
  if (result !== undefined) return { ...vdNodeResultPayload(result), result }
  if (data.asset === undefined && data.assets === undefined && data.text === undefined) return undefined
  return {
    asset: data.asset,
    assets: data.assets ?? (data.asset === undefined ? undefined : [data.asset]),
    text: data.text,
    mediaKind: data.mediaKind,
    result: data.result,
  }
}

export function hasReusableNodeOutput(node: DirectorNode): boolean {
  if (node.data.kind === 'load-text') {
    return typeof node.data.text === 'string' && node.data.text.trim() !== ''
  }
  if (node.data.kind === 'load-image'
    || node.data.kind === 'load-video'
    || node.data.kind === 'load-audio') {
    return node.data.asset !== undefined || (node.data.assets?.length ?? 0) > 0
  }
  const payload = nodeOutputPayload(node.data)
  return payload?.result !== undefined
    || payload?.asset !== undefined
    || (payload?.assets?.length ?? 0) > 0
    || (typeof payload?.text === 'string' && payload.text.trim() !== '')
}

export function combinedSinkPayload(
  nodes: readonly DirectorNode[],
  edges: readonly DirectorEdge[],
  sinkId: string,
  definitions: readonly VdNodeDefinitionDescriptor[],
): Partial<DirectorNodeData> | undefined {
  const graph: DirectorGraph = { nodes: [...nodes], edges: [...edges], viewport: { x: 0, y: 0, zoom: 1 } }
  const payloads: Array<{ node: DirectorNode; payload: Partial<DirectorNodeData> }> = []
  for (const edge of edges.filter(candidate => candidate.target === sinkId)) {
    const node = nodes.find(candidate => candidate.id === edge.source)
    if (node === undefined) continue
    const payload = nodeOutputPayload(node.data)
    if (payload === undefined) continue
    const ports = resolveEdgePorts(graph, definitions, edge)
    const carriedTypes = ports.sourceTypes.filter(type => ports.targetTypes.includes(type))
    const assets = (payload.assets ?? (payload.asset === undefined ? [] : [payload.asset]))
      .filter(asset => carriedTypes.includes(asset.kind))
    const text = carriedTypes.includes('text') ? payload.text : undefined
    if (assets.length === 0 && (text === undefined || text === '')) continue
    const stored = storedVdNodeResult(payload.result)
    const result = stored?.kind === 'assets'
      ? { ...stored, assets }
      : payload.result
    payloads.push({
      node,
      payload: {
        asset: assets[0],
        assets: assets.length === 0 ? undefined : assets,
        text,
        mediaKind: assets[0]?.kind ?? (text === undefined ? undefined : 'text'),
        result,
      },
    })
  }
  if (payloads.length === 0) return undefined

  const seenAssets = new Set<string>()
  const assets = payloads.flatMap(({ payload }) => payload.assets ?? (payload.asset === undefined ? [] : [payload.asset]))
    .filter(asset => {
      if (seenAssets.has(asset.id)) return false
      seenAssets.add(asset.id)
      return true
    })
  const texts = payloads
    .map(({ payload }) => payload.text)
    .filter((value): value is string => value !== undefined && value !== '')
  const results = payloads
    .map(({ payload }) => payload.result)
    .filter(value => value !== undefined)
  const completed = payloads.every(({ node }) => node.data.frozen === true
    || node.data.kind.startsWith('load-')
    || node.data.status === undefined || node.data.status === 'completed')
  const starts = payloads.map(({ node }) => node.data.runStartedAt).filter((value): value is string => value !== undefined).sort()
  const finishes = payloads.map(({ node }) => node.data.runCompletedAt).filter((value): value is string => value !== undefined).sort()
  return {
    asset: assets[0],
    assets: assets.length === 0 ? undefined : assets,
    text: texts.length === 0 ? undefined : texts.join('\n\n'),
    mediaKind: assets[0]?.kind ?? (texts.length > 0 ? 'text' : undefined),
    result: results.length === 0 ? undefined : results.length === 1 ? results[0] : results,
    status: completed ? 'completed' : 'idle',
    phase: completed ? 'completed' : undefined,
    progress: completed ? 1 : undefined,
    runStartedAt: completed ? starts[0] : undefined,
    runCompletedAt: completed ? finishes.at(-1) : undefined,
    derivedFrom: payloads.length === 1 ? payloads[0].node.id : undefined,
  }
}

export function clearedSinkData(data: DirectorNodeData): DirectorNodeData {
  const {
    asset: _asset,
    assets: _assets,
    text: _text,
    mediaKind: _mediaKind,
    result: _result,
    derivedFrom: _derivedFrom,
    phase: _phase,
    progress: _progress,
    error: _error,
    jobId: _jobId,
    outputSeed: _outputSeed,
    previewCleared: _previewCleared,
    runStartedAt: _runStartedAt,
    runCompletedAt: _runCompletedAt,
    ...rest
  } = data
  return { ...rest, status: 'idle' }
}

export function suppressedPreviewData(data: DirectorNodeData): DirectorNodeData {
  return { ...clearedSinkData(data), previewCleared: true }
}

export function resumedPreviewData(data: DirectorNodeData): DirectorNodeData {
  const { previewCleared: _previewCleared, ...rest } = data
  return rest as DirectorNodeData
}

export function recomputeSinkPayloads(
  nodes: readonly DirectorNode[],
  edges: readonly DirectorEdge[],
  definitions: readonly VdNodeDefinitionDescriptor[],
): DirectorNode[] {
  const sinks = new Set(nodes
    .filter(node => (
      (node.data.kind === 'preview' || node.data.kind === 'save')
      && node.data.frozen !== true
      && node.data.previewCleared !== true
    ))
    .map(node => node.id))
  if (sinks.size === 0) return [...nodes]

  let current = nodes.map(node => sinks.has(node.id)
    ? { ...node, data: clearedSinkData(node.data) }
    : node)
  for (let pass = 0; pass <= sinks.size; pass += 1) {
    let changed = false
    const next = current.map(node => {
      if (!sinks.has(node.id)) return node
      const payload = combinedSinkPayload(current, edges, node.id, definitions)
      if (payload === undefined) return node
      const data = { ...node.data, ...payload }
      if (sameJson(data, node.data)) return node
      changed = true
      return { ...node, data }
    })
    current = next
    if (!changed) break
  }
  return current
}
