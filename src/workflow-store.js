import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { DirectorInputError, jsonValue, oneOf, record, string } from './validation.js'

// Owns registered comfyui-workflows and their graph-local binding targets.
// The canvas vd-workflow belongs to ProjectStore; workflows.json is a stable storage name.
const WORKFLOW_KINDS = [
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
]

const PARAMETER_TYPES = ['text', 'number', 'boolean']
const PARAMETER_PLACEMENTS = ['primary', 'advanced']
const PARAMETER_CONTROLS = ['input', 'textarea', 'select', 'slider', 'checkbox']
const VIDEO_MODES = [
  'text-to-video',
  'first-frame-locked',
  'last-frame-locked',
  'first-to-last-frame',
]
const BINDING_SOURCES = [
  'prompt', 'negativePrompt', 'seed', 'width', 'height', 'duration', 'frames', 'fps',
  'steps', 'scheduler', 'variant', 'asset', 'maskAsset', 'trimStart', 'trimEnd',
  'inputWidth', 'inputHeight', 'aspectRatio', 'includeAudio', 'referenceRole', 'literal',
  'projectId',
]
const DEFAULT_KEYS = [
  'prompt',
  'negativePrompt',
  'modelFamily',
  'seed',
  'width',
  'height',
  'duration',
  'fps',
  'variant',
  'steps',
  'scheduler',
  'includeAudio',
  'seedControlAfterGenerate',
  'videoMode',
]

const BUILTIN_DOCUMENTS = [
  {
    id: 'builtin-qwen-image-edit-consistent',
    name: 'Qwen-Image-Edit (Consistent)',
    kind: 'image-generation',
    file: new URL('../custom_nodes/qwen-image-edit-consistent.node.json', import.meta.url),
  },
  {
    id: 'builtin-z-image-turbo',
    name: 'Z-Image Turbo',
    kind: 'image-generation',
    file: new URL('../custom_nodes/z-image-turbo.node.json', import.meta.url),
  },
  {
    id: 'builtin-minimax-h3-video-turbo',
    name: 'MiniMax-H3 Text/Image to Video (Turbo)',
    kind: 'video-generation',
    file: new URL('../custom_nodes/minimax-h3-t2v-turbo.node.json', import.meta.url),
  },
  {
    id: 'builtin-minimax-h3-reference-to-video-turbo',
    name: 'MiniMax-H3 Reference to Video (Turbo)',
    kind: 'video-generation',
    file: new URL('../custom_nodes/minimax-h3-r2v-turbo.node.json', import.meta.url),
  },
  {
    id: 'builtin-minimax-h3-audio-turbo',
    name: 'MiniMax-H3 Audio (Turbo)',
    kind: 'audio-generation',
    file: new URL('../custom_nodes/minimax-h3-audio-turbo.node.json', import.meta.url),
  },
  {
    id: 'builtin-minimax-h3-audio-standard',
    name: 'MiniMax-H3 Audio (Standard)',
    kind: 'audio-generation',
    file: new URL('../custom_nodes/minimax-h3-audio-standard.node.json', import.meta.url),
  },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function contentDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveType(value) {
  if (typeof value === 'string') return 'text'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

function workflowGraph(value) {
  const document = record(value, 'workflow document')
  if (Array.isArray(document.nodes)) {
    throw new DirectorInputError('This is a ComfyUI UI workflow. Export it with “Save (API Format)” and import that JSON instead.')
  }
  const embedded = isRecord(document.nodeData) ? document.nodeData : undefined
  const candidate = embedded?.workflow ?? document.prompt ?? document.workflow ?? document
  const workflow = record(candidate, 'ComfyUI API workflow')
  const entries = Object.entries(workflow)
  if (entries.length === 0 || entries.length > 4_000) {
    throw new DirectorInputError('API-format comfyui-workflow must contain between 1 and 4000 comfyui-nodes')
  }
  for (const [nodeId, value] of entries) {
    const node = record(value, `workflow[${nodeId}]`)
    string(node.class_type, `workflow[${nodeId}].class_type`, { min: 1, max: 256 })
    record(node.inputs, `workflow[${nodeId}].inputs`)
  }
  return jsonValue(workflow, 'ComfyUI API workflow', 20 * 1024 * 1024)
}

function normalizeBinding(value, index) {
  const input = record(value, `bindings[${String(index)}]`)
  let mediaIndex
  if (input.mediaIndex !== undefined) {
    mediaIndex = Number(input.mediaIndex)
    if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 0 || mediaIndex > 31) {
      throw new DirectorInputError(`bindings[${String(index)}].mediaIndex must be an integer from 0 to 31`)
    }
  }
  let portId
  let portIndex
  if (input.portId !== undefined) {
    portId = string(input.portId, `bindings[${String(index)}].portId`, { min: 1, max: 64 })
    portIndex = input.portIndex === undefined ? 0 : Number(input.portIndex)
    if (!Number.isSafeInteger(portIndex) || portIndex < 0 || portIndex > 31) {
      throw new DirectorInputError(`bindings[${String(index)}].portIndex must be an integer from 0 to 31`)
    }
  } else if (input.portIndex !== undefined) {
    throw new DirectorInputError(`bindings[${String(index)}].portIndex requires portId`)
  }
  if (input.optional !== undefined && typeof input.optional !== 'boolean') {
    throw new DirectorInputError(`bindings[${String(index)}].optional must be a boolean`)
  }
  if (input.omitNodeWhenMissing !== undefined && typeof input.omitNodeWhenMissing !== 'boolean') {
    throw new DirectorInputError(`bindings[${String(index)}].omitNodeWhenMissing must be a boolean`)
  }
  if (input.omitNodeWhenMissing === true && input.optional !== true) {
    throw new DirectorInputError(`bindings[${String(index)}].omitNodeWhenMissing requires optional`)
  }
  const frameRole = input.frameRole === undefined
    ? undefined
    : oneOf(input.frameRole, `bindings[${String(index)}].frameRole`, ['first', 'last'])
  if (frameRole !== undefined && (input.from !== 'asset' || portId === undefined)) {
    throw new DirectorInputError(`bindings[${String(index)}].frameRole requires an asset binding with portId`)
  }
  const referenceKind = input.referenceKind === undefined
    ? undefined
    : oneOf(input.referenceKind, `bindings[${String(index)}].referenceKind`, ['image', 'audio', 'video'])
  if (referenceKind !== undefined && (input.from !== 'asset' || portId === undefined)) {
    throw new DirectorInputError(`bindings[${String(index)}].referenceKind requires an asset binding with portId`)
  }
  let omitNodeIdsWhenMissing
  if (input.omitNodeIdsWhenMissing !== undefined) {
    if (input.optional !== true || input.omitNodeWhenMissing !== true) {
      throw new DirectorInputError(`bindings[${String(index)}].omitNodeIdsWhenMissing requires optional and omitNodeWhenMissing`)
    }
    if (!Array.isArray(input.omitNodeIdsWhenMissing) || input.omitNodeIdsWhenMissing.length === 0 || input.omitNodeIdsWhenMissing.length > 32) {
      throw new DirectorInputError(`bindings[${String(index)}].omitNodeIdsWhenMissing must contain between 1 and 32 node ids`)
    }
    omitNodeIdsWhenMissing = [...new Set(input.omitNodeIdsWhenMissing.map((nodeId, nodeIndex) => (
      string(nodeId, `bindings[${String(index)}].omitNodeIdsWhenMissing[${String(nodeIndex)}]`, { min: 1, max: 128 })
    )))]
  }
  return {
    nodeId: string(input.nodeId, `bindings[${String(index)}].nodeId`, { min: 1, max: 128 }),
    input: string(input.input, `bindings[${String(index)}].input`, { min: 1, max: 128 }),
    from: oneOf(input.from, `bindings[${String(index)}].from`, BINDING_SOURCES),
    ...(input.assetId === undefined ? {} : { assetId: string(input.assetId, `bindings[${String(index)}].assetId`, { min: 1, max: 128 }) }),
    ...(mediaIndex === undefined ? {} : { mediaIndex }),
    ...(portId === undefined ? {} : { portId, portIndex }),
    ...(input.value === undefined ? {} : { value: jsonValue(input.value, `bindings[${String(index)}].value`) }),
    ...(input.optional === true ? { optional: true } : {}),
    ...(input.omitNodeWhenMissing === true ? { omitNodeWhenMissing: true } : {}),
    ...(frameRole === undefined ? {} : { frameRole }),
    ...(referenceKind === undefined ? {} : { referenceKind }),
    ...(omitNodeIdsWhenMissing === undefined ? {} : { omitNodeIdsWhenMissing }),
  }
}

function omitWorkflowNode(workflow, nodeId) {
  delete workflow[nodeId]
  for (const nodeValue of Object.values(workflow)) {
    if (!isRecord(nodeValue) || !isRecord(nodeValue.inputs)) continue
    for (const [inputName, value] of Object.entries(nodeValue.inputs)) {
      if (Array.isArray(value) && String(value[0]) === nodeId) delete nodeValue.inputs[inputName]
    }
  }
}

function applyVideoMode(workflow, bindings, modeValue) {
  const frameBindings = bindings.filter(binding => binding.frameRole !== undefined)
  if (frameBindings.length === 0) return { workflow, bindings }
  const videoMode = oneOf(modeValue ?? 'text-to-video', 'videoMode', VIDEO_MODES)
  const activeRoles = videoMode === 'first-to-last-frame'
    ? new Set(['first', 'last'])
    : videoMode === 'first-frame-locked'
      ? new Set(['first'])
      : videoMode === 'last-frame-locked'
        ? new Set(['last'])
        : new Set()
  const activeBindings = []
  for (const binding of bindings) {
    if (binding.frameRole === undefined) {
      activeBindings.push(binding)
      continue
    }
    if (!activeRoles.has(binding.frameRole)) {
      omitWorkflowNode(workflow, binding.nodeId)
      continue
    }
    const {
      optional: _optional,
      omitNodeWhenMissing: _omitNodeWhenMissing,
      ...requiredBinding
    } = binding
    activeBindings.push({
      ...requiredBinding,
      portIndex: videoMode === 'last-frame-locked'
        ? 0
        : binding.frameRole === 'last' ? 1 : 0,
    })
  }
  return {
    workflow,
    bindings: activeBindings,
    videoMode,
    requiredReferenceCount: activeRoles.size,
    framePortId: frameBindings[0].portId,
  }
}

function normalizeBindings(value, workflow) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 512) {
    throw new DirectorInputError('workflow bindings must be an array with at most 512 entries')
  }
  const targets = new Set()
  return value.map((entry, index) => {
    const binding = normalizeBinding(entry, index)
    const comfyNode = workflow[binding.nodeId]
    if (!isRecord(comfyNode)) {
      throw new DirectorInputError(`binding ${binding.nodeId}.${binding.input} references a missing comfyui-node`)
    }
    if (!isRecord(comfyNode.inputs) || !Object.hasOwn(comfyNode.inputs, binding.input)) {
      throw new DirectorInputError(`binding ${binding.nodeId}.${binding.input} references a missing comfyui-node input`)
    }
    for (const omittedNodeId of binding.omitNodeIdsWhenMissing ?? []) {
      if (!isRecord(workflow[omittedNodeId])) {
        throw new DirectorInputError(`binding ${binding.nodeId}.${binding.input} references missing omitted node ${omittedNodeId}`)
      }
    }
    const target = `${binding.nodeId}:${binding.input}`
    if (targets.has(target)) throw new DirectorInputError(`binding target ${binding.nodeId}.${binding.input} must be unique`)
    targets.add(target)
    return binding
  })
}

function semanticSource(node, inputName, state) {
  const key = inputName.toLowerCase()
  const classType = String(node.class_type).toLowerCase()
  if (classType === 'loadimage' && key === 'image') {
    const source = state.loadImages === 0 ? 'asset' : 'maskAsset'
    state.loadImages += 1
    return source
  }
  if (key === 'negative_prompt' || key === 'negativeprompt' || key === 'negative') return 'negativePrompt'
  if (key === 'prompt' || key === 'positive_prompt' || key === 'positiveprompt') return 'prompt'
  if (classType.includes('textencode') && key === 'text') {
    const source = state.textEncoders === 0 ? 'prompt' : state.textEncoders === 1 ? 'negativePrompt' : undefined
    state.textEncoders += 1
    return source
  }
  if (key === 'seed' || key === 'noise_seed' || key === 'random_seed') return 'seed'
  if (key === 'width') return 'width'
  if (key === 'height') return 'height'
  if (key === 'fps' || key === 'frame_rate') return 'fps'
  if (key === 'steps') return 'steps'
  if (key === 'scheduler') return 'scheduler'
  if (key === 'duration' || key === 'seconds') return 'duration'
  if (key === 'length' || key === 'frames' || key === 'frame_count' || key === 'num_frames') return 'frames'
  return undefined
}

function inferredPlacement(node, inputName, state) {
  const key = inputName.toLowerCase()
  const classType = String(node.class_type).toLowerCase()
  const important = new Set([
    'model', 'model_name', 'ckpt_name', 'checkpoint_name', 'unet_name',
    'cfg', 'guidance', 'guidance_scale', 'denoise', 'strength',
  ])
  if (state.primaryParameters < 3 && (important.has(key) || classType.includes('modelloader'))) {
    state.primaryParameters += 1
    return 'primary'
  }
  return 'advanced'
}

export function extractComfyWorkflowInterface(workflowValue, explicitBindings) {
  const workflow = workflowGraph(workflowValue)
  const supplied = normalizeBindings(explicitBindings, workflow)
  const bound = new Set((supplied ?? []).map(binding => `${binding.nodeId}:${binding.input}`))
  const bindings = supplied ?? []
  const parameters = []
  const state = { textEncoders: 0, loadImages: 0, primaryParameters: 0 }
  for (const [nodeId, nodeValue] of Object.entries(workflow)) {
    const node = record(nodeValue, `workflow[${nodeId}]`)
    const inputs = record(node.inputs, `workflow[${nodeId}].inputs`)
    for (const [inputName, defaultValue] of Object.entries(inputs)) {
      const type = primitiveType(defaultValue)
      if (type === undefined || bound.has(`${nodeId}:${inputName}`)) continue
      const source = supplied === undefined ? semanticSource(node, inputName, state) : undefined
      if (source !== undefined) {
        bindings.push({ nodeId, input: inputName, from: source })
        continue
      }
      if (parameters.length >= 256) continue
      parameters.push({
        id: `${nodeId}:${inputName}`,
        nodeId,
        input: inputName,
        label: `${String(node.class_type)} · ${inputName}`,
        group: String(node.class_type),
        type,
        default: defaultValue,
        placement: inferredPlacement(node, inputName, state),
        control: type === 'boolean' ? 'checkbox' : 'input',
        description: '',
        order: parameters.length,
      })
    }
  }
  return { workflow, bindings, parameters }
}

function normalizeParameter(value, index) {
  const input = record(value, `parameters[${String(index)}]`)
  const label = `parameters[${String(index)}]`
  const type = oneOf(input.type, `parameters[${String(index)}].type`, PARAMETER_TYPES)
  const defaultType = primitiveType(input.default)
  if (defaultType !== type) throw new DirectorInputError(`parameters[${String(index)}].default does not match ${type}`)
  const placement = oneOf(input.placement ?? 'advanced', `parameters[${String(index)}].placement`, PARAMETER_PLACEMENTS)
  const control = oneOf(input.control ?? (type === 'boolean' ? 'checkbox' : 'input'), `parameters[${String(index)}].control`, PARAMETER_CONTROLS)
  const order = input.order === undefined ? index : Number(input.order)
  if (!Number.isSafeInteger(order) || order < 0 || order > 10_000) {
    throw new DirectorInputError(`parameters[${String(index)}].order must be an integer from 0 to 10000`)
  }
  let choices
  if (input.choices !== undefined) {
    if (type !== 'text' || !Array.isArray(input.choices) || input.choices.length > 256) {
      throw new DirectorInputError(`parameters[${String(index)}].choices must be a string array for a text parameter`)
    }
    choices = input.choices.map((choice, choiceIndex) => string(choice, `parameters[${String(index)}].choices[${String(choiceIndex)}]`, { max: 512 }))
  }
  let targets
  if (input.targets !== undefined) {
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 512) {
      throw new DirectorInputError(`${label}.targets must contain between 1 and 512 workflow inputs`)
    }
    const seenTargets = new Set()
    targets = input.targets.map((targetValue, targetIndex) => {
      const target = record(targetValue, `${label}.targets[${String(targetIndex)}]`)
      const normalized = {
        nodeId: string(target.nodeId, `${label}.targets[${String(targetIndex)}].nodeId`, { min: 1, max: 128 }),
        input: string(target.input, `${label}.targets[${String(targetIndex)}].input`, { min: 1, max: 128 }),
      }
      const key = `${normalized.nodeId}:${normalized.input}`
      if (seenTargets.has(key)) throw new DirectorInputError(`${label}.targets must be unique`)
      seenTargets.add(key)
      return normalized
    })
    if (input.nodeId !== undefined && input.nodeId !== targets[0].nodeId) {
      throw new DirectorInputError(`${label}.nodeId must match the first target`)
    }
    if (input.input !== undefined && input.input !== targets[0].input) {
      throw new DirectorInputError(`${label}.input must match the first target`)
    }
  } else {
    targets = [{
      nodeId: string(input.nodeId, `${label}.nodeId`, { min: 1, max: 128 }),
      input: string(input.input, `${label}.input`, { min: 1, max: 128 }),
    }]
  }
  return {
    id: string(input.id, `parameters[${String(index)}].id`, { min: 1, max: 260 }),
    nodeId: targets[0].nodeId,
    input: targets[0].input,
    ...(input.targets === undefined ? {} : { targets }),
    label: string(input.label, `parameters[${String(index)}].label`, { min: 1, max: 256 }),
    group: string(input.group ?? 'Workflow', `parameters[${String(index)}].group`, { min: 1, max: 256 }),
    type,
    default: input.default,
    placement,
    control,
    description: string(input.description ?? '', `parameters[${String(index)}].description`, { max: 1_000 }),
    order,
    ...(choices === undefined ? {} : { choices }),
  }
}

function normalizeParameters(value, workflow) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new DirectorInputError('workflow parameters must be an array with at most 256 entries')
  }
  const ids = new Set()
  return value.map((entry, index) => {
    const parameter = normalizeParameter(entry, index)
    if (ids.has(parameter.id)) {
      throw new DirectorInputError(`workflow parameter id ${parameter.id} must be unique`)
    }
    ids.add(parameter.id)

    for (const target of parameter.targets ?? [{ nodeId: parameter.nodeId, input: parameter.input }]) {
      const node = workflow[target.nodeId]
      if (!isRecord(node)) {
        throw new DirectorInputError(`workflow parameter ${parameter.id} references missing node ${target.nodeId}`)
      }
      const inputs = node.inputs
      if (!isRecord(inputs) || !Object.hasOwn(inputs, target.input)) {
        throw new DirectorInputError(`workflow parameter ${parameter.id} references missing input ${target.nodeId}.${target.input}`)
      }
      const currentType = primitiveType(inputs[target.input])
      if (currentType === undefined) {
        throw new DirectorInputError(`workflow parameter ${parameter.id} must reference a primitive workflow input`)
      }
      if (currentType !== parameter.type) {
        throw new DirectorInputError(`workflow parameter ${parameter.id} type ${parameter.type} does not match workflow input type ${currentType}`)
      }
    }
    return parameter
  })
}

function defaultsFrom(value) {
  const source = isRecord(value) ? value : {}
  const defaults = {}
  for (const key of DEFAULT_KEYS) {
    if (source[key] !== undefined) defaults[key] = jsonValue(source[key], `defaults.${key}`)
  }
  return defaults
}

function inferredModelFamily(workflow) {
  const modelInputs = new Set([
    'model', 'model_name', 'model_file', 'unet_name', 'ckpt_name', 'checkpoint_name',
    'vae_name', 'lora_name', 'clip_name', 'text_encoder_name',
  ])
  for (const node of Object.values(workflow)) {
    const classType = String(node.class_type ?? '')
    if (/minimax[\s_-]*h3/iu.test(classType)) return 'minimax-h3'
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (modelInputs.has(inputName.toLowerCase())
        && typeof value === 'string'
        && /minimax[\s_-]*h3/iu.test(value)) return 'minimax-h3'
    }
  }
  return undefined
}

function publicWorkflow(workflow) {
  const { workflow: _workflow, bindings: _bindings, ...descriptor } = workflow
  return clone(descriptor)
}

function normalizeStoredWorkflow(value) {
  const input = record(value, 'stored workflow')
  const { workflow, bindings, parameters: inferred } = extractComfyWorkflowInterface(input.workflow, input.bindings)
  const declaredModelFamily = input.modelFamily === undefined
    ? undefined
    : string(input.modelFamily, 'workflow.modelFamily', { min: 1, max: 128 })
  const detectedModelFamily = inferredModelFamily(workflow)
  if (detectedModelFamily !== undefined
    && declaredModelFamily !== undefined
    && declaredModelFamily !== detectedModelFamily) {
    throw new DirectorInputError(`workflow modelFamily ${declaredModelFamily} conflicts with detected ${detectedModelFamily} topology`)
  }
  const parameters = input.parameters === undefined
    ? inferred
    : normalizeParameters(input.parameters, workflow)
  return {
    id: string(input.id, 'workflow.id', { min: 1, max: 128 }),
    name: string(input.name, 'workflow.name', { min: 1, max: 120 }),
    kind: oneOf(input.kind, 'workflow.kind', WORKFLOW_KINDS),
    description: string(input.description ?? '', 'workflow.description', { max: 1_000 }),
    builtIn: input.builtIn === true,
    modelFamily: detectedModelFamily ?? declaredModelFamily,
    nodeType: string(input.nodeType ?? `local.workflow.${String(input.id)}`, 'workflow.nodeType', { min: 3, max: 128 }),
    nodeVersion: string(input.nodeVersion ?? '1.0.0', 'workflow.nodeVersion', { min: 5, max: 64 }),
    nodeDigest: string(input.nodeDigest ?? contentDigest({ workflow, bindings, parameters }), 'workflow.nodeDigest', { min: 16, max: 128 }),
    ...(input.nodeManifest === undefined ? {} : { nodeManifest: jsonValue(input.nodeManifest, 'workflow.nodeManifest', 2 * 1024 * 1024) }),
    defaults: defaultsFrom(input.defaults),
    parameters,
    workflow,
    bindings,
    createdAt: string(input.createdAt, 'workflow.createdAt', { min: 20, max: 40 }),
    updatedAt: string(input.updatedAt, 'workflow.updatedAt', { min: 20, max: 40 }),
  }
}

async function builtinWorkflow(spec) {
  const document = JSON.parse(await readFile(spec.file, 'utf8'))
  const nodeData = record(document.nodeData, `${spec.id}.nodeData`)
  const extracted = extractComfyWorkflowInterface(nodeData.workflow, nodeData.bindings)
  const parameters = nodeData.parameters === undefined
    ? (spec.exposeUnboundParameters ? extracted.parameters : [])
    : normalizeParameters(nodeData.parameters, extracted.workflow)
  const now = '2026-09-01T00:00:00.000Z'
  return normalizeStoredWorkflow({
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    description: String(document.description ?? ''),
    builtIn: true,
    modelFamily: nodeData.modelFamily,
    nodeType: spec.nodeType ?? `builtin.${spec.id}`,
    nodeVersion: '1.0.0',
    nodeManifest: document.nodeManifest,
    defaults: defaultsFrom(nodeData),
    workflow: extracted.workflow,
    bindings: extracted.bindings,
    parameters,
    createdAt: now,
    updatedAt: now,
  })
}

/** Registry of ComfyUI API graphs, defaults, bindings, and exposed vd-node controls. */
export class ComfyWorkflowStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'workflows.json')
    this.workflows = new Map()
    this.writeQueue = Promise.resolve()
  }

  async init() {
    const workflows = new Map()
    const builtins = await Promise.all(BUILTIN_DOCUMENTS.map(builtinWorkflow))
    for (const workflow of builtins) workflows.set(workflow.id, workflow)
    let rows = []
    try {
      rows = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!Array.isArray(rows)) throw new Error('Video Director ComfyUI workflow registry must be an array')
    for (const row of rows) {
      const workflow = normalizeStoredWorkflow(row)
      if (!workflow.builtIn) workflows.set(workflow.id, workflow)
    }
    this.workflows = workflows
  }

  list() {
    return [...this.workflows.values()]
      .map(publicWorkflow)
      .sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name))
  }

  modelParameters() {
    return [...this.workflows.values()].flatMap(workflow => workflow.parameters.map(parameter => ({
      workflowId: workflow.id,
      parameterId: parameter.id,
      choices: parameter.choices,
      targets: (parameter.targets ?? [{ nodeId: parameter.nodeId, input: parameter.input }]).map(target => ({
        nodeClass: workflow.workflow[target.nodeId]?.class_type,
        input: target.input,
      })),
    })))
  }

  get(workflowId) {
    const id = string(workflowId, 'workflowId', { min: 1, max: 128 })
    const workflow = this.workflows.get(id)
    if (workflow === undefined) {
      const error = new Error(`workflow ${id} was not found`)
      error.code = 'video-director/workflow-not-found'
      throw error
    }
    return workflow
  }

  async import(inputValue) {
    return this.#enqueueWrite(async () => {
      const input = record(inputValue, 'workflow import')
      const document = record(input.document, 'workflow import document')
      const embedded = isRecord(document.nodeData) ? document.nodeData : {}
      const explicitBindings = input.bindings ?? embedded.bindings
      const extracted = extractComfyWorkflowInterface(document, explicitBindings)
      const parameters = input.parameters === undefined
        ? extracted.parameters
        : normalizeParameters(input.parameters, extracted.workflow)
      const now = new Date().toISOString()
      const id = randomUUID()
      const workflow = normalizeStoredWorkflow({
        id,
        name: input.name,
        kind: input.kind,
        description: input.description ?? document.description ?? '',
        builtIn: false,
        modelFamily: input.modelFamily ?? embedded.modelFamily,
        nodeType: input.nodeType ?? `local.workflow.${id}`,
        nodeVersion: input.nodeVersion ?? '1.0.0',
        nodeDigest: input.nodeDigest,
        nodeManifest: input.nodeManifest,
        defaults: { ...defaultsFrom(embedded), ...defaultsFrom(input.defaults) },
        workflow: extracted.workflow,
        bindings: extracted.bindings,
        parameters,
        createdAt: now,
        updatedAt: now,
      })
      const workflows = new Map(this.workflows)
      workflows.set(workflow.id, workflow)
      await this.#persist(workflows)
      this.workflows = workflows
      return publicWorkflow(workflow)
    })
  }

  async remove(workflowId) {
    return this.#enqueueWrite(async () => {
      const workflow = this.get(workflowId)
      if (workflow.builtIn) throw new DirectorInputError('built-in workflows cannot be removed')
      const workflows = new Map(this.workflows)
      workflows.delete(workflow.id)
      await this.#persist(workflows)
      this.workflows = workflows
    })
  }

  resolve(workflowId, valuesValue = {}, options = {}) {
    const source = this.get(workflowId)
    const values = record(valuesValue ?? {}, 'workflowValues')
    const workflow = clone(source.workflow)
    for (const parameter of source.parameters) {
      const value = values[parameter.id] ?? parameter.default
      if (primitiveType(value) !== parameter.type) {
        throw new DirectorInputError(`workflow parameter ${parameter.label} must be ${parameter.type}`)
      }
      for (const target of parameter.targets ?? [{ nodeId: parameter.nodeId, input: parameter.input }]) {
        workflow[target.nodeId].inputs[target.input] = value
      }
    }
    const modeResolved = applyVideoMode(workflow, clone(source.bindings), options.videoMode)
    return {
      ...modeResolved,
      modelFamily: source.modelFamily,
      workflowId: source.id,
      workflowName: source.name,
      workflowKind: source.kind,
    }
  }

  #enqueueWrite(operation) {
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async #persist(workflows) {
    await mkdir(dirname(this.path), { recursive: true })
    const rows = [...workflows.values()].filter(workflow => !workflow.builtIn)
    const temp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx' })
    await rename(temp, this.path)
  }
}

// Compatibility exports; new code uses names that identify the ComfyUI layer.
/** @deprecated Use ComfyWorkflowStore. */
export { ComfyWorkflowStore as WorkflowStore }
/** @deprecated Use extractComfyWorkflowInterface. */
export { extractComfyWorkflowInterface as extractWorkflowInterface }
