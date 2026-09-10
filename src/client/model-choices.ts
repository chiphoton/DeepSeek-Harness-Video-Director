import type { DirectorNodeData, ProviderDescriptor } from './types'

/** Older canvases stored their default model only in the completed result. */
export function codexModelForNode(data: DirectorNodeData, provider: ProviderDescriptor): string | undefined {
  const legacyModel = data.modelFamily === 'minimax-h3' ? undefined : data.modelFamily
  if (data.modelId || legacyModel) return data.modelId || legacyModel
  const result = data.result as { model?: unknown; providerId?: unknown } | null | undefined
  if (result?.providerId === provider.id && typeof result.model === 'string' && result.model !== '') return result.model
  return provider.model ?? provider.availableModels?.[0]
}

export interface ModelChoicePresentation {
  choices: string[]
  disabled: boolean
  currentUnavailable: boolean
}

/** Resolve a real Ollama inventory entry without adding a synthetic Default row. */
export function effectiveOllamaModel(
  availableModels: readonly string[],
  providerModel: string | undefined,
  selectedModel: string | undefined,
): string | undefined {
  if (selectedModel !== undefined && availableModels.includes(selectedModel)) return selectedModel
  if (providerModel !== undefined && availableModels.includes(providerModel)) return providerModel
  return availableModels[0]
}

/** Report a capability only when the selected Ollama inventory row declares it. */
export function ollamaModelSupports(
  details: readonly { id: string; capabilities: readonly string[] }[] | undefined,
  model: string | undefined,
  capability: string,
): boolean {
  return model !== undefined
    && details?.find(candidate => candidate.id === model)?.capabilities.includes(capability) === true
}

/**
 * Resolve API-discovered choices over the comfyui-workflow or vd-node manifest.
 *
 * `discovered === undefined` means this field was not mapped by discovery, so
 * its declared UI remains authoritative. An empty discovered array is a valid
 * mapped result and must not fall back to declared (potentially stale) choices.
 */
export function modelChoicePresentation(
  discovered: string[] | undefined,
  declared: string[] | undefined,
  current: string,
): ModelChoicePresentation | undefined {
  const choices = discovered ?? declared
  if (choices === undefined) return undefined
  return {
    choices,
    disabled: choices.length === 0,
    currentUnavailable: !choices.includes(current),
  }
}
