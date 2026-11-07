import { randomUUID } from 'node:crypto'
import { fault } from './workspace-files.js'

/** Explicit routes shared with browser RPC. No arbitrary endpoint or credential proxy. */
export const operations = {
  'assets.import': { endpoint: 'assets/put', description: 'Import explicit bytes into this workflow.', fields: ['kind', 'name', 'mimeType', 'dataBase64', 'origin'] },
  'assets.properties': { endpoint: 'assets/properties', description: 'Inspect media metadata.', fields: ['assetId'] },
  'assets.edit': { endpoint: 'media/edit', description: 'Crop/trim/sample an existing asset.', fields: ['assetId', 'action', 'edit'] },
  'definitions.list': { endpoint: 'nodes/list', description: 'List reusable node definitions.', fields: [] },
  'definitions.install': { endpoint: 'nodes/install', description: 'Install a declarative node pack.', fields: ['pack'] },
  'definitions.remove': { endpoint: 'nodes/remove', description: 'Remove an unused custom definition.', fields: ['type', 'version'] },
  'templates.list': { endpoint: 'workflows/list', description: 'List registered ComfyUI templates.', fields: [] },
  'templates.import': { endpoint: 'workflows/import', description: 'Import an explicit ComfyUI API document.', fields: ['name', 'document', 'kind', 'description', 'modelFamily', 'defaults', 'parameters', 'bindings', 'nodeManifest', 'nodeType', 'nodeVersion'] },
  'templates.remove': { endpoint: 'workflows/delete', description: 'Remove an unused custom template.', fields: ['workflowId'] },
  'providers.list': { endpoint: 'providers/list', description: 'List configured providers without credentials.', fields: [] },
  'providers.models': { endpoint: 'providers/models', description: 'Refresh the selected provider model catalog.', fields: ['providerId'] },
  'providers.configure': { endpoint: 'providers/update', description: 'Change non-secret provider settings.', fields: ['providerId', 'patch'] },
  'workflow.discard': { endpoint: 'projects/discard', description: 'Discard the current draft with a revision check.', fields: ['expectedDraftRevision'] },
  'workflow.rename': { canvas: 'edit', description: 'Rename the current workflow.', fields: ['name', 'expectedDraftRevision', 'idempotencyKey'] },
  'workflow.save': { canvas: 'save', description: 'Save the current draft.', fields: ['expectedDraftRevision'] },
  'canvas.edit': { canvas: 'edit', description: 'Add, edit, move, connect, clone, freeze, delete, set viewport/settings, or attach references atomically.', fields: ['edits', 'expectedDraftRevision', 'idempotencyKey'] },
  'canvas.undo': { canvas: 'undo', description: 'Undo a receipt without overwriting newer edits.', fields: ['operationId', 'expectedDraftRevision', 'idempotencyKey'] },
}

const fieldSchemas = {
  kind: { type: 'string' }, name: { type: 'string' }, mimeType: { type: 'string' }, dataBase64: { type: 'string', contentEncoding: 'base64' },
  origin: { type: 'string' }, assetId: { type: 'string', format: 'uuid' }, action: { enum: ['export', 'save', 'copy', 'frame'] }, edit: { type: 'object', properties: {
    start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, time: { type: 'number', minimum: 0 },
    crop: { type: 'object', required: ['x', 'y', 'width', 'height'], properties: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, { type: 'integer', minimum: 0 }])) },
  } },
  pack: { type: 'object' }, type: { type: 'string' }, version: { type: 'string' }, document: { type: 'object' },
  description: { type: 'string' }, modelFamily: { type: 'string' }, defaults: { type: 'object' }, parameters: { type: 'array' },
  bindings: { type: 'array' }, nodeManifest: { type: 'object' }, nodeType: { type: 'string' }, nodeVersion: { type: 'string' },
  workflowId: { type: 'string' }, providerId: { type: 'string' },
  patch: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, model: { type: 'string' }, imageModel: { type: 'string' }, fastMode: { type: 'boolean' } } },
  expectedDraftRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', format: 'uuid' }, operationId: { type: 'string', format: 'uuid' },
  edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['op'], properties: {
    op: { enum: ['add', 'update', 'attach', 'move', 'clone', 'remove', 'connect', 'disconnect', 'edge', 'rename', 'settings', 'viewport'] },
  } } },
}
const requiredFields = {
  'assets.import': ['kind', 'name', 'mimeType', 'dataBase64'], 'assets.properties': ['assetId'], 'assets.edit': ['assetId', 'action'],
  'definitions.install': ['pack'], 'definitions.remove': ['type', 'version'], 'templates.import': ['name', 'document', 'kind'], 'templates.remove': ['workflowId'],
  'providers.models': ['providerId'], 'providers.configure': ['providerId', 'patch'], 'workflow.discard': ['expectedDraftRevision'],
  'workflow.rename': ['name', 'expectedDraftRevision'], 'workflow.save': ['expectedDraftRevision'], 'canvas.edit': ['edits', 'expectedDraftRevision'],
  'canvas.undo': ['operationId', 'expectedDraftRevision'],
}

export function describeOperation(name) {
  const row = Object.hasOwn(operations, name) ? operations[name] : undefined
  if (!row) throw fault('capability-unavailable', 'Unknown operation.')
  return { name, description: row.description, fields: row.fields,
    inputSchema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(row.fields.map(field => [field, fieldSchemas[field]])), required: requiredFields[name] ?? [] } }
}

export function operationRequest(project, name, args, store) {
  const operation = Object.hasOwn(operations, name) ? operations[name] : undefined
  if (!operation) throw fault('capability-unavailable', 'Unknown operation. Discover the operation manifest first.')
  if (Object.keys(args).some(key => !operation.fields.includes(key))) throw fault('invalid-operation', 'Unknown input field. Describe this operation to see its supported fields.')
  const payload = Object.fromEntries(operation.fields.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]))
  if (payload.assetId && store.asset(payload.assetId).projectId !== project.id) throw fault('asset-not-found', 'Asset is not in this workflow.')
  if (name === 'providers.configure') {
    if (!payload.patch || Object.keys(payload.patch).some(key => !['label', 'model', 'imageModel', 'fastMode'].includes(key))) throw fault('credential-interface-required', 'Only labels and model choices are supported here. Configure credentials and provider destinations through dsh settings.')
  }
  if (name === 'workflow.discard' && !Number.isSafeInteger(payload.expectedDraftRevision)) throw fault('draft-conflict', 'expectedDraftRevision is required.')
  if (operation.canvas) return { endpoint: 'canvas/command', payload: { projectId: project.id, sessionId: project.sessionId, command: operation.canvas,
    args: name === 'workflow.rename' ? { expectedDraftRevision: args.expectedDraftRevision, idempotencyKey: args.idempotencyKey,
      edits: [{ op: 'rename', name: args.name }] } : payload } }
  return { endpoint: operation.endpoint, payload: { ...payload, projectId: project.id } }
}

/** Connected-view commands have expiring leases and acknowledgements; headless calls fail explicitly. */
export class ViewCommands {
  views = new Map()
  receipts = new Map()
  poll(project, input) {
    if (typeof input.viewId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.viewId)) throw fault('invalid-view', 'A view ID is required.')
    const now = Date.now()
    for (const [id, entry] of this.views) if (id !== input.viewId && now - entry.seenAt > 5000) this.views.delete(id)
    let view = this.views.get(input.viewId)
    if (view && (view.projectId !== project.id || view.sessionId !== project.sessionId)) throw fault('view-unavailable', 'View belongs to another workflow or chat.')
    view ??= { projectId: project.id, sessionId: project.sessionId, queue: [] }
    if (input.close) { this.views.delete(input.viewId); return { commands: [] } }
    for (const acknowledgement of input.acknowledgements ?? []) {
      const receipt = this.receipts.get(acknowledgement.id)
      if (receipt?.viewId === input.viewId && receipt.status === 'queued') {
        receipt.status = acknowledgement.error ? 'failed' : 'applied'; receipt.error = String(acknowledgement.error ?? '').slice(0, 300)
        view.queue = view.queue.filter(command => command.id !== receipt.id)
      }
    }
    const geometry = input.geometry
    if (geometry !== undefined && geometry?.draftRevision === project.draftRevision && Array.isArray(geometry.nodes) && geometry.nodes.length <= 2000) {
      const ids = new Set((project.draft ?? project).graph.nodes.map(node => node.id))
      const offsets = (rows, height) => new Map(Array.isArray(rows) ? rows.slice(0, 128).filter(row => Array.isArray(row)
        && typeof row[0] === 'string' && row[0].length <= 240 && Number.isFinite(row[1]) && row[1] >= 0 && row[1] <= height) : [])
      const nodes = new Map()
      for (const size of geometry.nodes) {
        if (!size || !ids.has(size.id) || ![size.width, size.height].every(value => Number.isFinite(value) && value > 0 && value <= 10000)) continue
        nodes.set(size.id, { width: size.width, height: size.height, inputs: offsets(size.inputs, size.height), outputs: offsets(size.outputs, size.height) })
      }
      view.geometry = { draftRevision: project.draftRevision, nodes }
    }
    view.seenAt = now; this.views.set(input.viewId, view)
    return { commands: view.queue.slice(0, 10) }
  }
  geometry(project) {
    const now = Date.now()
    const matches = [...this.views.values()].filter(view => view.projectId === project.id && view.sessionId === project.sessionId
      && now - view.seenAt < 5000 && view.geometry?.draftRevision === project.draftRevision)
    return matches.sort((a, b) => b.geometry.nodes.size - a.geometry.nodes.size || b.seenAt - a.seenAt)[0]?.geometry.nodes
  }
  call(project, command, args) {
    if (command === 'status') {
      const receipt = this.receipts.get(args.id)
      if (!receipt || receipt.projectId !== project.id || receipt.sessionId !== project.sessionId) throw fault('view-unavailable', 'Unknown view receipt.')
      if (receipt.status === 'queued' && Date.now() - (this.views.get(receipt.viewId)?.seenAt ?? 0) > 5000) receipt.status = 'unavailable'
      return { ...receipt }
    }
    if (!['select', 'frame', 'zoom', 'inspect', 'preview'].includes(command)) throw fault('invalid-operation', 'Unknown view command.')
    const entries = [...this.views.entries()].filter(([id, view]) => (!args.viewId || args.viewId === id) && view.projectId === project.id && view.sessionId === project.sessionId && Date.now() - view.seenAt < 5000)
    const [viewId, view] = entries.at(-1) ?? []
    if (!view) throw fault('view-unavailable', 'Open this workflow canvas to use view commands.')
    const nodeIds = args.nodeIds ?? []
    if (!Array.isArray(nodeIds) || nodeIds.length > 50 || nodeIds.some(id => !(project.draft ?? project).graph.nodes.some(node => node.id === id))) throw fault('invalid-view', 'Choose up to 50 existing node IDs.')
    if (['inspect', 'preview'].includes(command) && nodeIds.length !== 1) throw fault('invalid-view', 'Choose one node.')
    if (command === 'zoom' && (typeof args.zoom !== 'number' || !Number.isFinite(args.zoom) || args.zoom < .1 || args.zoom > 4)) throw fault('invalid-view', 'Zoom must be between 0.1 and 4.')
    if (view.queue.length >= 20) throw fault('view-busy', 'Wait for this view to apply its queued commands.')
    const id = randomUUID()
    const receipt = { id, projectId: project.id, sessionId: project.sessionId, viewId, status: 'queued', command }
    view.queue.push({ id, command, nodeIds, ...(command === 'zoom' ? { zoom: args.zoom } : {}) })
    this.receipts.set(id, receipt)
    while (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value)
    return { ...receipt }
  }
}
