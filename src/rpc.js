import { DirectorInputError, finiteNumber, jsonValue, record, string, uuid } from './validation.js'

// Boundary vocabulary: workflows/* manages registered comfyui-workflows;
// nodes/* manages vd-node definitions; projects/* owns the canvas vd-workflow.
// jobs/start.nodeId identifies a vd-node, while binding.nodeId/target.nodeId
// identifies a comfyui-node. Keep these existing RPC keys and endpoints stable.
const RUN_SNAPSHOT_VERSION = 1
const MAX_RUN_SNAPSHOT_BYTES = 8 * 1024 * 1024
const FIELD_INPUT_PREFIX = 'field:'
const TOP_LEVEL_TEXT_FIELDS = new Set(['prompt', 'negativePrompt', 'scheduler', 'variant'])
const DIRECT_PARAMETER_INPUT_OPERATIONS = new Set([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
])

function success(value) {
  return { ok: true, value }
}

function failure(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'video-director/internal',
      message: error instanceof Error ? error.message : String(error),
      details: typeof error?.details === 'object' && error.details !== null ? error.details : {},
    },
  }
}

function publicModelCatalog(catalog, workflows) {
  const modelInputs = Array.isArray(catalog?.modelInputs) ? catalog.modelInputs : []
  if (modelInputs.length === 0) {
    return {
      models: Array.isArray(catalog?.models) ? catalog.models : [],
      workflowModels: [],
    }
  }
  const byInput = new Map(modelInputs.map(entry => [`${String(entry.nodeClass)}\u0000${String(entry.input)}`, entry.models]))
  const parameters = typeof workflows.modelParameters === 'function' ? workflows.modelParameters() : []
  const workflowModels = []
  const allModels = new Set()
  for (const parameter of parameters) {
    const targetChoices = parameter.targets.map(target => byInput.get(`${String(target.nodeClass)}\u0000${String(target.input)}`))
    // An exact, known ComfyUI input with no available choices is materially
    // different from an input that was not present in /object_info. Preserve
    // the former as an empty mapping so clients can disable its select instead
    // of falling back to stale manifest choices or a free-text field.
    if (targetChoices.length === 0 || targetChoices.some(choices => !Array.isArray(choices))) continue
    const allowed = targetChoices.slice(1).reduce(
      (choices, next) => choices.filter(choice => next.includes(choice)),
      [...targetChoices[0]],
    )
    const models = parameter.choices === undefined
      ? allowed
      : allowed.filter(choice => parameter.choices.includes(choice))
    workflowModels.push({ workflowId: parameter.workflowId, parameterId: parameter.parameterId, models })
    for (const model of models) allModels.add(model)
  }
  return {
    models: [...allModels].sort((left, right) => left.localeCompare(right)),
    workflowModels,
  }
}

function withPublicModels(result, workflows) {
  const { models: _models, modelInputs: _modelInputs, ...rest } = result
  return { ...rest, ...publicModelCatalog(result, workflows) }
}

function comfyWorkflowReferences(projectValue) {
  const nodes = projectValue?.graph?.nodes
  if (!Array.isArray(nodes)) return []
  const references = []
  for (const [index, node] of nodes.entries()) {
    const workflowId = node?.data?.workflowId
    if (workflowId === undefined) continue
    if (typeof workflowId !== 'string' || workflowId === '') {
      throw new DirectorInputError(`project.graph.nodes[${String(index)}].data.workflowId must be a non-empty string`)
    }
    references.push(workflowId)
  }
  return [...new Set(references)]
}

function vdNodeDefinitionReferences(projectValue) {
  const graphNodes = projectValue?.graph?.nodes
  if (!Array.isArray(graphNodes)) return []
  const references = []
  for (const [index, node] of graphNodes.entries()) {
    const type = node?.data?.nodeType
    if (type === undefined) continue
    references.push({
      type: string(type, `project.graph.nodes[${String(index)}].data.nodeType`, { min: 3, max: 128 }),
      version: string(node?.data?.nodeVersion ?? '1.0.0', `project.graph.nodes[${String(index)}].data.nodeVersion`, { min: 5, max: 64 }),
    })
  }
  return references
}

function portFailure(code, message, details = {}) {
  const error = new DirectorInputError(message, details)
  error.code = `video-director/${code}`
  throw error
}

function mediaPortId(input, implicitPorts, index) {
  const declared = input.portId ?? input.targetPortId
  if (declared === undefined || declared === null || declared === '' || declared === 'in') {
    if (implicitPorts.length === 1) return implicitPorts[0].id
    const suffix = implicitPorts.length === 0 ? 'because the node declares no input ports' : 'when the node declares multiple input ports'
    portFailure('port-binding-invalid', `mediaInputs[${String(index)}].portId is required ${suffix}`, {
      path: `mediaInputs.${String(index)}.portId`,
    })
  }
  const value = string(declared, `mediaInputs[${String(index)}].portId`, { min: 1, max: 270 })
  return value.startsWith('in:') ? value.slice(3) : value
}

function fieldInputCandidates(definition, workflow, operation) {
  const candidates = new Map()
  if (definition === undefined && workflow === undefined && DIRECT_PARAMETER_INPUT_OPERATIONS.has(operation)) {
    candidates.set('prompt', { id: 'prompt', type: 'text', storage: 'request' })
    if (operation !== 'prompt-enhancer') {
      candidates.set('negativePrompt', { id: 'negativePrompt', type: 'text', storage: 'request' })
    }
    return candidates
  }
  const manifestFields = workflow?.nodeManifest?.fields
  if (Array.isArray(manifestFields)) {
    for (const field of Array.isArray(definition?.fields) ? definition.fields : manifestFields) {
      candidates.set(field.id, {
        id: field.id,
        type: field.type ?? (field.schema?.type === 'string' ? 'text' : field.schema?.type),
        storage: TOP_LEVEL_TEXT_FIELDS.has(field.id) ? 'request' : 'workflowValues',
      })
    }
    return candidates
  }
  for (const parameter of Array.isArray(workflow?.parameters) ? workflow.parameters : []) {
    candidates.set(parameter.id, {
      id: parameter.id,
      type: parameter.type,
      storage: 'workflowValues',
    })
  }
  for (const binding of Array.isArray(workflow?.bindings) ? workflow.bindings : []) {
    if (binding.from !== 'prompt' && binding.from !== 'negativePrompt') continue
    if (!candidates.has(binding.from)) {
      candidates.set(binding.from, { id: binding.from, type: 'text', storage: 'request' })
    }
  }
  if (workflow === undefined) {
    for (const field of Array.isArray(definition?.fields) ? definition.fields : []) {
      candidates.set(field.id, {
        id: field.id,
        type: field.type,
        storage: TOP_LEVEL_TEXT_FIELDS.has(field.id) ? 'request' : 'workflowValues',
      })
    }
  }
  return candidates
}

function normalizeFieldInputModes(value, candidates) {
  if (value === undefined) return []
  let modes
  try {
    modes = record(value, 'fieldInputModes')
  } catch {
    portFailure('port-binding-invalid', 'fieldInputModes must be an object', { path: 'fieldInputModes' })
  }
  const entries = Object.entries(modes)
  if (entries.length > 256) {
    portFailure('port-cardinality-invalid', 'fieldInputModes must contain at most 256 fields', { path: 'fieldInputModes' })
  }
  return entries.map(([fieldIdValue, modeValue]) => {
    const fieldId = string(fieldIdValue, 'fieldInputModes field id', { min: 1, max: 260, trim: false })
    let mode
    try {
      mode = record(modeValue, `fieldInputModes.${fieldId}`)
    } catch {
      portFailure('port-binding-invalid', `fieldInputModes.${fieldId} must be { mode: "input" }`, {
        path: `fieldInputModes.${fieldId}`,
      })
    }
    if (mode.mode !== 'input' || Object.keys(mode).some(key => key !== 'mode')) {
      portFailure('port-binding-invalid', `fieldInputModes.${fieldId} must be { mode: "input" }`, {
        path: `fieldInputModes.${fieldId}`,
      })
    }
    const candidate = candidates.get(fieldId)
    if (candidate === undefined) {
      portFailure('port-binding-invalid', `field input ${fieldId} is not declared by this node`, {
        path: `fieldInputModes.${fieldId}`, fieldId,
      })
    }
    if (candidate.type !== 'text') {
      portFailure('port-type-mismatch', `field input ${fieldId} accepts text fields only, not ${String(candidate.type)}`, {
        path: `fieldInputModes.${fieldId}`, fieldId, expected: ['text'], actual: [candidate.type],
      })
    }
    return { ...candidate, portId: `${FIELD_INPUT_PREFIX}${fieldId}` }
  })
}

function trustedMediaCandidates(input, store, projectId, index) {
  const candidates = []
  const seenAssets = new Set()
  for (const [field, value] of [['assetId', input.assetId], ['maskAssetId', input.maskAssetId]]) {
    if (value === undefined) continue
    const asset = store.asset(value)
    if (projectId !== undefined && asset.projectId !== projectId) {
      portFailure('port-binding-invalid', `${field} ${asset.id} does not belong to project ${projectId}`, {
        path: `mediaInputs.${String(index)}.${field}`,
      })
    }
    if (!seenAssets.has(asset.id)) {
      candidates.push({ kind: asset.kind, assetId: asset.id, field })
      seenAssets.add(asset.id)
    }
  }
  if (typeof input.text === 'string') candidates.push({ kind: 'text', text: input.text, field: 'text' })
  return candidates
}

function normalizeNodeMediaInputs(definition, request, store, fieldInputs = []) {
  const rawInputs = request.mediaInputs === undefined ? [] : request.mediaInputs
  if (!Array.isArray(rawInputs) || rawInputs.length > 32) {
    portFailure('port-cardinality-invalid', 'mediaInputs must be an array with at most 32 entries', { path: 'mediaInputs' })
  }
  const declaredPorts = Array.isArray(definition.inputs) ? definition.inputs : []
  const declaredMediaPorts = declaredPorts.filter(port => !Array.isArray(port.types) || !port.types.includes('flow'))
  const declaredPortIds = new Set(declaredPorts.map(port => port.id))
  for (const field of fieldInputs) {
    if (declaredPortIds.has(field.portId)) {
      portFailure('port-binding-invalid', `field input ${field.id} conflicts with declared input port ${field.portId}`, {
        path: `fieldInputModes.${field.id}`, fieldId: field.id, portId: field.portId,
      })
    }
  }
  const ports = [
    ...declaredPorts,
    ...fieldInputs.map(field => ({
      id: field.portId,
      label: field.id,
      types: ['text'],
      required: false,
      multiple: false,
      fieldId: field.id,
    })),
  ]
  const portById = new Map(ports.map(port => [port.id, port]))
  const byPort = new Map(ports.map(port => [port.id, []]))
  for (const [index, value] of rawInputs.entries()) {
    const input = record(value, `mediaInputs[${String(index)}]`)
    const portId = mediaPortId(input, declaredMediaPorts, index)
    const port = portById.get(portId)
    if (port === undefined) {
      portFailure('port-binding-invalid', `mediaInputs[${String(index)}] references unknown input port ${portId}`, {
        path: `mediaInputs.${String(index)}.portId`, portId,
      })
    }
    const candidates = trustedMediaCandidates(input, store, request.projectId, index)
    if (candidates.length === 0) {
      portFailure('port-binding-invalid', `mediaInputs[${String(index)}] contains no text or project asset`, {
        path: `mediaInputs.${String(index)}`, portId,
      })
    }
    const declaredMediaKind = input.mediaKind ?? input.mediaType
    if (port.fieldId !== undefined) {
      if (declaredMediaKind !== undefined && declaredMediaKind !== 'text') {
        portFailure('port-type-mismatch', `field input ${port.fieldId} accepts text only, not ${String(declaredMediaKind)}`, {
          path: `mediaInputs.${String(index)}.mediaKind`, portId, fieldId: port.fieldId,
          expected: ['text'], actual: [declaredMediaKind],
        })
      }
      if (candidates.length !== 1 || candidates[0].kind !== 'text') {
        portFailure('port-type-mismatch', `field input ${port.fieldId} requires one text source`, {
          path: `mediaInputs.${String(index)}`, portId, fieldId: port.fieldId,
          expected: ['text'], actual: candidates.map(candidate => candidate.kind),
        })
      }
      const rows = byPort.get(portId)
      rows.push({
        ...input,
        portId,
        portIndex: rows.length,
        mediaKind: 'text',
        text: candidates[0].text,
        fieldId: port.fieldId,
      })
      continue
    }
    let compatible = candidates.filter(candidate => port.types.includes(candidate.kind))
    if (declaredMediaKind !== undefined) {
      const declaredKind = string(declaredMediaKind, `mediaInputs[${String(index)}].mediaKind`, { min: 1, max: 16 })
      const declaredCandidates = candidates.filter(candidate => candidate.kind === declaredKind)
      if (declaredCandidates.length === 0) {
        portFailure('port-type-mismatch', `mediaInputs[${String(index)}] declares ${declaredKind}, but its stored asset or text has type ${candidates.map(candidate => candidate.kind).join(', ')}`, {
          path: `mediaInputs.${String(index)}.mediaKind`, portId, expected: port.types, actual: candidates.map(candidate => candidate.kind),
        })
      }
      compatible = declaredCandidates.filter(candidate => port.types.includes(candidate.kind))
    }
    if (compatible.length === 0) {
      portFailure('port-type-mismatch', `input port ${portId} accepts ${port.types.join(', ')}, not ${candidates.map(candidate => candidate.kind).join(', ')}`, {
        path: `mediaInputs.${String(index)}`, portId, expected: port.types, actual: candidates.map(candidate => candidate.kind),
      })
    }
    const selected = compatible.find(candidate => candidate.field === 'assetId') ?? compatible[0]
    const rows = byPort.get(portId)
    const normalized = {
      ...input,
      portId,
      portIndex: rows.length,
      mediaKind: selected.kind,
      ...(selected.assetId === undefined ? {} : { assetId: selected.assetId }),
      ...(selected.text === undefined ? {} : { text: selected.text }),
    }
    rows.push(normalized)
  }
  for (const port of ports) {
    const rows = byPort.get(port.id)
    if (port.required === true && rows.length === 0) {
      portFailure('port-required', `input port ${port.id} is required`, { portId: port.id })
    }
    if (port.multiple !== true && rows.length > 1) {
      portFailure('port-cardinality-invalid', `input port ${port.id} accepts only one value`, { portId: port.id })
    }
    if (typeof port.maxByType === 'object' && port.maxByType !== null && !Array.isArray(port.maxByType)) {
      for (const [kind, limit] of Object.entries(port.maxByType)) {
        if (!Number.isSafeInteger(limit) || limit < 0) continue
        const count = rows.filter(row => row.mediaKind === kind).length
        if (count > limit) {
          portFailure('port-cardinality-invalid', `input port ${port.id} accepts at most ${String(limit)} ${kind} value${limit === 1 ? '' : 's'}`, {
            portId: port.id, mediaKind: kind, expected: limit, actual: count,
          })
        }
      }
    }
  }
  const normalized = [...byPort.values()].flat()
  if (definition.operation === 'image-edit'
    && !normalized.some(input => input.mediaKind === 'image' || input.mediaKind === 'sketch' || input.mediaKind === 'mask')) {
    portFailure('port-required', 'image-edit requires an image, sketch, or mask input')
  }
  return normalized
}

function applyFieldInputValues(request, fieldInputs, mediaInputs) {
  if (fieldInputs.length === 0) return request
  let next = request
  let workflowValues
  for (const field of fieldInputs) {
    const input = mediaInputs.find(candidate => candidate.portId === field.portId)
    if (input === undefined) continue
    if (field.storage === 'request') {
      next = { ...next, [field.id]: input.text }
      continue
    }
    if (workflowValues === undefined) {
      workflowValues = request.workflowValues === undefined
        ? {}
        : { ...record(request.workflowValues, 'workflowValues') }
    }
    workflowValues[field.id] = input.text
  }
  return workflowValues === undefined ? next : { ...next, workflowValues }
}

function resolveMediaBinding(binding, mediaInputs) {
  let media
  if (binding.portId !== undefined) {
    const portIndex = binding.portIndex ?? 0
    const portInputs = mediaInputs.filter(input => input.portId === binding.portId)
    media = binding.referenceKind === undefined
      ? portInputs.find(input => input.portIndex === portIndex)
      : portInputs.filter(input => input.mediaKind === binding.referenceKind)[portIndex]
    if (media === undefined) {
      if (binding.optional === true) return binding
      portFailure('port-required', `input port ${binding.portId}[${String(portIndex)}] is required by workflow binding ${binding.nodeId}.${binding.input}`, {
        portId: binding.portId, portIndex,
      })
    }
  } else {
    const positionalInputs = mediaInputs.filter(input => !String(input.portId ?? '').startsWith(FIELD_INPUT_PREFIX))
    media = positionalInputs[binding.mediaIndex ?? 0]
  }
  if ((binding.from === 'asset' || binding.from === 'maskAsset')
    && media?.mediaKind === 'text' && typeof media.text === 'string') {
    return { ...binding, from: 'literal', value: media.text }
  }
  const assetId = binding.from === 'maskAsset'
    ? (media?.maskAssetId ?? media?.assetId)
    : media?.assetId
  if ((binding.from === 'asset' || binding.from === 'maskAsset') && typeof assetId === 'string') {
    return { ...binding, assetId }
  }
  return binding
}

function nodeExpectedOutputTypes(definition) {
  const types = []
  for (const port of Array.isArray(definition.outputs) ? definition.outputs : []) {
    if (Array.isArray(port?.types)) types.push(...port.types)
  }
  return [...new Set(types)]
}

async function persistedNodeReference(store, input) {
  if (typeof input.projectId !== 'string' || typeof input.nodeId !== 'string'
    || typeof store?.getProject !== 'function') return undefined
  const project = await store.getProject(uuid(input.projectId, 'projectId'))
  const nodeId = string(input.nodeId, 'nodeId', { min: 1, max: 256 })
  const node = project.graph.nodes.find(candidate => candidate?.id === nodeId)
  if (node?.data?.nodeType === undefined) return undefined
  return {
    type: string(node.data.nodeType, 'project nodeType', { min: 3, max: 128 }),
    version: string(node.data.nodeVersion ?? '1.0.0', 'project nodeVersion', { min: 5, max: 64 }),
  }
}

function matchingSnapshotField(snapshot, request, field, label, options) {
  const snapshotValue = snapshot[field]
  const requestValue = request[field]
  if (snapshotValue !== undefined && requestValue !== undefined && snapshotValue !== requestValue) {
    throw new DirectorInputError(`snapshot.${field} does not match snapshot.request.${field}`)
  }
  const value = snapshotValue ?? requestValue
  return value === undefined ? undefined : string(value, label, options)
}

function runSnapshotEnvelope(input) {
  // JSON round-tripping both bounds the cache payload and severs every object
  // reference to the live client canvas before any asynchronous validation.
  const snapshot = record(
    jsonValue(input.snapshot, 'snapshot', MAX_RUN_SNAPSHOT_BYTES),
    'snapshot',
  )
  if (snapshot.version !== RUN_SNAPSHOT_VERSION) {
    throw new DirectorInputError(`snapshot.version must be ${String(RUN_SNAPSHOT_VERSION)}`)
  }
  const sourceRevision = finiteNumber(snapshot.sourceRevision, 'snapshot.sourceRevision', { min: 1 })
  if (!Number.isSafeInteger(sourceRevision)) {
    throw new DirectorInputError('snapshot.sourceRevision must be a positive safe integer')
  }
  const projectId = uuid(input.projectId, 'projectId')
  const nodeId = string(input.nodeId, 'nodeId', { min: 1, max: 256 })
  const clientRunId = string(input.clientRunId, 'clientRunId', { min: 1, max: 128 })
  const requestInput = record(snapshot.request, 'snapshot.request')
  if (requestInput.projectId !== undefined && requestInput.projectId !== projectId) {
    throw new DirectorInputError('snapshot.request.projectId does not match the run envelope')
  }
  if (requestInput.nodeId !== undefined && requestInput.nodeId !== nodeId) {
    throw new DirectorInputError('snapshot.request.nodeId does not match the run envelope')
  }
  if (requestInput.clientRunId !== undefined && requestInput.clientRunId !== clientRunId) {
    throw new DirectorInputError('snapshot.request.clientRunId does not match the run envelope')
  }
  if (requestInput.sourceRevision !== undefined && requestInput.sourceRevision !== sourceRevision) {
    throw new DirectorInputError('snapshot.request.sourceRevision does not match the run envelope')
  }
  const nodeType = matchingSnapshotField(snapshot, requestInput, 'nodeType', 'snapshot.nodeType', { min: 3, max: 128 })
  const nodeVersion = matchingSnapshotField(snapshot, requestInput, 'nodeVersion', 'snapshot.nodeVersion', { min: 5, max: 64 })
  const nodeDigest = matchingSnapshotField(snapshot, requestInput, 'nodeDigest', 'snapshot.nodeDigest', { min: 16, max: 128 })
  if (nodeType === undefined && (nodeVersion !== undefined || nodeDigest !== undefined)) {
    throw new DirectorInputError('snapshot.nodeVersion and snapshot.nodeDigest require snapshot.nodeType')
  }
  return {
    projectId,
    nodeId,
    request: {
      ...requestInput,
      projectId,
      nodeId,
      clientRunId,
      sourceRevision,
      ...(nodeType === undefined ? {} : { nodeType }),
      ...(nodeVersion === undefined ? {} : { nodeVersion }),
      ...(nodeDigest === undefined ? {} : { nodeDigest }),
    },
  }
}

export function createDirectorRpc(options) {
  const { store, providers, jobs, registerAsset, workflows, providerSettings } = options
  const nodes = options.nodes ?? {
    list: () => [],
    get: () => { throw new DirectorInputError('node registry is not available') },
  }
  let workflowReferenceTail = Promise.resolve()
  const withWorkflowReferenceLock = async (operation) => {
    const result = workflowReferenceTail.catch(() => {}).then(operation)
    workflowReferenceTail = result.then(() => {}, () => {})
    return result
  }
  return async (endpoint, payload, signal) => {
    try {
      const input = payload === undefined ? {} : record(payload, 'payload')
      switch (endpoint) {
        case 'health':
          return success({ version: 3, providers: providers.publicCatalog().length, workflows: workflows.list().length, nodes: nodes.list().length })
        case 'projects/list':
          return success({ projects: await store.listProjects() })
        case 'projects/get':
          return success({ project: await store.getProject(uuid(input.projectId, 'projectId')) })
        case 'vd-runs/save':
          return success({ run: await withWorkflowReferenceLock(() => store.saveVdRun(
            uuid(input.projectId, 'projectId'), input.run, input.snapshot,
          )) })
        case 'vd-runs/list':
          return success({ runs: await store.listVdRuns(uuid(input.projectId, 'projectId')) })
        case 'vd-runs/get':
          return success({ run: await store.getVdRun(uuid(input.projectId, 'projectId'), uuid(input.runId, 'runId')) })
        case 'projects/create': {
          const project = await store.createProject({
            name: string(input.name, 'name', { min: 1, max: 120 }),
            sessionId: string(input.sessionId, 'sessionId', { min: 1, max: 256 }),
          })
          return success({ project })
        }
        case 'projects/delete': {
          const projectId = uuid(input.projectId, 'projectId')
          await withWorkflowReferenceLock(() => store.deleteProject(projectId))
          return success({ projects: await store.listProjects() })
        }
        case 'projects/save': {
          const projectId = uuid(input.projectId, 'projectId')
          const expectedRevision = finiteNumber(input.expectedRevision, 'expectedRevision', { min: 1 })
          if (input.force !== undefined && typeof input.force !== 'boolean') {
            throw new DirectorInputError('force must be a boolean')
          }
          const project = await withWorkflowReferenceLock(async () => {
            for (const workflowId of comfyWorkflowReferences(input.project)) workflows.get(workflowId)
            for (const reference of vdNodeDefinitionReferences(input.project)) nodes.get(reference.type, reference.version)
            return input.force === true
              ? store.forceSaveProject(projectId, input.project)
              : store.saveProject(projectId, input.project, expectedRevision)
          })
          return success({ project })
        }
        case 'projects/session': {
          const project = await store.replaceProjectSession(
            uuid(input.projectId, 'projectId'),
            string(input.sessionId, 'sessionId', { min: 1, max: 256 }),
          )
          return success({ project })
        }
        case 'assets/put': {
          const asset = await store.putAsset(input)
          await registerAsset(asset)
          return success({ asset })
        }
        case 'providers/list':
          return success({ providers: providers.publicCatalog() })
        case 'providers/check':
          return success(withPublicModels(
            await providers.check(string(input.providerId, 'providerId', { min: 1, max: 128 }), signal),
            workflows,
          ))
        case 'providers/models':
          return success(withPublicModels(
            await providers.models(string(input.providerId, 'providerId', { min: 1, max: 128 }), signal),
            workflows,
          ))
        case 'providers/unload-model':
          return success(await providers.unloadModel(
            string(input.providerId, 'providerId', { min: 1, max: 128 }),
            string(input.model, 'model', { min: 1, max: 512 }),
            signal,
          ))
        case 'triggers/run':
          {
            const releaseWaitSeconds = finiteNumber(input.releaseWaitSeconds ?? 10, 'releaseWaitSeconds', { min: 0, max: 300 })
            if (!Number.isSafeInteger(releaseWaitSeconds)) {
              throw new DirectorInputError('releaseWaitSeconds must be an integer')
            }
            return success(await providers.runTrigger(
              string(input.action, 'action', { min: 1, max: 64 }),
              { releaseWaitSeconds },
              signal,
            ))
          }
        case 'providers/transcribe':
          return success(await providers.transcribe(
            string(input.providerId, 'providerId', { min: 1, max: 128 }),
            input.audio,
            signal,
          ))
        case 'providers/update': {
          await providerSettings.updateProvider(
            string(input.providerId, 'providerId', { min: 1, max: 128 }),
            input.patch,
          )
          return success({ providers: providers.publicCatalog() })
        }
        case 'workflows/list':
          return success({ workflows: workflows.list() })
        case 'workflows/import':
          return success({ workflow: await workflows.import(input), nodeDefinitions: nodes.list() })
        case 'workflows/delete':
          {
            const workflowId = string(input.workflowId, 'workflowId', { min: 1, max: 128 })
            await withWorkflowReferenceLock(async () => {
              for (const summary of await store.listProjects()) {
                const project = await store.getProject(summary.id)
                if (project.graph.nodes.some(node => node?.data?.workflowId === workflowId)) {
                  const error = new Error(`workflow ${workflowId} is used by project ${project.name}`)
                  error.code = 'video-director/workflow-in-use'
                  throw error
                }
              }
              await workflows.remove(workflowId)
            })
          }
          return success({ workflows: workflows.list(), nodeDefinitions: nodes.list() })
        case 'nodes/list':
          return success({ nodeDefinitions: nodes.list() })
        case 'nodes/install': {
          const definition = await nodes.install(input.pack)
          return success({ definition, workflows: workflows.list(), nodeDefinitions: nodes.list() })
        }
        case 'nodes/remove': {
          const type = string(input.type, 'type', { min: 3, max: 128 })
          const version = string(input.version, 'version', { min: 5, max: 64 })
          await withWorkflowReferenceLock(async () => {
            const definition = nodes.get(type, version)
            for (const summary of await store.listProjects()) {
              const project = await store.getProject(summary.id)
              if (project.graph.nodes.some(node => (
                node?.data?.nodeType === definition.type && (node?.data?.nodeVersion ?? '1.0.0') === definition.version
              ) || (definition.workflowId !== undefined && node?.data?.workflowId === definition.workflowId))) {
                const error = new Error(`node ${definition.type}@${definition.version} is used by project ${project.name}`)
                error.code = 'video-director/node-in-use'
                throw error
              }
            }
            await nodes.remove(type, version)
          })
          return success({ workflows: workflows.list(), nodeDefinitions: nodes.list() })
        }
        case 'jobs/start': {
          const snapshotRun = input.snapshot === undefined ? undefined : runSnapshotEnvelope(input)
          if (snapshotRun !== undefined) await store.getProject(snapshotRun.projectId)
          const executionInput = snapshotRun?.request ?? input
          const { expectedOutputTypes: _untrustedExpectedOutputTypes, ...requestInput } = executionInput
          let request = requestInput
          // A validated snapshot is authoritative for this one execution. The
          // saved graph remains the last explicit project save and must not
          // overwrite an unsaved node or its newer field values.
          const persistedReference = snapshotRun === undefined
            ? await persistedNodeReference(store, executionInput)
            : undefined
          if (persistedReference !== undefined && executionInput.nodeType !== undefined && executionInput.nodeType !== persistedReference.type) {
            throw new DirectorInputError(`job nodeType ${String(executionInput.nodeType)} does not match the saved project node ${persistedReference.type}`)
          }
          if (persistedReference !== undefined && executionInput.nodeVersion !== undefined && executionInput.nodeVersion !== persistedReference.version) {
            throw new DirectorInputError(`job nodeVersion ${String(executionInput.nodeVersion)} does not match the saved project node ${persistedReference.version}`)
          }
          const requestedNodeType = persistedReference?.type ?? executionInput.nodeType
          const requestedNodeVersion = persistedReference?.version ?? executionInput.nodeVersion ?? '1.0.0'
          let definition
          let normalizedNodeType
          let normalizedNodeVersion
          if (requestedNodeType !== undefined) {
            normalizedNodeType = string(requestedNodeType, 'nodeType', { min: 3, max: 128 })
            normalizedNodeVersion = string(requestedNodeVersion, 'nodeVersion', { min: 5, max: 64 })
            definition = nodes.get(normalizedNodeType, normalizedNodeVersion)
            if (executionInput.nodeDigest !== undefined) {
              const requestedDigest = string(executionInput.nodeDigest, 'nodeDigest', { min: 16, max: 128 })
              if (definition.digest !== requestedDigest) {
                throw new DirectorInputError(`job nodeDigest does not match ${definition.type}@${definition.version}`)
              }
            }
            if (definition.behavior !== 'workflow' || definition.workflowId === undefined || definition.operation === undefined) {
              throw new DirectorInputError(`node ${definition.type}@${definition.version} is not remotely executable`)
            }
          }
          const effectiveWorkflowId = definition?.workflowId ?? (request.workflowId === undefined
            ? undefined
            : string(request.workflowId, 'workflowId', { min: 1, max: 128 }))
          const registeredWorkflow = effectiveWorkflowId === undefined || typeof workflows.get !== 'function'
            ? undefined
            : workflows.get(effectiveWorkflowId)
          const inputDefinition = definition ?? (effectiveWorkflowId === undefined || typeof nodes.list !== 'function'
            ? undefined
            : nodes.list().find(candidate => candidate.behavior === 'workflow' && candidate.workflowId === effectiveWorkflowId))
          const fieldInputs = normalizeFieldInputModes(
            request.fieldInputModes,
            fieldInputCandidates(inputDefinition, registeredWorkflow, request.operation),
          )
          if (inputDefinition !== undefined || fieldInputs.length > 0) {
            let mediaInputs
            if (inputDefinition !== undefined) {
              mediaInputs = normalizeNodeMediaInputs(inputDefinition, request, store, fieldInputs)
            } else {
              const fieldPortIds = new Set(fieldInputs.map(field => field.portId))
              const rawInputs = Array.isArray(request.mediaInputs) ? request.mediaInputs : []
              const fieldRows = []
              const legacyRows = []
              for (const [index, value] of rawInputs.entries()) {
                const row = record(value, `mediaInputs[${String(index)}]`)
                const rawPortId = row.portId ?? row.targetPortId
                const portId = typeof rawPortId === 'string' && rawPortId.startsWith('in:')
                  ? rawPortId.slice(3)
                  : rawPortId
                if (fieldPortIds.has(portId)) fieldRows.push(row)
                else legacyRows.push(row)
              }
              const normalizedFields = normalizeNodeMediaInputs(
                { inputs: [], operation: request.operation },
                { ...request, mediaInputs: fieldRows },
                store,
                fieldInputs,
              )
              mediaInputs = [...legacyRows, ...normalizedFields]
            }
            const assetIds = [...new Set(mediaInputs.flatMap(media => [media.assetId, media.maskAssetId])
              .filter(assetId => typeof assetId === 'string'))]
            request = {
              ...request,
              mediaInputs,
              assetIds,
            }
            request = applyFieldInputValues(request, fieldInputs, mediaInputs)
          }
          if (definition !== undefined) {
            if (typeof nodes.validateInstance === 'function') {
              nodes.validateInstance(normalizedNodeType, normalizedNodeVersion, request)
            }
            request = {
              ...request,
              operation: definition.operation,
              workflowId: definition.workflowId,
              modelFamily: definition.modelFamily ?? executionInput.modelFamily,
              expectedOutputTypes: nodeExpectedOutputTypes(definition),
            }
          }
          if (request.workflowId !== undefined) {
            const resolved = workflows.resolve(
              string(request.workflowId, 'workflowId', { min: 1, max: 128 }),
              request.workflowValues,
              { videoMode: request.videoMode },
            )
            const operation = string(request.operation, 'operation', { min: 1, max: 128 })
            const kindMatches = resolved.workflowKind === operation
            if (!kindMatches) {
              throw new DirectorInputError(`workflow ${resolved.workflowName} cannot run ${operation}`)
            }
            const mediaInputs = Array.isArray(request.mediaInputs) ? request.mediaInputs : []
            if (Number.isSafeInteger(resolved.requiredReferenceCount)) {
              const referenceCount = mediaInputs.filter(input => input.portId === resolved.framePortId).length
              if (referenceCount !== resolved.requiredReferenceCount) {
                portFailure(
                  'port-cardinality-invalid',
                  `${String(resolved.videoMode)} requires exactly ${String(resolved.requiredReferenceCount)} frame reference${resolved.requiredReferenceCount === 1 ? '' : 's'}`,
                  { portId: resolved.framePortId, expected: resolved.requiredReferenceCount, actual: referenceCount },
                )
              }
            }
            const bindings = resolved.bindings.map((binding) => {
              if (binding.assetId !== undefined) return binding
              return resolveMediaBinding(binding, mediaInputs)
            })
            request = {
              ...request,
              workflow: resolved.workflow,
              workflowId: resolved.workflowId,
              workflowName: resolved.workflowName,
              workflowKind: resolved.workflowKind,
              bindings,
              modelFamily: resolved.modelFamily ?? request.modelFamily,
            }
          }
          if (snapshotRun !== undefined) {
            request = {
              ...request,
              projectId: snapshotRun.projectId,
              nodeId: snapshotRun.nodeId,
              clientRunId: snapshotRun.request.clientRunId,
              sourceRevision: snapshotRun.request.sourceRevision,
              ...(snapshotRun.request.nodeDigest === undefined
                ? {}
                : { nodeDigest: snapshotRun.request.nodeDigest }),
            }
          }
          return success({ job: await jobs.start(request, {
            allowTransientNode: snapshotRun !== undefined,
          }) })
        }
        case 'jobs/get':
          return success({
            job: await jobs.get(uuid(input.projectId, 'projectId'), uuid(input.jobId, 'jobId')),
          })
        case 'jobs/cancel':
          return success({
            job: await jobs.cancel(uuid(input.projectId, 'projectId'), uuid(input.jobId, 'jobId')),
          })
        case 'jobs/delete':
          return success({
            job: await jobs.delete(uuid(input.projectId, 'projectId'), uuid(input.jobId, 'jobId')),
          })
        default:
          return failure(Object.assign(new Error(`unknown Video Director endpoint: ${endpoint}`), {
            code: 'video-director/not-found',
          }))
      }
    } catch (error) {
      if (error instanceof DirectorInputError && typeof error.code !== 'string') {
        error.code = 'video-director/invalid-input'
      }
      return failure(error)
    }
  }
}
