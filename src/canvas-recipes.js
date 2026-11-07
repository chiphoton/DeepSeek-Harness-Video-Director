import { editVdCanvas, nodePorts, portHandleId, planVdRun } from '../lib/workflow-execution.js'
import { planCanvasLayout } from './canvas-layout.js'
import { DirectorInputError } from './validation.js'

export function sketchToH3(draft, definitions, workflows, { asset, brief, direction, duration, ollama, modelId, vramHandoffs }) {
  if (draft.graph.nodes.length || draft.graph.edges.length) throw new DirectorInputError('Use the sketch-to-H3 recipe on an empty canvas. Use edit to adapt an existing workflow.')
  const add = (id, kindOrType, data) => ({ op: 'add', id, ...(kindOrType.includes('.') ? { type: kindOrType } : { kind: kindOrType }), data })
  const trigger = (id, title, vramAction) => add(id, 'core.vram-trigger', { title, vramAction, vramActionInitialized: true })
  const inputMode = { prompt: { mode: 'input' } }
  const adds = [
    add('brief', 'load-text', { title: 'Reference image brief', text: brief }),
    add('sketch', `load-${asset.kind}`, { title: 'Sketch reference', asset, mediaKind: asset.kind }),
    add('reference', 'builtin.builtin-qwen-image-edit-consistent', { title: 'Generate the reference image', fieldInputModes: inputMode }),
    add('enhancer', 'prompt-enhancer', { title: 'Write the H3 prompt', providerId: ollama, ...(modelId && { modelId }), thinking: false,
      prompt: `Inspect the supplied finished image as <Picture 1>. Write only a concise ${duration}-second MiniMax H3 Ref2VA prompt. Preserve the visible subject, composition and style. Motion direction: ${direction}\nUse these sections in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Keep reference labels consistent and fit the actions to the clip duration. Do not invent dialogue or music unless requested.` }),
    { ...add('h3', 'video-generation', { title: 'Animate the reference', fieldInputModes: inputMode, duration }), workflowId: 'builtin-minimax-h3-reference-to-video-turbo' },
    ...[['image-preview', 'Reference preview'], ['text-preview', 'H3 prompt preview'], ['video-preview', 'Video preview']].map(([id, title]) => add(id, 'core.preview', { title })),
  ]
  if (vramHandoffs) adds.push(
    trigger('before-image', 'Release Ollama for image', 'ollama-eject'),
    trigger('before-prompt', 'Release ComfyUI for Ollama', 'comfyui-clear'),
    trigger('before-video', 'Release Ollama for H3', 'ollama-eject'),
    trigger('after-video', 'Release ComfyUI for review', 'comfyui-clear'),
  )
  const built = editVdCanvas(draft, adds, definitions, workflows)
  const nodes = new Map(built.graph.nodes.map(node => [node.id, node]))
  const handle = (id, side, name) => {
    const ports = nodePorts(nodes.get(id), definitions, side)
    const port = name === undefined ? ports[0] : ports.find(port => port.id === name)
    if (!port) throw new DirectorInputError(`The installed node definition has no ${name ?? side} port for ${id}.`)
    return portHandleId(side, port, ports)
  }
  const connect = (source, target, port) => ({ op: 'connect', id: `${source}-${target}`, source, target,
    sourceHandle: handle(source, 'output'), targetHandle: handle(target, 'input', port) })
  const links = [
    connect('brief', 'reference', 'field:prompt'), connect('sketch', 'reference', 'reference'),
    connect('reference', 'enhancer', 'reference'), connect('reference', 'h3', 'reference'),
    connect('enhancer', 'h3', 'field:prompt'), connect('reference', 'image-preview', 'media'),
    connect('enhancer', 'text-preview', 'media'), connect('h3', 'video-preview', 'media'),
  ]
  if (vramHandoffs) links.push(
    connect('before-image', 'reference', 'flow'), connect('reference', 'before-prompt', 'flow-in'), connect('before-prompt', 'enhancer', 'flow'),
    connect('enhancer', 'before-video', 'flow-in'), connect('before-video', 'h3', 'flow'), connect('h3', 'after-video', 'flow-in'),
  )
  editVdCanvas(built, links, definitions, workflows)
  const plan = planVdRun(built.graph, { mode: 'all' })
  const { changes } = planCanvasLayout(built.graph, definitions, undefined, { stageTitles: true })
  const positions = new Map(changes.map(row => [row.id, row]))
  for (const node of built.graph.nodes) {
    const row = positions.get(node.id)
    if (row?.position) node.position = row.position
    if (row?.title) node.data.title = row.title
  }
  return { draft: built, stages: plan.stages, nodeCount: built.graph.nodes.length, edgeCount: built.graph.edges.length }
}
