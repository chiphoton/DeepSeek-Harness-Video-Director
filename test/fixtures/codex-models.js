import { CodexModelCatalog } from '../../src/codex-model-catalog.js'

// Deliberately different defaults and an unknown future model. No production allowlist.
export const TEST_MODELS = [
  { model: 'gpt-5.6-sol', defaultReasoningEffort: 'low', isDefault: true },
  { model: 'gpt-5.6-terra', defaultReasoningEffort: 'medium' },
  { model: 'gpt-5.6-luna', defaultReasoningEffort: 'high' },
  { model: 'future-model', displayName: 'Future Model', defaultReasoningEffort: 'max' },
  { model: 'text-only-model', defaultReasoningEffort: 'high', inputModalities: ['text'], serviceTiers: [] },
  { model: 'hidden-model', defaultReasoningEffort: 'low', hidden: true },
].map(model => ({ inputModalities: ['text', 'image'], serviceTiers: [{ id: 'priority' }], ...model }))

export const fetchTestModels = async () => structuredClone(TEST_MODELS)
export const modelFixture = (models = TEST_MODELS) => new CodexModelCatalog({ fetchModels: async () => structuredClone(models) })
