import type {
  DirectorEdge,
  DirectorGraph,
  DirectorNode,
  DirectorNodeData,
  MediaKind,
  VdNodeDefinitionDescriptor,
  VdPortDescriptor,
} from './types'
import {
  isFieldInputPort,
  parameterInputPorts,
} from './parameter-inputs'

export type PortDirection = 'input' | 'output'

export function shouldShowPortLabel(
  direction: PortDirection,
  port: Pick<VdPortDescriptor, 'id' | 'label'>,
  showLabels = true,
): boolean {
  return direction === 'output'
    && showLabels
    && !(port.id === 'result' && port.label === 'Result')
}

export function shouldShowReferencePanel(
  kind: DirectorNodeData['kind'],
  referencePort: VdPortDescriptor | undefined,
): boolean {
  return kind === 'prompt-enhancer'
    || ((kind === 'image-generation' || kind === 'image-edit' || kind === 'video-generation' || kind === 'audio-generation')
      && referencePort !== undefined)
}

export function embeddedWorkflowInputPortIds(
  _data: DirectorNodeData,
  inputs: readonly VdPortDescriptor[],
): string[] {
  return inputs
    .filter(port => port.id === 'reference' || isFieldInputPort(port.id))
    .map(port => port.id)
}

export function nodeDefinition(
  data: DirectorNodeData,
  definitions: readonly VdNodeDefinitionDescriptor[],
): VdNodeDefinitionDescriptor | undefined {
  if (data.nodeType !== undefined) {
    return definitions.find(candidate => (
      candidate.type === data.nodeType
        && candidate.version === (data.nodeVersion ?? '1.0.0')
    ))
  }
  if (data.workflowId === undefined) return undefined
  return definitions.find(candidate => (
    candidate.behavior === 'workflow' && candidate.workflowId === data.workflowId
  ))
}

export function portsFor(
  definition: VdNodeDefinitionDescriptor | undefined,
  direction: PortDirection,
): readonly VdPortDescriptor[] {
  return definition?.[direction === 'input' ? 'inputs' : 'outputs'] ?? []
}

export function portHandleId(
  direction: PortDirection,
  port: VdPortDescriptor,
  portCountOrPorts: number | readonly VdPortDescriptor[],
): string {
  if (direction === 'input' && isFieldInputPort(port.id)) return `in:${port.id}`
  if (direction === 'input' && port.types.length === 1 && port.types[0] === 'flow') return `in:${port.id}`
  const portCount = typeof portCountOrPorts === 'number'
    ? portCountOrPorts
    : direction === 'input'
      ? portCountOrPorts.filter(candidate => !isFieldInputPort(candidate.id) && !candidate.types.includes('flow')).length
      : portCountOrPorts.length
  if (portCount === 1) return direction === 'input' ? 'in' : 'out'
  return `${direction === 'input' ? 'in' : 'out'}:${port.id}`
}

function portFromPorts(
  ports: readonly VdPortDescriptor[],
  direction: PortDirection,
  handle: string | null | undefined,
): VdPortDescriptor | undefined {
  if (ports.length === 0) return undefined
  const legacy = direction === 'input' ? 'in' : 'out'
  const dataPorts = direction === 'input'
    ? ports.filter(port => !isFieldInputPort(port.id) && !port.types.includes('flow'))
    : ports
  const legacyPorts = direction === 'input' && dataPorts.length === 0
    ? ports.filter(port => !isFieldInputPort(port.id))
    : dataPorts
  if (legacyPorts.length === 1 && (handle === undefined || handle === null || handle === legacy)) {
    return legacyPorts[0]
  }
  const prefix = `${legacy}:`
  if (typeof handle !== 'string' || !handle.startsWith(prefix)) return undefined
  return ports.find(port => port.id === handle.slice(prefix.length))
}

export function portFromHandle(
  definition: VdNodeDefinitionDescriptor | undefined,
  direction: PortDirection,
  handle: string | null | undefined,
): VdPortDescriptor | undefined {
  const ports = portsFor(definition, direction)
  return portFromPorts(ports, direction, handle)
}

export function inferredNodeOutputTypes(node: DirectorNode): MediaKind[] {
  // Preview is a pass-through sink. Legacy projects may not carry the built-in
  // node definition, so keep all of its supported outputs connectable before
  // and after it receives data (including mixed-media previews).
  if (node.data.kind === 'preview') return ['text', 'image', 'audio', 'video']
  const result = node.data.result
  if (result !== null && typeof result === 'object' && 'kind' in result) {
    if (result.kind === 'assets' && 'assets' in result && Array.isArray(result.assets)) {
      return [...new Set(result.assets.map(asset => asset.kind))]
    }
    if (result.kind === 'text' || result.kind === 'mcp-result') return ['text']
  }
  const explicit = node.data.mediaKind
  if (explicit !== undefined) return node.data.maskAsset === undefined || explicit === 'mask'
    ? [explicit]
    : [explicit, 'mask']
  if (node.data.kind === 'load-text' || node.data.kind === 'prompt-enhancer' || node.data.kind === 'output-text') return ['text']
  if (node.data.kind === 'load-image' || node.data.kind === 'image-generation' || node.data.kind === 'image-edit' || node.data.kind === 'output-image') {
    return node.data.maskAsset === undefined ? ['image'] : ['image', 'mask']
  }
  if (node.data.kind === 'load-audio' || node.data.kind === 'audio-generation' || node.data.kind === 'output-audio') return ['audio']
  if (node.data.kind === 'load-video' || node.data.kind === 'video-generation' || node.data.kind === 'output-video') return ['video']
  if (node.data.kind === 'load-sketch') return ['sketch']
  return []
}

export function mediaTypesIntersect(left: readonly MediaKind[], right: readonly MediaKind[]): boolean {
  if (left.includes('flow') || right.includes('flow')) return true
  return left.some(type => right.includes(type))
}

export function isTriggerNodeKind(kind: DirectorNodeData['kind']): boolean {
  return kind === 'vram-trigger' || kind === 'ollama-eject' || kind === 'comfyui-clear'
}

export function implicitInputPortForKind(kind: DirectorNodeData['kind']): VdPortDescriptor | undefined {
  if (kind.startsWith('load-')) return undefined
  if (kind === 'output-text') return { id: 'input', label: 'Text', types: ['text'], multiple: true }
  if (kind === 'output-image') return { id: 'input', label: 'Image', types: ['image'], multiple: true }
  if (kind === 'output-audio') return { id: 'input', label: 'Audio', types: ['audio'], multiple: true }
  if (kind === 'output-video') return { id: 'input', label: 'Video', types: ['video'], multiple: true }
  if (kind === 'prompt-enhancer') return { id: 'reference', label: 'Reference', types: ['text', 'image', 'audio', 'video', 'sketch'], multiple: true }
  if (kind === 'image-generation' || kind === 'image-edit') return { id: 'reference', label: 'Reference', types: ['image', 'sketch', 'mask'], multiple: true }
  if (kind === 'video-generation') return { id: 'reference', label: 'Reference', types: ['image', 'audio', 'video', 'sketch', 'mask'], multiple: true }
  if (kind === 'audio-generation') return { id: 'reference', label: 'Reference', types: ['audio', 'video'], multiple: true }
  return { id: 'input', label: 'Input', types: ['text', 'image', 'audio', 'video', 'sketch', 'mask'], multiple: true }
}

function inlineWorkflowInputPorts(data: DirectorNodeData): VdPortDescriptor[] | undefined {
  if (data.workflow === undefined || !Array.isArray(data.bindings)) return undefined
  const ports = new Map<string, VdPortDescriptor>()
  for (const binding of data.bindings) {
    if (binding.from !== 'asset' && binding.from !== 'maskAsset') continue
    const id = binding.portId ?? 'reference'
    let port = ports.get(id)
    if (port === undefined) {
      port = {
        id,
        label: id === 'reference' ? 'Reference' : id,
        types: [],
        multiple: true,
      }
      ports.set(id, port)
    }
    const types: MediaKind[] = binding.from === 'maskAsset'
      ? ['mask']
      : ['image', 'audio', 'video', 'sketch', 'mask']
    for (const type of types) {
      if (!port.types.includes(type)) port.types.push(type)
    }
  }
  return [...ports.values()]
}

export function inputPortsFor(
  data: DirectorNodeData,
  definition: VdNodeDefinitionDescriptor | undefined,
): readonly VdPortDescriptor[] {
  const declared = definition?.inputs
    ?? inlineWorkflowInputPorts(data)
    ?? (implicitInputPortForKind(data.kind) === undefined ? [] : [implicitInputPortForKind(data.kind)!])
  const videoMode = data.workflowId === 'builtin-minimax-h3-reference-to-video-turbo'
    ? undefined
    : data.videoMode ?? (data.workflowId === 'builtin-minimax-h3-video-turbo' ? 'text-to-video' : undefined)
  const modeDeclared = data.kind !== 'video-generation' || videoMode === undefined
    ? [...declared]
    : videoMode === 'text-to-video'
      ? declared.filter(port => port.id !== 'reference')
      : declared.map(port => port.id !== 'reference'
          ? port
          : {
              ...port,
              required: true,
              multiple: videoMode === 'first-to-last-frame',
            })
  const withFlow = (
    data.kind === 'prompt-enhancer'
    || data.kind === 'image-generation'
    || data.kind === 'image-edit'
    || data.kind === 'video-generation'
    || data.kind === 'audio-generation'
  ) && !modeDeclared.some(port => port.id === 'flow')
    ? [...modeDeclared, { id: 'flow', label: 'Flow', types: ['flow'] as MediaKind[], multiple: true }]
    : [...modeDeclared]
  return [...withFlow, ...parameterInputPorts(data, definition)]
}

function implicitOutputPort(node: DirectorNode): VdPortDescriptor | undefined {
  const types = inferredNodeOutputTypes(node)
  return types.length === 0 ? undefined : { id: 'output', label: 'Output', types, multiple: true }
}

export interface ResolvedConnectionPorts {
  sourcePortId: string
  targetPortId: string
  sourceHandle: string
  targetHandle: string
  sourceTypes: MediaKind[]
  targetTypes: MediaKind[]
}

export interface ResolvedNodePort {
  port: VdPortDescriptor
  handle: string
}

export function preferredCompatibleInputPort(
  inputs: readonly VdPortDescriptor[],
  sourceTypes: readonly MediaKind[],
): VdPortDescriptor | undefined {
  const compatible = inputs.filter(input => mediaTypesIntersect(sourceTypes, input.types))
  if (sourceTypes.includes('flow')) return compatible.find(input => input.types.includes('flow')) ?? compatible[0]
  return compatible.find(input => input.required === true) ?? compatible[0]
}

function declaredPort(
  node: DirectorNode,
  definitions: readonly VdNodeDefinitionDescriptor[],
  direction: PortDirection,
  handle: string | null | undefined,
): { port: VdPortDescriptor; handle: string } | undefined {
  const definition = nodeDefinition(node.data, definitions)
  const ports = direction === 'input'
    ? inputPortsFor(node.data, definition)
    : definition?.outputs ?? (implicitOutputPort(node) === undefined ? [] : [implicitOutputPort(node)!])
  const port = portFromPorts(ports, direction, handle)
  if (port === undefined) return undefined
  return { port, handle: portHandleId(direction, port, ports) }
}

export function resolveNodePort(
  graph: DirectorGraph,
  definitions: readonly VdNodeDefinitionDescriptor[],
  nodeId: string,
  direction: PortDirection,
  handle: string | null | undefined,
): ResolvedNodePort {
  const node = graph.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`Connection ${direction} node was not found.`)
  const resolved = declaredPort(node, definitions, direction, handle)
  if (resolved === undefined) throw new Error(`Select a declared ${direction} port.`)
  return resolved
}

export function resolveEdgePorts(
  graph: DirectorGraph,
  definitions: readonly VdNodeDefinitionDescriptor[],
  edge: Pick<DirectorEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>,
): ResolvedConnectionPorts {
  if (edge.source === edge.target) throw new Error('A node cannot connect to itself.')
  const source = graph.nodes.find(node => node.id === edge.source)
  const target = graph.nodes.find(node => node.id === edge.target)
  if (source === undefined || target === undefined) throw new Error('Connection endpoint was not found.')
  const output = declaredPort(source, definitions, 'output', edge.sourceHandle)
  const input = declaredPort(target, definitions, 'input', edge.targetHandle)
  if (output === undefined) throw new Error('Select a declared output port.')
  if (input === undefined) throw new Error('Select a declared input port.')
  if (!mediaTypesIntersect(output.port.types, input.port.types)) {
    throw new Error(`${output.port.label} cannot connect to ${input.port.label}: their media types do not overlap.`)
  }
  return {
    sourcePortId: output.port.id,
    targetPortId: input.port.id,
    sourceHandle: output.handle,
    targetHandle: input.handle,
    sourceTypes: [...output.port.types],
    targetTypes: [...input.port.types],
  }
}

export function resolveConnectionPorts(
  graph: DirectorGraph,
  definitions: readonly VdNodeDefinitionDescriptor[],
  edge: Pick<DirectorEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>,
): ResolvedConnectionPorts {
  const resolved = resolveEdgePorts(graph, definitions, edge)
  const target = graph.nodes.find(node => node.id === edge.target)
  if (target === undefined) throw new Error('Connection target was not found.')
  const input = declaredPort(target, definitions, 'input', resolved.targetHandle)
  if (input === undefined) throw new Error('Select a declared input port.')
  const used = graph.edges.filter(candidate => {
    if (candidate.target !== target.id) return false
    if (candidate.data?.targetPortId !== undefined) return candidate.data.targetPortId === resolved.targetPortId
    const existing = declaredPort(target, definitions, 'input', candidate.targetHandle)
    return existing?.port.id === resolved.targetPortId
  }).length
  if (input.port.multiple !== true && used > 0) {
    throw new Error(`${input.port.label} accepts only one connection.`)
  }
  const source = graph.nodes.find(node => node.id === edge.source)
  const sourceKind = source?.data.asset?.kind
    ?? source?.data.mediaKind
    ?? (source === undefined ? undefined : inferredNodeOutputTypes(source).find(type => resolved.targetTypes.includes(type)))
  const typeLimit = sourceKind === undefined ? undefined : input.port.maxByType?.[sourceKind]
  if (typeLimit !== undefined) {
    const usedForType = graph.edges.filter(candidate => {
      if (candidate.target !== target.id) return false
      try {
        const existing = resolveEdgePorts(graph, definitions, candidate)
        if (existing.targetPortId !== resolved.targetPortId) return false
        const existingSource = graph.nodes.find(node => node.id === candidate.source)
        const existingKind = existingSource?.data.asset?.kind
          ?? existingSource?.data.mediaKind
          ?? (existingSource === undefined ? undefined : inferredNodeOutputTypes(existingSource).find(type => existing.targetTypes.includes(type)))
        return existingKind === sourceKind
      } catch {
        return false
      }
    }).length
    if (usedForType >= typeLimit) {
      throw new Error(`${input.port.label} accepts at most ${String(typeLimit)} ${sourceKind} connection${typeLimit === 1 ? '' : 's'}.`)
    }
  }
  return resolved
}

export function validateNodeInputPorts(
  graph: DirectorGraph,
  definitions: readonly VdNodeDefinitionDescriptor[],
  nodeId: string,
): void {
  const node = graph.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`Node ${nodeId} was not found.`)
  const definition = nodeDefinition(node.data, definitions)
  const inputs = inputPortsFor(node.data, definition)
  const counts = new Map<string, number>()
  const typeCounts = new Map<string, number>()
  for (const edge of graph.edges.filter(candidate => candidate.target === nodeId)) {
    const resolved = resolveEdgePorts(graph, definitions, edge)
    const source = graph.nodes.find(candidate => candidate.id === edge.source)
    if (!isTriggerNodeKind(node.data.kind) && source !== undefined && isTriggerNodeKind(source.data.kind)) continue
    counts.set(resolved.targetPortId, (counts.get(resolved.targetPortId) ?? 0) + 1)
    const sourceKind = source?.data.asset?.kind
      ?? source?.data.mediaKind
      ?? (source === undefined ? undefined : inferredNodeOutputTypes(source).find(type => resolved.targetTypes.includes(type)))
    if (sourceKind !== undefined) {
      const key = `${resolved.targetPortId}\u0000${sourceKind}`
      typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1)
    }
  }
  for (const port of inputs) {
    const count = counts.get(port.id) ?? 0
    if (port.required === true && count === 0) throw new Error(`${port.label} is required.`)
    if (port.multiple !== true && count > 1) throw new Error(`${port.label} accepts only one connection.`)
    for (const [kind, limit] of Object.entries(port.maxByType ?? {})) {
      if (limit === undefined) continue
      const typeCount = typeCounts.get(`${port.id}\u0000${kind}`) ?? 0
      if (typeCount > limit) {
        throw new Error(`${port.label} accepts at most ${String(limit)} ${kind} connection${limit === 1 ? '' : 's'}.`)
      }
    }
  }
}
