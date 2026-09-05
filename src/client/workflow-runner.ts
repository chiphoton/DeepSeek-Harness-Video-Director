// Plans vd-runs over the canvas graph. ComfyUI graph execution happens in the Host.
import type { DirectorGraph, DirectorNodeData, VdRunMode } from './types'

export type { VdRunMode } from './types'

export interface VdRunPlan {
  mode: VdRunMode
  scopeNodeIds: string[]
  nodeIds: string[]
  frozenNodeIds: string[]
  stages: string[][]
}

/** @deprecated Use VdRunMode. */
export type WorkflowRunMode = VdRunMode
/** @deprecated Use VdRunPlan. */
export type WorkflowRunPlan = VdRunPlan

const EXECUTABLE_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
  'vram-trigger',
  'ollama-eject',
  'comfyui-clear',
])

export function isExecutableVdNodeKind(kind: DirectorNodeData['kind']): boolean {
  return EXECUTABLE_KINDS.has(kind)
}

/** @deprecated Use isExecutableVdNodeKind. */
export const isExecutableWorkflowKind = isExecutableVdNodeKind

export function validateTriggerNodeConnections(graph: DirectorGraph, nodeId: string): void {
  const node = graph.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`Node ${nodeId} was not found.`)
  if (node.data.kind !== 'vram-trigger' && node.data.kind !== 'ollama-eject' && node.data.kind !== 'comfyui-clear') return
  if (!graph.edges.some(edge => edge.source === nodeId || edge.target === nodeId)) {
    throw new Error(`${node.data.title} must have at least one connected end.`)
  }
}

function runScope(
  graph: DirectorGraph,
  mode: VdRunMode,
  selectedNodeIds: readonly string[],
): Set<string> {
  if (mode === 'all') return new Set(graph.nodes.map(node => node.id))

  const existing = new Set(graph.nodes.map(node => node.id))
  const selected = new Set(selectedNodeIds.filter(id => existing.has(id)))
  if (selected.size === 0) throw new Error('Select at least one node for this run mode.')
  if (mode === 'selected') return selected

  if (mode === 'dependencies') {
    const incoming = new Map<string, string[]>()
    for (const edge of graph.edges) {
      const sources = incoming.get(edge.target) ?? []
      sources.push(edge.source)
      incoming.set(edge.target, sources)
    }
    const pending = [...selected]
    while (pending.length > 0) {
      const target = pending.shift()!
      for (const source of incoming.get(target) ?? []) {
        if (selected.has(source)) continue
        selected.add(source)
        if (graph.nodes.find(node => node.id === source)?.data.frozen !== true) pending.push(source)
      }
    }
    return selected
  }

  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  }
  const pending = [...selected]
  while (pending.length > 0) {
    const source = pending.shift()!
    for (const target of outgoing.get(source) ?? []) {
      if (selected.has(target)) continue
      selected.add(target)
      pending.push(target)
    }
  }
  return selected
}

export function planVdRun(
  graph: DirectorGraph,
  options: { mode: VdRunMode; selectedNodeIds?: readonly string[] },
): VdRunPlan {
  const scope = runScope(graph, options.mode, options.selectedNodeIds ?? [])
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  const graphIndegree = new Map([...scope].map(id => [id, 0]))
  const graphOutgoing = new Map<string, string[]>()
  const graphIncoming = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!scope.has(edge.source) || !scope.has(edge.target)) continue
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue
    graphIndegree.set(edge.target, (graphIndegree.get(edge.target) ?? 0) + 1)
    const targets = graphOutgoing.get(edge.source) ?? []
    targets.push(edge.target)
    graphOutgoing.set(edge.source, targets)
    const sources = graphIncoming.get(edge.target) ?? []
    sources.push(edge.source)
    graphIncoming.set(edge.target, sources)
  }

  let graphReady = [...scope].filter(id => graphIndegree.get(id) === 0)
  let visited = 0
  while (graphReady.length > 0) {
    const layer = graphReady
    graphReady = []
    visited += layer.length
    for (const source of layer) {
      for (const target of graphOutgoing.get(source) ?? []) {
        const next = (graphIndegree.get(target) ?? 0) - 1
        graphIndegree.set(target, next)
        if (next === 0) graphReady.push(target)
      }
    }
  }

  if (visited !== scope.size) {
    const cyclic = [...scope].filter(id => (graphIndegree.get(id) ?? 0) > 0)
      .map(id => nodesById.get(id)?.data.title ?? id)
    throw new Error(`vd-workflow contains a cycle involving: ${cyclic.join(', ')}.`)
  }

  const frozenNodeIds = [...scope].filter(id => nodesById.get(id)?.data.frozen === true)
  const runnableIds = [...scope].filter(id => {
    const node = nodesById.get(id)
    return node !== undefined && node.data.frozen !== true && isExecutableVdNodeKind(node.data.kind)
  })
  if (runnableIds.length === 0 && frozenNodeIds.length === 0) throw new Error('This vd-run contains no executable vd-nodes.')
  const runnable = new Set(runnableIds)
  const dependencies = new Map(runnableIds.map(id => [id, new Set<string>()]))
  for (const target of runnableIds) {
    const pending = [...(graphIncoming.get(target) ?? [])]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const source = pending.shift()!
      if (seen.has(source)) continue
      seen.add(source)
      if (nodesById.get(source)?.data.frozen === true) continue
      if (runnable.has(source)) {
        dependencies.get(target)!.add(source)
        continue
      }
      pending.push(...(graphIncoming.get(source) ?? []))
    }
  }

  const runIndegree = new Map(runnableIds.map(id => [id, dependencies.get(id)!.size]))
  const runOutgoing = new Map<string, string[]>()
  for (const [target, sources] of dependencies) {
    for (const source of sources) {
      const targets = runOutgoing.get(source) ?? []
      targets.push(target)
      runOutgoing.set(source, targets)
    }
  }
  let ready = runnableIds.filter(id => runIndegree.get(id) === 0)
  const stages: string[][] = []
  while (ready.length > 0) {
    const layer = ready
    ready = []
    stages.push(layer)
    for (const source of layer) {
      for (const target of runOutgoing.get(source) ?? []) {
        const next = (runIndegree.get(target) ?? 0) - 1
        runIndegree.set(target, next)
        if (next === 0) ready.push(target)
      }
    }
  }
  const nodeIds = stages.flat()
  return {
    mode: options.mode,
    scopeNodeIds: [...scope],
    nodeIds,
    frozenNodeIds,
    stages,
  }
}

/** @deprecated Use planVdRun. */
export const planWorkflowRun = planVdRun
