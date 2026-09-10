import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let helpers

async function modelChoiceHelpers() {
  if (helpers !== undefined) return helpers
  const entry = fileURLToPath(new URL('../src/client/model-choices.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  helpers = await import(`data:text/javascript;base64,${source}`)
  return helpers
}

test('Codex preserves explicit and previously used models when the catalog default changes', async () => {
  const { codexModelForNode } = await modelChoiceHelpers()
  const provider = { id: 'codex-plan', model: 'new-default', availableModels: ['new-default'] }
  assert.equal(codexModelForNode({}, provider), 'new-default')
  assert.equal(codexModelForNode({ modelId: 'saved-model' }, provider), 'saved-model')
  assert.equal(codexModelForNode({ modelFamily: 'legacy-model' }, provider), 'legacy-model')
  assert.equal(codexModelForNode({ result: { providerId: 'codex-plan', model: 'previous-default' } }, provider), 'previous-default')
  assert.equal(codexModelForNode({ modelId: 'chosen-model', result: { providerId: 'codex-plan', model: 'previous-default' } }, provider), 'chosen-model')
  assert.equal(codexModelForNode({ result: { providerId: 'another-provider', model: 'unrelated' } }, provider), 'new-default')
  assert.equal(codexModelForNode({}, { id: 'codex-plan', availableModels: [] }), undefined)
})

test('an exact dynamic empty model catalog disables the select and overrides stale declared choices', async () => {
  const { modelChoicePresentation: present } = await modelChoiceHelpers()

  assert.deepEqual(present([], ['stale.safetensors'], 'stale.safetensors'), {
    choices: [],
    disabled: true,
    currentUnavailable: true,
  })
})

test('unmapped fields retain their declared choices while discovered choices retain unavailable current values', async () => {
  const { modelChoicePresentation: present } = await modelChoiceHelpers()

  assert.deepEqual(present(undefined, ['declared.safetensors'], 'declared.safetensors'), {
    choices: ['declared.safetensors'],
    disabled: false,
    currentUnavailable: false,
  })
  assert.deepEqual(present(['api.safetensors'], ['declared.safetensors'], 'current.safetensors'), {
    choices: ['api.safetensors'],
    disabled: false,
    currentUnavailable: true,
  })
  assert.equal(present(undefined, undefined, 'free text'), undefined)
})

test('Ollama selects only real inventory entries without a synthetic Default choice', async () => {
  const { effectiveOllamaModel } = await modelChoiceHelpers()

  assert.equal(effectiveOllamaModel(['a', 'b'], 'b', undefined), 'b')
  assert.equal(effectiveOllamaModel(['a', 'b'], 'missing', undefined), 'a')
  assert.equal(effectiveOllamaModel(['a', 'b'], 'b', 'a'), 'a')
  assert.equal(effectiveOllamaModel([], 'missing', undefined), undefined)
})

test('Ollama capabilities stay disabled until the selected model explicitly reports support', async () => {
  const { ollamaModelSupports } = await modelChoiceHelpers()
  const details = [
    { id: 'thinking-model', capabilities: ['completion', 'thinking'] },
    { id: 'plain-model', capabilities: ['completion'] },
  ]

  assert.equal(ollamaModelSupports(details, 'thinking-model', 'thinking'), true)
  assert.equal(ollamaModelSupports(details, 'plain-model', 'thinking'), false)
  assert.equal(ollamaModelSupports(details, 'missing-model', 'thinking'), false)
  assert.equal(ollamaModelSupports(undefined, 'thinking-model', 'thinking'), false)
})
