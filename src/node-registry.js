import { createHash } from 'node:crypto'

import { DirectorInputError, jsonValue, oneOf, record, string } from './validation.js'

// vd-node definitions and declarative packs. Embedded comfyui-nodes live in
// implementation.workflow; installing a pack does not install ComfyUI Python extensions.
export const VD_NODE_PROTOCOL = 'video-director.node/v1'

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*(?:[./][a-z0-9]+(?:-[a-z0-9]+)*)$/u
const OPERATIONS = ['image-generation', 'image-edit', 'video-generation', 'audio-generation']
const MEDIA_TYPES = ['text', 'image', 'audio', 'video', 'sketch', 'mask', 'flow']
const PLACEMENTS = ['primary', 'advanced']
const CONTROLS = ['input', 'textarea', 'select', 'slider', 'checkbox']
const RESERVED_FIELDS = new Set([
  'prompt', 'negativePrompt', 'seed', 'width', 'height', 'duration', 'fps',
  'steps', 'scheduler', 'variant', 'includeAudio',
])

const CORE_DEFINITIONS = [
  {
    type: 'core.preview',
    version: '1.0.0',
    digest: 'builtin:core.preview@1.0.0',
    title: 'Preview',
    description: 'Preview text, image, audio, or video outputs without copying their bytes.',
    category: 'output',
    builtIn: true,
    behavior: 'preview',
    operation: undefined,
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], multiple: true }],
    fields: [],
    parameterInputs: [],
  },
  {
    type: 'core.save',
    version: '1.0.0',
    digest: 'builtin:core.save@1.0.0',
    title: 'Save Output',
    description: 'Name and download immutable project outputs. Save never accepts an arbitrary server filesystem path.',
    category: 'output',
    builtIn: true,
    behavior: 'save',
    operation: undefined,
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [],
    fields: [{
      id: 'name',
      label: 'Output name',
      type: 'text',
      schema: { type: 'string' },
      default: '',
      placement: 'primary',
      control: 'input',
    }],
    parameterInputs: [],
  },
  {
    type: 'core.vram-trigger',
    version: '1.0.0',
    digest: 'builtin:core.vram-trigger@1.0.0',
    title: 'VRAM Trigger',
    description: 'Optionally eject Ollama models or unload ComfyUI models and clear its cache before workflow execution continues.',
    category: 'utility',
    builtIn: true,
    behavior: 'trigger',
    execution: 'system.trigger',
    triggerAction: 'vram-trigger',
    operation: undefined,
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }],
    fields: [
      {
        id: 'vramAction',
        label: 'Action',
        type: 'text',
        schema: { type: 'string', enum: ['skip', 'ollama-eject', 'comfyui-clear'] },
        default: 'skip',
        placement: 'primary',
        control: 'select',
        choices: ['skip', 'ollama-eject', 'comfyui-clear'],
      },
      {
        id: 'vramReleaseWaitSeconds',
        label: 'Release model wait (seconds)',
        type: 'number',
        schema: { type: 'number', min: 0, max: 300, step: 1, integer: true },
        default: 10,
        placement: 'primary',
        control: 'input',
        min: 0,
        max: 300,
        step: 1,
        integer: true,
      },
    ],
    parameterInputs: [],
  },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function nodeType(value, label = 'node type') {
  const parsed = string(value, label, { min: 3, max: 128 })
  if (!TYPE_PATTERN.test(parsed)) {
    throw new DirectorInputError(`${label} must be a lowercase namespaced identifier using dot or slash notation`)
  }
  return parsed
}

function version(value, label = 'node version') {
  const parsed = string(value, label, { min: 5, max: 64 })
  if (!VERSION_PATTERN.test(parsed)) throw new DirectorInputError(`${label} must be a semantic version`)
  return parsed
}

function primitiveType(value) {
  if (typeof value === 'string') return 'text'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

function normalizePort(value, label) {
  const input = record(value, label)
  const types = Array.isArray(input.types)
    ? [...new Set(input.types.map((item, index) => oneOf(item, `${label}.types[${String(index)}]`, MEDIA_TYPES)))]
    : []
  if (types.length === 0) throw new DirectorInputError(`${label}.types must not be empty`)
  return {
    id: string(input.id, `${label}.id`, { min: 1, max: 64 }),
    label: string(input.label ?? input.id, `${label}.label`, { min: 1, max: 120 }),
    types,
    required: input.required === true,
    multiple: input.multiple === true,
  }
}

function normalizePorts(value, label) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new DirectorInputError(`${label} must be an array with at most 32 ports`)
  }
  const ids = new Set()
  return value.map((entry, index) => {
    const port = normalizePort(entry, `${label}[${String(index)}]`)
    if (ids.has(port.id)) throw new DirectorInputError(`${label} port id ${port.id} must be unique`)
    ids.add(port.id)
    return port
  })
}

function rejectUnknownSchemaKeys(schema, allowed, label) {
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) throw new DirectorInputError(`${label}.${key} is not supported`)
  }
}

function optionalLength(value, label, options = {}) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? 1_000_000)) {
    throw new DirectorInputError(`${label} must be an integer from ${String(options.min ?? 0)} to ${String(options.max ?? 1_000_000)}`)
  }
  return value
}

function optionalFinite(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DirectorInputError(`${label} must be a finite number`)
  }
  return value
}

function normalizeFieldSchema(value, label) {
  const input = record(jsonValue(value, label, 64 * 1024), label)
  const type = oneOf(input.type, `${label}.type`, ['string', 'number', 'boolean'])
  if (type === 'string') {
    rejectUnknownSchemaKeys(input, new Set(['type', 'enum', 'minLength', 'maxLength']), label)
    let enumValues
    if (input.enum !== undefined) {
      if (!Array.isArray(input.enum) || input.enum.length === 0 || input.enum.length > 512) {
        throw new DirectorInputError(`${label}.enum must contain between 1 and 512 strings`)
      }
      enumValues = input.enum.map((choice, index) => {
        if (typeof choice !== 'string' || choice.length > 512) {
          throw new DirectorInputError(`${label}.enum[${String(index)}] must be a string with at most 512 characters`)
        }
        return choice
      })
      if (new Set(enumValues).size !== enumValues.length) {
        throw new DirectorInputError(`${label}.enum choices must be unique`)
      }
    }
    const minLength = optionalLength(input.minLength, `${label}.minLength`)
    const maxLength = optionalLength(input.maxLength, `${label}.maxLength`, { min: 1 })
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new DirectorInputError(`${label}.minLength must not exceed maxLength`)
    }
    return {
      type,
      ...(enumValues === undefined ? {} : { enum: enumValues }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
    }
  }
  if (type === 'number') {
    rejectUnknownSchemaKeys(input, new Set(['type', 'min', 'max', 'step', 'integer']), label)
    const min = optionalFinite(input.min, `${label}.min`)
    const max = optionalFinite(input.max, `${label}.max`)
    const step = optionalFinite(input.step, `${label}.step`)
    if (step !== undefined && step <= 0) throw new DirectorInputError(`${label}.step must be greater than 0`)
    if (input.integer !== undefined && typeof input.integer !== 'boolean') {
      throw new DirectorInputError(`${label}.integer must be a boolean`)
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new DirectorInputError(`${label}.min must not exceed max`)
    }
    return {
      type,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
      ...(input.integer === undefined ? {} : { integer: input.integer }),
    }
  }
  rejectUnknownSchemaKeys(input, new Set(['type']), label)
  return { type }
}

function onDeclaredStep(value, schema) {
  if (schema.step === undefined) return true
  const quotient = (value - (schema.min ?? 0)) / schema.step
  return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient))
}

function fieldValueViolation(schema, value) {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'must be a string'
    if (schema.minLength !== undefined && value.length < schema.minLength) return `must contain at least ${String(schema.minLength)} characters`
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `must contain at most ${String(schema.maxLength)} characters`
    if (schema.enum !== undefined && !schema.enum.includes(value)) return 'must be one of its declared choices'
    return undefined
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number'
    if (schema.integer === true && !Number.isSafeInteger(value)) return 'must be an integer'
    if (schema.min !== undefined && value < schema.min) return `must be at least ${String(schema.min)}`
    if (schema.max !== undefined && value > schema.max) return `must be at most ${String(schema.max)}`
    if (!onDeclaredStep(value, schema)) return `must align to step ${String(schema.step)}`
    return undefined
  }
  return typeof value === 'boolean' ? undefined : 'must be a boolean'
}

function normalizeField(value, index) {
  const label = `manifest.fields[${String(index)}]`
  const input = record(value, label)
  const schema = normalizeFieldSchema(input.schema, `${label}.schema`)
  const schemaType = schema.type
  const fieldType = schemaType === 'string' ? 'text' : schemaType
  const field = {
    id: string(input.id, `${label}.id`, { min: 1, max: 128 }),
    label: string(input.label ?? input.id, `${label}.label`, { min: 1, max: 256 }),
    type: fieldType,
    schema,
    default: input.default,
    placement: oneOf(input.placement, `${label}.placement`, PLACEMENTS),
    control: input.control === undefined
      ? (schema.enum === undefined ? (fieldType === 'boolean' ? 'checkbox' : 'input') : 'select')
      : oneOf(input.control, `${label}.control`, CONTROLS),
    description: string(input.description ?? '', `${label}.description`, { max: 1_000 }),
    order: input.order === undefined ? index : Number(input.order),
    choices: schema.enum,
  }
  if (primitiveType(field.default) !== field.type) {
    throw new DirectorInputError(`${label}.default does not match ${field.type}`)
  }
  const violation = fieldValueViolation(schema, field.default)
  if (violation !== undefined) throw new DirectorInputError(`${label}.default ${violation}`)
  if (field.control === 'textarea' && field.type !== 'text') {
    throw new DirectorInputError(`${label}.control textarea requires a string field`)
  }
  if (field.control === 'slider' && field.type !== 'number') {
    throw new DirectorInputError(`${label}.control slider requires a number field`)
  }
  if (field.control === 'checkbox' && field.type !== 'boolean') {
    throw new DirectorInputError(`${label}.control checkbox requires a boolean field`)
  }
  if (field.control === 'select' && field.choices === undefined) {
    throw new DirectorInputError(`${label}.control select requires schema.enum`)
  }
  if (!Number.isSafeInteger(field.order) || field.order < 0 || field.order > 10_000) {
    throw new DirectorInputError(`${label}.order must be an integer from 0 to 10000`)
  }
  return field
}

function normalizeFields(value) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new DirectorInputError('manifest.fields must be an array with at most 256 fields')
  }
  const ids = new Set()
  return value.map((entry, index) => {
    const field = normalizeField(entry, index)
    if (ids.has(field.id)) throw new DirectorInputError(`manifest field id ${field.id} must be unique`)
    ids.add(field.id)
    return field
  })
}

function normalizeBinding(value, index, fields, inputs) {
  const label = `implementation.bindings[${String(index)}]`
  const input = record(value, label)
  const target = record(input.target, `${label}.target`)
  const source = record(input.source, `${label}.source`)
  const normalized = {
    target: {
      nodeId: string(target.nodeId, `${label}.target.nodeId`, { min: 1, max: 128 }),
      input: string(target.input, `${label}.target.input`, { min: 1, max: 128 }),
    },
  }
  const kind = oneOf(source.kind, `${label}.source.kind`, ['field', 'port', 'runtime', 'literal'])
  if (kind === 'field') {
    const fieldId = string(source.fieldId, `${label}.source.fieldId`, { min: 1, max: 128 })
    if (!fields.has(fieldId)) throw new DirectorInputError(`${label} references missing field ${fieldId}`)
    return { ...normalized, source: { kind, fieldId } }
  }
  if (kind === 'port') {
    const portId = string(source.portId, `${label}.source.portId`, { min: 1, max: 64 })
    const port = inputs.get(portId)
    if (port === undefined) throw new DirectorInputError(`${label} references missing input port ${portId}`)
    if (source.index !== undefined && source.portIndex !== undefined && source.index !== source.portIndex) {
      throw new DirectorInputError(`${label}.source index and portIndex must agree when both are present`)
    }
    const portIndex = source.portIndex ?? source.index ?? 0
    if (!Number.isSafeInteger(portIndex) || portIndex < 0 || portIndex > 31) {
      throw new DirectorInputError(`${label}.source.portIndex must be an integer from 0 to 31`)
    }
    if (port.multiple !== true && portIndex !== 0) {
      throw new DirectorInputError(`${label}.source.portIndex must be 0 because port ${portId} is not multiple`)
    }
    return { ...normalized, source: { kind, portId, portIndex } }
  }
  if (kind === 'runtime') {
    return { ...normalized, source: { kind, value: oneOf(source.value, `${label}.source.value`, ['seed', 'projectId']) } }
  }
  return { ...normalized, source: { kind, value: jsonValue(source.value, `${label}.source.value`) } }
}

export function normalizeVdNodePack(value) {
  const input = record(value, 'node pack')
  if (input.protocol !== VD_NODE_PROTOCOL) {
    throw new DirectorInputError(`node pack protocol must be ${VD_NODE_PROTOCOL}`)
  }
  const manifest = record(input.manifest, 'node pack manifest')
  const implementation = record(input.implementation, 'node pack implementation')
  if (implementation.kind !== 'comfyui.workflow') {
    throw new DirectorInputError('browser-imported nodes may only use the declarative comfyui.workflow implementation')
  }
  if (implementation.output !== 'auto') {
    throw new DirectorInputError('comfyui.workflow implementation.output must be auto')
  }
  const fields = normalizeFields(manifest.fields ?? [])
  const inputs = normalizePorts(manifest.inputs ?? [], 'manifest.inputs')
  const outputs = normalizePorts(manifest.outputs ?? [], 'manifest.outputs')
  const fieldIds = new Set(fields.map(field => field.id))
  const inputById = new Map(inputs.map(port => [port.id, port]))
  if (!Array.isArray(implementation.bindings) || implementation.bindings.length > 512) {
    throw new DirectorInputError('implementation.bindings must be an array with at most 512 entries')
  }
  const bindings = implementation.bindings.map((entry, index) => normalizeBinding(entry, index, fieldIds, inputById))
  const targets = new Set()
  const boundFields = new Set()
  for (const binding of bindings) {
    const target = `${binding.target.nodeId}:${binding.target.input}`
    if (targets.has(target)) throw new DirectorInputError(`workflow target ${target} may only be bound once`)
    targets.add(target)
    if (binding.source.kind === 'field') boundFields.add(binding.source.fieldId)
  }
  for (const field of fields) {
    if (!boundFields.has(field.id)) throw new DirectorInputError(`manifest field ${field.id} has no workflow binding`)
  }
  const normalized = {
    protocol: VD_NODE_PROTOCOL,
    type: nodeType(input.type),
    version: version(input.version),
    manifest: {
      title: string(manifest.title, 'manifest.title', { min: 1, max: 120 }),
      description: string(manifest.description ?? '', 'manifest.description', { max: 1_000 }),
      category: oneOf(manifest.category, 'manifest.category', ['input', 'text', 'image', 'audio', 'video', 'utility', 'output']),
      inputs,
      outputs,
      fields,
    },
    implementation: {
      kind: 'comfyui.workflow',
      operation: oneOf(implementation.operation, 'implementation.operation', OPERATIONS),
      workflow: jsonValue(implementation.workflow, 'implementation.workflow', 20 * 1024 * 1024),
      bindings,
      output: 'auto',
      ...(implementation.modelFamily === undefined ? {} : {
        modelFamily: string(implementation.modelFamily, 'implementation.modelFamily', { min: 1, max: 128 }),
      }),
    },
  }
  return { ...normalized, digest: digest(normalized) }
}

function inferredPorts(workflow) {
  const inputs = []
  const inputById = new Map()
  for (const binding of Array.isArray(workflow.bindings) ? workflow.bindings : []) {
    if (binding.from !== 'asset' && binding.from !== 'maskAsset') continue
    const id = binding.portId ?? 'reference'
    let port = inputById.get(id)
    if (port === undefined) {
      port = { id, label: id === 'reference' ? 'Reference' : id, types: [], multiple: true }
      inputById.set(id, port)
      inputs.push(port)
    }
    const types = binding.from === 'maskAsset'
      ? ['mask']
      : binding.referenceKind !== undefined
        ? [binding.referenceKind]
      : ['image', 'audio', 'video', 'sketch', 'mask']
    for (const type of types) {
      if (!port.types.includes(type)) port.types.push(type)
    }
    if (binding.referenceKind !== undefined) {
      port.maxByType ??= {}
      port.maxByType[binding.referenceKind] = Math.max(
        port.maxByType[binding.referenceKind] ?? 0,
        (binding.portIndex ?? 0) + 1,
      )
    }
  }
  const outputType = workflow.kind === 'audio-generation' ? 'audio' : workflow.kind === 'video-generation' ? 'video' : 'image'
  return {
    inputs,
    outputs: [{ id: 'result', label: 'Result', types: [outputType], multiple: true }],
  }
}

function inferredCategory(kind) {
  if (kind === 'audio-generation') return 'audio'
  if (kind === 'video-generation') return 'video'
  return 'image'
}

function parameterInputsForWorkflow(workflow, fields) {
  const inputs = fields
    .filter(field => field.type === 'text')
    .map(field => ({ id: field.id, label: field.label, type: 'text' }))
  const seen = new Set(inputs.map(field => field.id))
  for (const binding of Array.isArray(workflow.bindings) ? workflow.bindings : []) {
    if (binding.from !== 'prompt' && binding.from !== 'negativePrompt') continue
    if (seen.has(binding.from)) continue
    seen.add(binding.from)
    inputs.push({
      id: binding.from,
      label: binding.from === 'prompt' ? 'Prompt' : 'Negative prompt',
      type: 'text',
    })
  }
  return inputs
}

function workflowDefinition(workflow) {
  const ports = inferredPorts(workflow)
  const manifest = workflow.nodeManifest ?? {
    title: workflow.name,
    description: workflow.description,
    category: inferredCategory(workflow.kind),
    ...ports,
    fields: workflow.parameters.map(parameter => ({
      id: parameter.id,
      label: parameter.label,
      type: parameter.type,
      schema: parameter.type === 'text' ? { type: 'string' } : { type: parameter.type },
      default: parameter.default,
      placement: parameter.placement,
      control: parameter.control,
      description: parameter.description,
      order: parameter.order,
      choices: parameter.choices,
    })),
  }
  const fields = workflow.nodeManifest === undefined
    ? manifest.fields
    : manifest.fields.map((field, index) => ({
        id: field.id,
        label: field.label,
        type: field.type ?? (field.schema?.type === 'string' ? 'text' : field.schema?.type),
        schema: field.schema,
        default: field.default,
        placement: field.placement,
        control: field.control,
        description: field.description ?? '',
        order: field.order ?? index,
        choices: field.choices ?? field.schema?.enum,
        min: field.schema?.min,
        max: field.schema?.max,
        step: field.schema?.step,
        integer: field.schema?.integer,
        minLength: field.schema?.minLength,
        maxLength: field.schema?.maxLength,
      }))
  const declaredInputs = clone(manifest.inputs ?? ports.inputs)
  if (!declaredInputs.some(port => port.id === 'flow')) {
    declaredInputs.push({ id: 'flow', label: 'Flow', types: ['flow'], multiple: true })
  }
  return {
    type: workflow.nodeType ?? `local.workflow.${workflow.id}`,
    version: workflow.nodeVersion ?? '1.0.0',
    digest: workflow.nodeDigest ?? `workflow:${workflow.id}`,
    title: manifest.title ?? workflow.name,
    description: manifest.description ?? workflow.description,
    category: manifest.category ?? inferredCategory(workflow.kind),
    builtIn: workflow.builtIn,
    behavior: 'workflow',
    execution: 'comfyui.workflow',
    operation: workflow.kind,
    workflowKind: workflow.kind,
    workflowId: workflow.id,
    modelFamily: workflow.modelFamily,
    inputs: declaredInputs,
    outputs: clone(manifest.outputs ?? ports.outputs),
    fields: clone(fields ?? []),
    parameterInputs: parameterInputsForWorkflow(workflow, fields ?? []),
  }
}

function convertBinding(binding, fieldById, inputById) {
  const target = { nodeId: binding.target.nodeId, input: binding.target.input }
  if (binding.source.kind === 'field') {
    const field = fieldById.get(binding.source.fieldId)
    if (RESERVED_FIELDS.has(field.id)) return { ...target, from: field.id }
    return undefined
  }
  if (binding.source.kind === 'port') {
    const port = inputById.get(binding.source.portId)
    const onlyMask = port.types.length === 1 && port.types[0] === 'mask'
    return {
      ...target,
      from: onlyMask ? 'maskAsset' : 'asset',
      portId: binding.source.portId,
      portIndex: binding.source.portIndex,
    }
  }
  if (binding.source.kind === 'runtime') return { ...target, from: binding.source.value }
  return { ...target, from: 'literal', value: binding.source.value }
}

function fieldFailure(field, message) {
  const error = new DirectorInputError(`field ${field.id} ${message}`, { path: `fields.${field.id}` })
  error.code = 'video-director/field-value-invalid'
  throw error
}

function validateFieldValue(field, value) {
  const schema = normalizeFieldSchema(field.schema, `field ${field.id}.schema`)
  const violation = fieldValueViolation(schema, value)
  if (violation !== undefined) fieldFailure(field, violation)
}

export class VdNodeRegistry {
  constructor(workflows) {
    this.workflows = workflows
    this.mutationQueue = Promise.resolve()
  }

  list() {
    return [
      ...CORE_DEFINITIONS.map(clone),
      ...this.workflows.list().map(workflow => workflowDefinition(this.workflows.get(workflow.id))),
    ].sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.category.localeCompare(right.category) || left.title.localeCompare(right.title))
  }

  get(typeValue, versionValue) {
    const type = nodeType(typeValue)
    const requestedVersion = version(versionValue)
    const definition = this.list().find(row => row.type === type && row.version === requestedVersion)
    if (definition === undefined) {
      const error = new Error(`node definition ${type}@${requestedVersion} was not found`)
      error.code = 'video-director/node-version-not-found'
      throw error
    }
    return definition
  }

  validateInstance(typeValue, versionValue, requestValue) {
    const definition = this.get(typeValue, versionValue)
    if (definition.behavior !== 'workflow' || definition.workflowId === undefined) return definition
    const workflow = this.workflows.get(definition.workflowId)
    const fields = workflow.nodeManifest?.fields
    if (!Array.isArray(fields)) return definition
    const request = record(requestValue, 'node request')
    const workflowValues = request.workflowValues === undefined ? {} : record(request.workflowValues, 'workflowValues')
    for (const field of fields) {
      const value = RESERVED_FIELDS.has(field.id)
        ? (request[field.id] ?? field.default)
        : (workflowValues[field.id] ?? field.default)
      validateFieldValue(field, value)
    }
    return definition
  }

  async install(value) {
    const pack = normalizeVdNodePack(value)
    return this.#enqueueMutation(async () => {
      const existing = this.list().find(row => row.type === pack.type && row.version === pack.version)
      if (existing !== undefined) {
        if (existing.digest === pack.digest) return existing
        const error = new Error(`node definition ${pack.type}@${pack.version} already exists with different content`)
        error.code = 'video-director/node-version-conflict'
        throw error
      }
      const fieldById = new Map(pack.manifest.fields.map(field => [field.id, field]))
      const inputById = new Map(pack.manifest.inputs.map(port => [port.id, port]))
      const parameterTargets = new Map()
      const bindings = []
      const defaults = {}
      for (const binding of pack.implementation.bindings) {
        const converted = convertBinding(binding, fieldById, inputById)
        if (converted !== undefined) bindings.push(converted)
        if (binding.source.kind !== 'field') continue
        const field = fieldById.get(binding.source.fieldId)
        if (RESERVED_FIELDS.has(field.id)) {
          defaults[field.id] = field.default
          continue
        }
        const targets = parameterTargets.get(field.id) ?? []
        targets.push({ nodeId: binding.target.nodeId, input: binding.target.input })
        parameterTargets.set(field.id, targets)
      }
      const parameters = pack.manifest.fields.flatMap((field) => {
        const targets = parameterTargets.get(field.id)
        if (targets === undefined) return []
        return [{
          id: field.id,
          nodeId: targets[0].nodeId,
          input: targets[0].input,
          targets,
          label: field.label,
          group: field.placement === 'primary' ? 'Main' : 'Workflow',
          type: field.type,
          default: field.default,
          placement: field.placement,
          control: field.control,
          description: field.description,
          order: field.order,
          choices: field.choices,
        }]
      })
      const workflow = await this.workflows.import({
        name: pack.manifest.title,
        kind: pack.implementation.operation,
        description: pack.manifest.description,
        document: pack.implementation.workflow,
        bindings,
        parameters,
        defaults,
        modelFamily: pack.implementation.modelFamily,
        nodeType: pack.type,
        nodeVersion: pack.version,
        nodeDigest: pack.digest,
        nodeManifest: pack.manifest,
      })
      return workflowDefinition(workflow)
    })
  }

  async remove(typeValue, versionValue) {
    return this.#enqueueMutation(async () => {
      const definition = this.get(typeValue, versionValue)
      if (definition.builtIn || definition.workflowId === undefined) {
        throw new DirectorInputError('built-in node definitions cannot be removed')
      }
      await this.workflows.remove(definition.workflowId)
    })
  }

  #enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

// Compatibility exports; these have always described Video Director declarations.
/** @deprecated Use VdNodeRegistry. */
export { VdNodeRegistry as NodeRegistry }
/** @deprecated Use normalizeVdNodePack. */
export { normalizeVdNodePack as normalizeNodePack }
/** @deprecated Use VD_NODE_PROTOCOL. */
export { VD_NODE_PROTOCOL as NODE_PROTOCOL }
