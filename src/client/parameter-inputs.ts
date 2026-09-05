import type {
  DirectorNodeData,
  FieldInputMode,
  VdNodeDefinitionDescriptor,
  VdPortDescriptor,
} from './types'

const FIELD_PORT_PREFIX = 'field:'
const GENERIC_WORKFLOW_KINDS = new Set<DirectorNodeData['kind']>([
  'prompt-enhancer',
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
])

export interface ParameterInputCandidate {
  id: string
  label: string
  type: 'text'
}

export interface ConnectedParameterInput {
  portId?: string
  targetPortId?: string
  text?: unknown
}

export interface ResolvedParameterInputs {
  prompt: DirectorNodeData['prompt']
  negativePrompt: DirectorNodeData['negativePrompt']
  workflowValues: DirectorNodeData['workflowValues']
}

export function fieldInputPortId(fieldId: string): string {
  return `${FIELD_PORT_PREFIX}${fieldId}`
}

export function fieldIdFromInputPort(portId: string | null | undefined): string | undefined {
  if (typeof portId !== 'string' || !portId.startsWith(FIELD_PORT_PREFIX)) return undefined
  const fieldId = portId.slice(FIELD_PORT_PREFIX.length)
  return fieldId === '' ? undefined : fieldId
}

export function isFieldInputPort(portId: string | null | undefined): boolean {
  return fieldIdFromInputPort(portId) !== undefined
}

function definitionTextCandidates(
  definition: VdNodeDefinitionDescriptor | undefined,
): ParameterInputCandidate[] {
  if (definition?.behavior !== 'workflow') return []
  if (definition.parameterInputs !== undefined) {
    return definition.parameterInputs
      .filter(field => field.type === 'text')
      .map(field => ({ id: field.id, label: field.label, type: 'text' }))
  }
  return definition.fields
    .filter(field => field.type === 'text')
    .map(field => ({ id: field.id, label: field.label, type: 'text' }))
}

export function parameterInputCandidates(
  data: DirectorNodeData,
  definition: VdNodeDefinitionDescriptor | undefined,
): ParameterInputCandidate[] {
  if (data.nodeType !== undefined) return definitionTextCandidates(definition)
  if (!GENERIC_WORKFLOW_KINDS.has(data.kind)) return []

  if (definition?.parameterInputs !== undefined) {
    return definitionTextCandidates(definition)
  }

  const commonCandidates: ParameterInputCandidate[] = [
    { id: 'prompt', label: 'Prompt', type: 'text' },
    ...(data.kind === 'prompt-enhancer'
      ? []
      : [{ id: 'negativePrompt', label: 'Negative prompt', type: 'text' as const }]),
  ]
  const candidates: ParameterInputCandidate[] = [
    ...(data.workflow !== undefined && Array.isArray(data.bindings)
      ? commonCandidates.filter(candidate => data.bindings?.some(binding => binding.from === candidate.id))
      : commonCandidates),
    ...definitionTextCandidates(definition),
  ]
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    if (seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}

export function fieldInputModeEnabled(data: DirectorNodeData, fieldId: string): boolean {
  return data.fieldInputModes?.[fieldId]?.mode === 'input'
}

export function activeFieldInputModes(
  data: DirectorNodeData,
  definition: VdNodeDefinitionDescriptor | undefined,
): Record<string, FieldInputMode> {
  return Object.fromEntries(parameterInputCandidates(data, definition)
    .filter(candidate => fieldInputModeEnabled(data, candidate.id))
    .map(candidate => [candidate.id, { mode: 'input' }]))
}

export function parameterInputPorts(
  data: DirectorNodeData,
  definition: VdNodeDefinitionDescriptor | undefined,
): VdPortDescriptor[] {
  return parameterInputCandidates(data, definition)
    .filter(candidate => fieldInputModeEnabled(data, candidate.id))
    .map(candidate => ({
      id: fieldInputPortId(candidate.id),
      label: candidate.label,
      types: ['text'],
    }))
}

function connectionPortId(connection: ConnectedParameterInput): string | undefined {
  return connection.targetPortId ?? connection.portId
}

export function resolveParameterInputs(
  data: DirectorNodeData,
  definition: VdNodeDefinitionDescriptor | undefined,
  connections: readonly ConnectedParameterInput[],
): ResolvedParameterInputs {
  let prompt = data.prompt
  let negativePrompt = data.negativePrompt
  let workflowValues = data.workflowValues

  for (const candidate of parameterInputCandidates(data, definition)) {
    if (!fieldInputModeEnabled(data, candidate.id)) continue
    const portId = fieldInputPortId(candidate.id)
    const connected = connections.filter(connection => connectionPortId(connection) === portId)
    if (connected.length === 0) continue
    const value = connected[0]?.text
    if (typeof value !== 'string') {
      throw new Error(`${candidate.label} is connected but its source has no text value.`)
    }
    if (candidate.id === 'prompt') {
      prompt = value
    } else if (candidate.id === 'negativePrompt') {
      negativePrompt = value
    } else {
      workflowValues = { ...workflowValues, [candidate.id]: value }
    }
  }

  return { prompt, negativePrompt, workflowValues }
}
