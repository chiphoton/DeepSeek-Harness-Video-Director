import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ProviderRuntime } from '../src/providers.js'
import { modelFixture, TEST_MODELS } from './fixtures/codex-models.js'

const GENERATED_IMAGE = Buffer.from('a generated image returned by the Codex image tool')

function codexRuntime(options = {}) {
  const calls = { progress: [], saved: [], registered: [], threadOptions: undefined, input: undefined, textInput: undefined }
  const storedAsset = {
    id: 'generated-asset',
    projectId: 'project-1',
    kind: 'image',
    name: 'codex-plan.png',
    mimeType: 'image/png',
    size: GENERATED_IMAGE.length,
    sha256: 'test',
    createdAt: '2026-09-03T00:00:00.000Z',
    url: '/assets/generated-asset',
  }
  const runtime = new ProviderRuntime({
    codexModels: options.codexModels ?? modelFixture(),
    store: {
      async assetBytes(assetId) {
        assert.equal(assetId, 'reference-asset')
        return {
          asset: { id: assetId, kind: 'image', name: 'reference.png', mimeType: 'image/png' },
          data: Buffer.from('reference image'),
        }
      },
      async putAsset(input) {
        calls.saved.push(input)
        return storedAsset
      },
    },
    async registerAsset(asset) { calls.registered.push(asset) },
    createCodex: clientOptions => { calls.clientOptions = clientOptions; return ({
      startThread(threadOptions) {
        calls.threadOptions = threadOptions
        return {
          async run(input, runOptions) {
            calls.textInput = input
            assert.equal(runOptions.signal, options.signal)
            return {
              finalResponse: 'A precise cinematic production prompt.',
              items: [{ id: 'message-1', type: 'agent_message', text: 'A precise cinematic production prompt.' }],
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            }
          },
          async runStreamed(input, runOptions) {
            calls.input = input
            assert.equal(runOptions.signal, options.signal)
            assert.equal((await readFile(input[1].path)).toString(), 'reference image')
            async function* events() {
              yield {
                type: 'item.completed',
                item: {
                  type: 'mcp_tool_call',
                  result: {
                    content: [{
                      type: 'image',
                      data: GENERATED_IMAGE.toString('base64'),
                      mimeType: 'image/png',
                    }],
                  },
                },
              }
              yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }
            }
            return { events: events() }
          },
        }
      },
    }) },
    providers: [{
      id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan', model: 'gpt-5.6-sol', timeoutMs: 600_000, fastMode: options.fastMode ?? false,
    }],
  })
  return { runtime, calls, storedAsset }
}

test('Codex Plan catalog exposes live models and account metadata without built-in choices', async () => {
  const { runtime } = codexRuntime()
  assert.deepEqual(runtime.publicCatalog()[0].availableModels, [])
  const catalog = await runtime.models('codex-plan')
  const [provider] = runtime.publicCatalog()
  assert.deepEqual(provider.capabilities, ['text', 'image'])
  assert.deepEqual(provider.availableModels, TEST_MODELS.filter(row => !row.hidden).map(row => row.model))
  assert.equal(provider.fastMode, false)
  assert.equal(provider.configured, true)
  assert.equal('apiKey' in provider, false)
  assert.deepEqual(catalog.models, provider.availableModels)
  assert.equal(catalog.codexCatalog.source, 'live')
  const check = await runtime.check('codex-plan')
  assert.equal(check.ok, true)
  assert.equal(check.transport, 'codex-sdk')
  assert.deepEqual(check.models, provider.availableModels)
  assert.deepEqual(check.modelInputs, [])
})

test('Codex Plan enhances text through an isolated medium-reasoning SDK thread', async () => {
  const signal = new AbortController().signal
  const { runtime, calls } = codexRuntime({ signal })

  const result = await runtime.run({
    projectId: 'project-1',
    operation: 'prompt-enhancer',
    providerId: 'codex-plan',
    model: 'gpt-5.6-terra',
    prompt: 'A train crossing a frozen lake.',
    systemPrompt: 'Return one production-ready prompt and nothing else.',
    context: '[]',
  }, signal)

  assert.equal(calls.threadOptions.model, 'gpt-5.6-terra')
  assert.equal(calls.threadOptions.modelReasoningEffort, 'medium')
  assert.equal(calls.threadOptions.sandboxMode, 'read-only')
  assert.equal(calls.threadOptions.approvalPolicy, 'never')
  assert.equal(calls.threadOptions.networkAccessEnabled, false)
  assert.equal(calls.textInput.length, 1)
  assert.equal(calls.textInput[0].type, 'text')
  assert.match(calls.textInput[0].text, /Return one production-ready prompt/u)
  assert.match(calls.textInput[0].text, /A train crossing a frozen lake/u)
  assert.deepEqual(result, {
    kind: 'text',
    text: 'A precise cinematic production prompt.',
    providerId: 'codex-plan',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    transport: 'codex-sdk',
  })
})

test('Codex Plan passes references to an SDK thread using the model default effort and imports its image', async () => {
  const signal = new AbortController().signal
  const { runtime, calls, storedAsset } = codexRuntime({ signal })
  const result = await runtime.run({
    projectId: 'project-1',
    operation: 'image-generation',
    providerId: 'codex-plan',
    prompt: 'A tiny brass robot tending a rooftop garden.',
    negativePrompt: 'No text or watermark.',
    width: 1536,
    height: 1024,
    assetIds: ['reference-asset'],
  }, signal, update => calls.progress.push(update))

  assert.equal(calls.threadOptions.model, 'gpt-5.6-sol')
  assert.equal(calls.threadOptions.modelReasoningEffort, 'low')
  assert.equal(calls.threadOptions.sandboxMode, 'workspace-write')
  assert.equal(calls.threadOptions.approvalPolicy, 'never')
  assert.equal(calls.threadOptions.networkAccessEnabled, true)
  assert.equal(calls.input.length, 2)
  assert.equal(calls.input[0].type, 'text')
  assert.match(calls.input[0].text, /1536 x 1024/u)
  assert.match(calls.input[0].text, /No text or watermark/u)
  assert.deepEqual(calls.saved.map(input => ({
    projectId: input.projectId,
    kind: input.kind,
    mimeType: input.mimeType,
    dataBase64: input.dataBase64,
  })), [{
    projectId: 'project-1',
    kind: 'image',
    mimeType: 'image/png',
    dataBase64: GENERATED_IMAGE.toString('base64'),
  }])
  assert.deepEqual(calls.registered, [storedAsset])
  assert.deepEqual(result, {
    kind: 'assets',
    assets: [storedAsset],
    providerId: 'codex-plan',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    transport: 'codex-sdk',
  })
  assert.equal(calls.progress.at(-1).phase, 'saving-codex-image')
})

test('Codex Plan uses catalog defaults for newly discovered models and their variants', async () => {
  for (const row of TEST_MODELS.filter(row => !row.hidden && row.inputModalities.includes('image'))) {
    const { runtime, calls } = codexRuntime()
    const result = await runtime.run({
      projectId: 'project-1', operation: 'image-generation', providerId: 'codex-plan',
      model: row.model, prompt: 'A model routing test image.', assetIds: ['reference-asset'],
    })
    assert.equal(calls.threadOptions.model, row.model)
    assert.equal(calls.threadOptions.modelReasoningEffort, row.defaultReasoningEffort)
    assert.equal(result.reasoningEffort, row.defaultReasoningEffort)
    assert.deepEqual(calls.clientOptions, { serviceTier: 'default' })
  }
})

test('Fast applies only to supporting models and comes from provider settings', async () => {
  for (const fastMode of [false, true]) {
    const { runtime, calls } = codexRuntime({ fastMode })
    for (const model of ['future-model', 'text-only-model']) {
      await runtime.run({ projectId: 'project-1', operation: 'prompt-enhancer', providerId: 'codex-plan', model, prompt: 'Test' })
      assert.equal(calls.clientOptions.serviceTier, fastMode && model === 'future-model' ? 'priority' : 'default')
    }
  }
})

test('Codex Plan rejects a text-only model when given image references', async () => {
  const { runtime, calls } = codexRuntime()
  await assert.rejects(runtime.run({ projectId: 'project-1', operation: 'prompt-enhancer', providerId: 'codex-plan', model: 'text-only-model', prompt: 'Test', assetIds: ['reference-asset'] }), /does not support image references/u)
  assert.equal(calls.threadOptions, undefined)
})

test('Codex Plan rejects arbitrary models before starting an SDK thread', async () => {
  const { runtime, calls } = codexRuntime()
  await assert.rejects(runtime.run({
    projectId: 'project-1',
    operation: 'image-generation',
    providerId: 'codex-plan',
    model: 'unapproved-model',
    prompt: 'This must not run.',
  }), /no longer available/u)
  assert.equal(calls.threadOptions, undefined)
})
