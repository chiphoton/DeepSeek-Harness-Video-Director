import type { DirectorGraph, DirectorNodeData, VideoProject, DirectorSnapshot } from './types'
import type { ProviderDescriptor, ComfyWorkflowDescriptor } from './types'
import { isTriggerNodeKind, inferredNodeOutputTypes, validateNodeInputPorts, resolveEdgePorts, nodeDefinition } from './ports'
import { activeFieldInputModes, isFieldInputPort, resolveParameterInputs } from './parameter-inputs'
import { effectiveOllamaModel, codexModelForNode, ollamaModelSupports } from './model-choices'
import { DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT } from './default-system-prompt'

export interface NodeSubmissionOptions {
  graph?: DirectorGraph
  seed?: number
  workflowRunId?: string
  workflowRunMode?: string
  batchIndex?: number
  batchSize?: number
  batchRunId?: string
  caseId?: string
  caseIndex?: number
}

export function withDefaultRegisteredImageWorkflow(
  data: DirectorNodeData,
  providers: readonly ProviderDescriptor[],
  workflows: readonly ComfyWorkflowDescriptor[],
): DirectorNodeData {
  if ((data.kind !== 'image-generation' && data.kind !== 'image-edit')
    || data.workflowId !== undefined
    || data.workflow !== undefined) return data
  const provider = providers.find(candidate => candidate.id === data.providerId)
  if (provider?.kind !== 'comfyui' && provider?.kind !== 'comfyui-mcp') return data
  const workflow = workflows.find(candidate => candidate.kind === 'image-generation' || candidate.kind === 'image-edit')
  if (workflow === undefined) return data
  return {
    ...workflow.defaults,
    ...data,
    kind: workflow.kind,
    workflowId: workflow.id,
    modelFamily: workflow.modelFamily ?? workflow.defaults.modelFamily,
    workflowValues: Object.fromEntries(workflow.parameters.map(parameter => [parameter.id, parameter.default])),
  }
}

export function prepareNodeRequest(project: VideoProject, nodeId: string, catalog: Pick<DirectorSnapshot, 'providers' | 'workflows' | 'nodeDefinitions'>, options: NodeSubmissionOptions = {}) {
  const sourceGraph = options.graph ?? project.graph
  const storedNode = sourceGraph.nodes.find(candidate => candidate.id === nodeId)
  if (storedNode === undefined) throw new Error(`Node ${nodeId} was not found`)
  const effectiveData = withDefaultRegisteredImageWorkflow(
    storedNode.data,
    catalog.providers,
    catalog.workflows,
  )
  const node = effectiveData === storedNode.data ? storedNode : { ...storedNode, data: effectiveData }
  const executionGraph = node === storedNode
    ? sourceGraph
    : {
        ...sourceGraph,
        nodes: sourceGraph.nodes.map(candidate => candidate.id === nodeId ? node : candidate),
      }
  if (node.data.frozen === true) {
    throw new Error(`${node.data.title} is frozen. Unfreeze it before running the node directly.`)
  }
  if (node.data.kind === 'preview' || node.data.kind === 'save') {
    throw new Error(`${node.data.title} is a local output sink and does not run a remote job.`)
  }
  const inputEdges = executionGraph.edges.filter(edge => edge.target === nodeId
    && !isTriggerNodeKind(executionGraph.nodes.find(candidate => candidate.id === edge.source)?.data.kind ?? 'load-text'))
  validateNodeInputPorts(executionGraph, catalog.nodeDefinitions, nodeId)
  const mappedInputs = inputEdges.map(edge => {
    const candidate = executionGraph.nodes.find(row => row.id === edge.source)
    if (candidate === undefined) throw new Error(`Connection source ${edge.source} was not found.`)
    const ports = resolveEdgePorts(executionGraph, catalog.nodeDefinitions, edge)
    const outputTypes = inferredNodeOutputTypes(candidate)
    const mediaType = ports.targetTypes.length === 1 && ports.targetTypes[0] === 'mask'
      ? 'mask'
      : candidate.data.asset?.kind ?? candidate.data.mediaKind ?? outputTypes.find(type => ports.targetTypes.includes(type))
    const asset = candidate.data.assets?.find(value => ports.sourceTypes.includes(value.kind)) ?? candidate.data.asset
    return {
      nodeId: candidate.id,
      kind: candidate.data.kind,
      mediaType,
      sourcePortId: ports.sourcePortId,
      targetPortId: ports.targetPortId,
      text: candidate.data.text,
      prompt: candidate.data.prompt,
      assetId: asset?.id,
      assetName: asset?.name,
      maskAssetId: candidate.data.maskAsset?.id,
      trim: candidate.data.trim,
      transform: candidate.data.transform,
      role: edge?.data?.role ?? candidate.data.referenceRole ?? 'visual',
      includeAudio: edge?.data?.includeAudio ?? candidate.data.includeAudio ?? false,
    }
  })
  const mediaInputs = [
    ...mappedInputs.filter(input => !isFieldInputPort(input.targetPortId)),
    ...mappedInputs.filter(input => isFieldInputPort(input.targetPortId)),
  ]
  const definition = nodeDefinition(node.data, catalog.nodeDefinitions)
  const resolvedParameters = resolveParameterInputs(node.data, definition, mediaInputs)
  if (node.data.kind === 'prompt-enhancer'
    && (typeof resolvedParameters.prompt !== 'string' || resolvedParameters.prompt.trim() === '')) {
    throw new Error('Enter a prompt before running this node.')
  }
  const fieldInputModes = activeFieldInputModes(node.data, definition)
  const assetIds = [...new Set(mediaInputs.flatMap(candidate => [candidate.assetId, candidate.maskAssetId]
    .filter((value): value is string => value !== undefined)))]
  const context = JSON.stringify(mediaInputs.filter(input => !isFieldInputPort(input.targetPortId)))
  const selectedProvider = catalog.providers.find(provider => provider.id === node.data.providerId)
  const selectedModel = selectedProvider?.kind === 'ollama'
    ? effectiveOllamaModel(selectedProvider.availableModels ?? [], selectedProvider.model, node.data.modelId)
    : selectedProvider?.kind === 'codex-plan'
      ? codexModelForNode(node.data, selectedProvider)
      : node.data.modelId ?? (node.data.modelFamily === 'minimax-h3' ? undefined : node.data.modelFamily)
  const selectedModelDetails = selectedProvider?.modelDetails?.find(details => details.id === selectedModel)
  if (node.data.contextLength !== undefined && selectedModelDetails?.contextLength !== undefined
    && node.data.contextLength > selectedModelDetails.contextLength) {
    throw new Error(`Context length cannot exceed ${String(selectedModelDetails.contextLength)} tokens for ${selectedModel}.`)
  }
  const submittedPrompt = node.data.kind === 'image-generation'
    && (selectedProvider?.kind === 'codex-plan' || node.data.providerId === 'codex-plan')
    ? `${node.data.imageMode === 'edit' ? '$Edit Image$' : '$Create Image$'}\n${String(resolvedParameters.prompt ?? '')}`
    : resolvedParameters.prompt
  const submittedSeed = options.seed ?? (node.data.seedControlAfterGenerate === 'randomize' ? undefined : node.data.seed)
  const request = structuredClone({
    providerId: node.data.providerId,
    operation: node.data.kind,
    modelFamily: node.data.modelFamily,
    model: selectedModel,
    prompt: submittedPrompt,
    negativePrompt: resolvedParameters.negativePrompt,
    systemPrompt: node.data.kind === 'prompt-enhancer'
      ? (node.data.systemPrompt ?? DEFAULT_TEXT_WORKFLOW_SYSTEM_PROMPT)
      : node.data.systemPrompt,
    contextLength: selectedProvider?.kind === 'ollama' ? node.data.contextLength : undefined,
    thinking: selectedProvider?.kind === 'ollama' && ollamaModelSupports(selectedProvider.modelDetails, selectedModel, 'thinking')
      ? node.data.thinking
      : undefined,
    context,
    assetIds,
    workflow: node.data.workflow,
    bindings: (node.data.bindings ?? []).map((binding) => {
      if (binding.assetId !== undefined) return binding
      const mediaIndex = binding.portId === undefined
        ? (binding.mediaIndex ?? 0)
        : mediaInputs
            .map((input, index) => ({ input, index }))
            .filter(candidate => candidate.input.targetPortId === binding.portId)
            .filter(candidate => binding.referenceKind === undefined || candidate.input.mediaType === binding.referenceKind)[binding.portIndex ?? 0]?.index
      const media = mediaIndex === undefined ? undefined : mediaInputs[mediaIndex]
      if (binding.from === 'asset' && media?.assetId !== undefined) return { ...binding, mediaIndex, assetId: media.assetId }
      if (binding.from === 'maskAsset' && media?.maskAssetId !== undefined) return { ...binding, mediaIndex, assetId: media.maskAssetId }
      return binding
    }),
    workflowId: node.data.workflowId,
    workflowValues: resolvedParameters.workflowValues,
    videoMode: node.data.videoMode,
    fieldInputModes,
    seed: submittedSeed,
    width: node.data.width,
    height: node.data.height,
    duration: node.data.duration,
    fps: node.data.fps,
    variant: node.data.variant,
    steps: node.data.steps,
    scheduler: node.data.scheduler,
    mediaInputs,
    mediaOptions: node.data.mediaOptions,
    workflowRunId: options.workflowRunId,
    workflowRunMode: options.workflowRunMode,
    batchIndex: options.batchIndex,
    batchSize: options.batchSize,
    batchRunId: options.batchRunId,
    caseId: options.caseId,
    caseIndex: options.caseIndex,
  })
  return { node, request }
}
