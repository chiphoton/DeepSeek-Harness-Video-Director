import { resolveConnectionPorts } from './ports'
import { recomputeSinkPayloads } from './node-results'
import type { DirectorNode, DirectorNodeData, ProjectDraft, VdNodeDefinitionDescriptor, ComfyWorkflowDescriptor } from './types'

/** Shared node construction for the editor and Host canvas tools. */
export function createDefinedVdNode(definition: VdNodeDefinitionDescriptor, workflows: ComfyWorkflowDescriptor[], position = { x: 0, y: 0 }): DirectorNode {
  const data: DirectorNodeData = { kind: definition.operation ?? definition.behavior as DirectorNodeData['kind'],
    title: definition.title, nodeType: definition.type, nodeVersion: definition.version, nodeDigest: definition.digest, status: 'idle' }
  if (definition.behavior === 'workflow') {
    const workflow = workflows.find(item => item.id === definition.workflowId)
    if (!workflow || !definition.operation) throw new Error('Node definition is missing its workflow implementation')
    Object.assign(data, { kind: definition.operation, prompt: '', providerId: 'comfyui', workflowId: workflow.id,
      workflowValues: Object.fromEntries(workflow.parameters.map(field => [field.id, field.default])), modelFamily: workflow.modelFamily, ...workflow.defaults })
  } else if (definition.behavior === 'media') {
    Object.assign(data, { providerId: 'ffmpeg', mediaOptions: Object.fromEntries(definition.fields.filter(field => typeof field.default === 'number').map(field => [field.id, field.default])) })
  } else if (definition.behavior === 'trigger') {
    if (!definition.triggerAction) throw new Error('Trigger has no action')
    data.kind = definition.triggerAction
    if (data.kind === 'vram-trigger') Object.assign(data, { vramAction: 'skip', vramReleaseWaitSeconds: 10, vramActionInitialized: false })
  } else if (definition.behavior === 'save') data.outputName = ''
  else if (definition.behavior === 'batch-input') data.batch = { source: 'text', text: '', startIndex: 1, sort: 'input', recursive: true, errorPolicy: 'stop' }
  return { id: crypto.randomUUID(), type: 'director', position, data }
}

export type VdCanvasEdit = { op: string; [key: string]: any }
const plain = (value: any): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  if (Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Invalid property')
  return value
}
const immutable = ['kind', 'nodeType', 'nodeVersion', 'nodeDigest', 'workflowId']
const derived = ['status', 'phase', 'progress', 'jobId', 'runStartedAt', 'runCompletedAt', 'error', 'result', 'batchRunId', 'batchCaseIndex']
function dataPatch(value: any): Partial<DirectorNodeData> {
  const patch = plain(value)
  if ([...immutable, ...derived].some(key => key in patch)) throw new Error('Node definitions and execution results cannot be overwritten; create a node or run it instead')
  for (const key of ['title', 'text', 'prompt', 'negativePrompt', 'providerId', 'modelId', 'systemPrompt', 'outputName']) {
    if (key in patch && typeof patch[key] !== 'string') throw new Error(`${key} must be text`)
  }
  for (const key of ['frozen', 'thinking', 'includeAudio', 'previewCleared', 'vramActionInitialized']) {
    if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
  }
  for (const key of ['width', 'height', 'fps', 'duration', 'steps', 'seed', 'contextLength', 'vramReleaseWaitSeconds']) {
    if (key in patch && !Number.isFinite(patch[key])) throw new Error(`${key} must be a finite number`)
  }
  for (const key of ['asset', 'maskAsset', 'sketchDocument', 'batch', 'workflowValues', 'fieldInputModes', 'transform', 'trim', 'mediaOptions']) {
    if (key in patch) plain(patch[key])
  }
  return patch
}
const position = (value: any) => {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error('Position requires finite x and y')
  return { x: value.x, y: value.y }
}

/** A whole edit batch succeeds or fails before the store commits its draft. */
export function editVdCanvas(draft: ProjectDraft, edits: VdCanvasEdit[], definitions: VdNodeDefinitionDescriptor[], workflows: ComfyWorkflowDescriptor[]): ProjectDraft {
  const graph = draft.graph
  const requireNode = (id: string) => { const node = graph.nodes.find(node => node.id === id); if (!node) throw new Error(`Unknown node: ${id}`); return node }
  for (const edit of edits) {
    switch (edit.op) {
      case 'add': {
        let node: DirectorNode
        const point = position(edit.position ?? { x: graph.nodes.length * 40, y: graph.nodes.length * 40 })
        const definition = definitions.find(item => item.type === edit.type && (!edit.version || edit.version === item.version))
        if (edit.type && !definition) throw new Error(`Unknown node definition: ${edit.type}`)
        if (definition) node = createDefinedVdNode(definition, workflows, point)
        else {
          if (!['load-text', 'load-image', 'load-audio', 'load-video', 'load-sketch', 'prompt-enhancer', 'image-generation'].includes(edit.kind)) throw new Error('Choose a node type from catalog or a supported built-in kind')
          const mediaKind = edit.kind.startsWith('load-') ? edit.kind.slice(5) : undefined
          node = { id: crypto.randomUUID(), type: 'director', position: point, data: { kind: edit.kind, title: mediaKind ?? edit.kind, status: 'idle',
            ...(mediaKind ? { mediaKind, ...(mediaKind === 'text' ? { text: '' } : {}) } : { prompt: '', providerId: edit.kind === 'prompt-enhancer' ? String(draft.settings.defaultTextProvider ?? 'ollama') : String(draft.settings.defaultImageProvider ?? 'openai') }) } }
        }
        if (edit.id !== undefined) {
          if (typeof edit.id !== 'string' || !/^[\w-]{1,128}$/.test(edit.id)) throw new Error('Invalid node id')
          node.id = edit.id
        }
        if (graph.nodes.some(item => item.id === node.id)) throw new Error('Node id already exists')
        if (edit.data) Object.assign(node.data, dataPatch(edit.data))
        graph.nodes.push(node)
        break
      }
      case 'update': {
        const node = requireNode(edit.id)
        const patch = dataPatch(edit.data)
        node.data = { ...node.data, ...patch }
        break
      }
      case 'move': requireNode(edit.id).position = position(edit.position); break
      case 'remove': requireNode(edit.id); graph.nodes = graph.nodes.filter(node => node.id !== edit.id); graph.edges = graph.edges.filter(edge => edge.source !== edit.id && edge.target !== edit.id); break
      case 'clone': {
        const original = requireNode(edit.id)
        const clone = structuredClone(original)
        clone.id = edit.newId ?? crypto.randomUUID()
        if (typeof clone.id !== 'string' || !/^[\w-]{1,128}$/.test(clone.id) || graph.nodes.some(node => node.id === clone.id)) throw new Error('Invalid or duplicate clone id')
        clone.position = position(edit.position ?? { x: original.position.x + 60, y: original.position.y + 60 })
        graph.nodes.push(clone); break
      }
      case 'connect': {
        const edge = { id: edit.id ?? crypto.randomUUID(), source: edit.source, target: edit.target, sourceHandle: edit.sourceHandle, targetHandle: edit.targetHandle, data: edit.data }
        if (typeof edge.id !== 'string' || graph.edges.some(item => item.id === edge.id)) throw new Error('Invalid or duplicate edge id')
        requireNode(edge.source); requireNode(edge.target)
        const ports = resolveConnectionPorts(graph, definitions, edge)
        graph.edges.push({ ...edge, sourceHandle: ports.sourceHandle, targetHandle: ports.targetHandle, data: { ...edge.data, sourcePortId: ports.sourcePortId, targetPortId: ports.targetPortId } })
        break
      }
      case 'disconnect': if (!graph.edges.some(edge => edge.id === edit.id)) throw new Error('Unknown edge'); graph.edges = graph.edges.filter(edge => edge.id !== edit.id); break
      case 'edge': { const edge = graph.edges.find(edge => edge.id === edit.id); if (!edge) throw new Error('Unknown edge'); edge.data = { ...edge.data, ...plain(edit.data) }; break }
      case 'rename': if (typeof edit.name !== 'string' || !edit.name.trim() || edit.name.length > 120) throw new Error('Invalid workflow name'); draft.name = edit.name.trim(); break
      case 'settings': draft.settings = { ...draft.settings, ...plain(edit.data) }; break
      case 'viewport': graph.viewport = { ...position(edit), zoom: edit.zoom }; if (!(edit.zoom > 0 && edit.zoom <= 8)) throw new Error('Invalid zoom'); break
      default: throw new Error(`Unknown edit: ${edit.op}`)
    }
  }
  graph.nodes = recomputeSinkPayloads(graph.nodes, graph.edges, definitions)
  return draft
}
