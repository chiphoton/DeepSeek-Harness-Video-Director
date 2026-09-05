import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { VdNodeRegistry, normalizeVdNodePack } from '../src/node-registry.js'
import { ComfyWorkflowStore } from '../src/workflow-store.js'

async function createRegistry(t) {
  const root = await mkdtemp(join(tmpdir(), 'video-director-node-registry-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const workflows = new ComfyWorkflowStore(root)
  await workflows.init()
  return { workflows, nodes: new VdNodeRegistry(workflows) }
}

async function examplePack() {
  return JSON.parse(await readFile(new URL('../custom_nodes/comfyui-basic-image.manifest.json', import.meta.url), 'utf8'))
}

test('VdNodeRegistry exposes Preview and Save as ordinary built-in sink definitions', async (t) => {
  const { nodes } = await createRegistry(t)
  const preview = nodes.get('core.preview', '1.0.0')
  const save = nodes.get('core.save', '1.0.0')

  assert.equal(preview.behavior, 'preview')
  assert.equal(preview.inputs[0].multiple, true)
  assert.equal(save.behavior, 'save')
  assert.deepEqual(save.inputs[0].types, ['text', 'image', 'audio', 'video'])
})

test('VdNodeRegistry exposes one configurable VRAM trigger with bidirectional flow ports', async (t) => {
  const { nodes } = await createRegistry(t)
  const trigger = nodes.get('core.vram-trigger', '1.0.0')

  assert.equal(trigger.behavior, 'trigger')
  assert.equal(trigger.triggerAction, 'vram-trigger')
  assert.deepEqual(trigger.inputs[0].types, ['flow'])
  assert.deepEqual(trigger.outputs[0].types, ['flow'])
  assert.deepEqual(trigger.fields.map(field => [field.id, field.default]), [
    ['vramAction', 'skip'],
    ['vramReleaseWaitSeconds', 10],
  ])
  assert.equal(nodes.list().filter(definition => definition.behavior === 'trigger').length, 1)
})

test('VdNodeRegistry infers Reference inputs only from actual media bindings', async (t) => {
  const { workflows, nodes } = await createRegistry(t)
  const video = nodes.list().find(definition => definition.workflowId === 'builtin-minimax-h3-video-turbo')
  const referenceVideo = nodes.list().find(definition => definition.workflowId === 'builtin-minimax-h3-reference-to-video-turbo')
  const zImage = nodes.list().find(definition => definition.workflowId === 'builtin-z-image-turbo')

  assert.deepEqual(video.inputs, [
    { id: 'reference', label: 'Reference', types: ['image', 'audio', 'video', 'sketch', 'mask'], multiple: true },
    { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
  ])
  assert.deepEqual(video.parameterInputs.map(input => input.id), [
    'aspectRatio', 'diffusionModel', 'clipModel', 'loraModel', 'videoVae', 'audioVae', 'prompt',
  ])
  assert.deepEqual(referenceVideo.inputs, [
    {
      id: 'reference', label: 'Reference', types: ['image', 'audio', 'video'], multiple: true,
      maxByType: { image: 2, audio: 2, video: 1 },
    },
    { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
  ])
  assert.deepEqual(zImage.inputs, [{ id: 'flow', label: 'Flow', types: ['flow'], multiple: true }])
  assert.deepEqual(zImage.parameterInputs, [
    { id: 'diffusionModel', label: 'Diffusion model', type: 'text' },
    { id: 'clipModel', label: 'CLIP', type: 'text' },
    { id: 'vaeModel', label: 'VAE', type: 'text' },
    { id: 'samplerName', label: 'Sampler name', type: 'text' },
    { id: 'scheduler', label: 'Scheduler', type: 'text' },
    { id: 'prompt', label: 'Prompt', type: 'text' },
  ])

  const imported = await workflows.import({
    name: 'Generic image input',
    kind: 'image-edit',
    document: {
      load: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      save: { class_type: 'SaveImage', inputs: { images: ['load', 0] } },
    },
  })
  const withMedia = nodes.list().find(definition => definition.workflowId === imported.id)

  assert.deepEqual(withMedia.inputs, [{
    id: 'reference',
    label: 'Reference',
    types: ['image', 'audio', 'video', 'sketch', 'mask'],
    multiple: true,
  }, {
    id: 'flow', label: 'Flow', types: ['flow'], multiple: true,
  }])
})

test('VdNodeRegistry installs an immutable declarative workflow node with primary and Advanced fields', async (t) => {
  const { workflows, nodes } = await createRegistry(t)
  const pack = await examplePack()
  const installed = await nodes.install(pack)

  assert.equal(installed.type, 'example.comfyui-basic-image')
  assert.equal(installed.behavior, 'workflow')
  assert.equal(installed.operation, 'image-generation')
  assert.equal(installed.fields.find(field => field.id === 'prompt').placement, 'primary')
  assert.equal(installed.fields.find(field => field.id === 'steps').placement, 'advanced')
  assert.equal(installed.parameterInputs.some(field => field.id === 'prompt' && field.type === 'text'), true)
  assert.equal(installed.parameterInputs.some(field => field.id === 'steps'), false)

  const workflow = workflows.get(installed.workflowId)
  assert.equal(workflow.bindings.some(binding => binding.from === 'prompt'), true)
  assert.equal(workflow.bindings.some(binding => binding.from === 'steps'), true)
  assert.equal(workflow.parameters.some(parameter => parameter.id === 'cfg' && parameter.placement === 'advanced'), true)
  assert.equal(workflows.resolve(installed.workflowId, { cfg: 5.5 }).workflow['5'].inputs.cfg, 5.5)

  const repeated = await nodes.install(pack)
  assert.equal(repeated.digest, installed.digest)

  const conflict = structuredClone(pack)
  conflict.manifest.description = 'Different content at the same immutable version.'
  await assert.rejects(nodes.install(conflict), error => {
    assert.equal(error.code, 'video-director/node-version-conflict')
    return true
  })
})

test('VdNodeRegistry rejects arbitrary executors and validates field schemas at run time', async (t) => {
  const { nodes } = await createRegistry(t)
  const pack = await examplePack()
  const unsafe = structuredClone(pack)
  unsafe.type = 'example.unsafe'
  unsafe.implementation = { kind: 'javascript', source: 'globalThis.process.exit()' }
  await assert.rejects(nodes.install(unsafe), /declarative comfyui\.workflow/i)

  const installed = await nodes.install(pack)
  assert.throws(() => nodes.validateInstance(installed.type, installed.version, {
    prompt: 'test',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    seed: -1,
    workflowValues: { steps: 24, cfg: 7, checkpoint: 'model.safetensors' },
  }), error => {
    assert.equal(error.code, 'video-director/field-value-invalid')
    assert.match(error.message, /seed.*at least 0/i)
    return true
  })
})

test('VdNodeRegistry validates schema keywords and defaults before installing a field', async (t) => {
  const { nodes } = await createRegistry(t)
  const invalidCases = [
    {
      label: 'numeric keyword type',
      mutate(field) { field.schema.min = 'zero' },
      message: /schema\.min.*finite number/i,
    },
    {
      label: 'default range',
      mutate(field) { field.default = -1 },
      message: /default.*at least 0/i,
    },
    {
      label: 'integer default',
      mutate(field) { field.default = 1.5 },
      message: /default.*integer/i,
    },
    {
      label: 'string enum default',
      mutate(field) {
        field.schema.enum = ['installed.safetensors']
        field.default = 'missing.safetensors'
      },
      message: /default.*declared choices/i,
    },
    {
      label: 'string length relationship',
      mutate(field) {
        field.schema.minLength = 10
        field.schema.maxLength = 2
      },
      message: /minLength.*must not exceed maxLength/i,
    },
    {
      label: 'positive step',
      mutate(field) { field.schema.step = 0 },
      message: /schema\.step.*greater than 0/i,
    },
    {
      label: 'default step alignment',
      mutate(field) {
        field.schema.step = 2
        field.default = 43
      },
      message: /default.*align to step 2/i,
    },
  ]

  for (const [index, invalidCase] of invalidCases.entries()) {
    const pack = await examplePack()
    pack.type = `example.invalid-schema-${String(index)}`
    const field = invalidCase.label === 'string enum default' || invalidCase.label === 'string length relationship'
      ? pack.manifest.fields.find(candidate => candidate.id === 'checkpoint')
      : pack.manifest.fields.find(candidate => candidate.id === 'seed')
    invalidCase.mutate(field)
    await assert.rejects(nodes.install(pack), invalidCase.message)
  }
})

test('VdNodeRegistry stores one field parameter with several workflow targets', async (t) => {
  const { workflows, nodes } = await createRegistry(t)
  const pack = await examplePack()
  pack.type = 'example.multi-target-field'
  pack.implementation.bindings.push({
    target: { nodeId: '5', input: 'denoise' },
    source: { kind: 'field', fieldId: 'cfg' },
  })

  const installed = await nodes.install(pack)
  const workflow = workflows.get(installed.workflowId)
  const parameter = workflow.parameters.find(candidate => candidate.id === 'cfg')
  assert.equal(workflow.parameters.filter(candidate => candidate.id === 'cfg').length, 1)
  assert.deepEqual(parameter.targets, [
    { nodeId: '5', input: 'cfg' },
    { nodeId: '5', input: 'denoise' },
  ])

  const resolved = workflows.resolve(installed.workflowId, { cfg: 4.5 })
  assert.equal(resolved.workflow['5'].inputs.cfg, 4.5)
  assert.equal(resolved.workflow['5'].inputs.denoise, 4.5)
})

test('VdNodeRegistry preserves image-edit and typed port binding identity', async (t) => {
  const { workflows, nodes } = await createRegistry(t)
  const pack = await examplePack()
  pack.type = 'example.image-edit-ports'
  pack.implementation.operation = 'image-edit'
  pack.manifest.inputs = [{
    id: 'reference', label: 'Reference', types: ['image'], required: true, multiple: true,
  }]
  pack.implementation.workflow['8'] = {
    class_type: 'LoadImage',
    inputs: { image: 'input.png' },
  }
  pack.implementation.bindings.push({
    target: { nodeId: '8', input: 'image' },
    source: { kind: 'port', portId: 'reference', portIndex: 1 },
  })

  const installed = await nodes.install(pack)
  const workflow = workflows.get(installed.workflowId)
  const binding = workflow.bindings.find(candidate => candidate.nodeId === '8')

  assert.equal(installed.operation, 'image-edit')
  assert.equal(workflow.kind, 'image-edit')
  assert.deepEqual(installed.inputs, [
    ...pack.manifest.inputs,
    { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
  ])
  assert.deepEqual(binding, {
    nodeId: '8', input: 'image', from: 'asset', portId: 'reference', portIndex: 1,
  })
  assert.deepEqual(installed.fields.find(field => field.id === 'seed').schema, {
    type: 'number', min: 0, integer: true,
  })
  assert.deepEqual({
    min: installed.fields.find(field => field.id === 'seed').min,
    integer: installed.fields.find(field => field.id === 'seed').integer,
  }, { min: 0, integer: true })
})

test('VdNodeRegistry serializes immutable type and version installation', async (t) => {
  const { nodes } = await createRegistry(t)
  const first = await examplePack()
  first.type = 'example.concurrent-version'
  const second = structuredClone(first)
  second.manifest.description = 'Different content racing at the same exact version.'

  const outcomes = await Promise.allSettled([nodes.install(first), nodes.install(second)])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1)
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'video-director/node-version-conflict')
  assert.equal(nodes.list().filter(definition => (
    definition.type === first.type && definition.version === first.version
  )).length, 1)
})

test('VdNodeRegistry and the JSON Schema agree on namespaced types and exact SemVer', async (t) => {
  const { nodes } = await createRegistry(t)
  const schema = JSON.parse(await readFile(new URL('../schemas/video-director-node-v1.schema.json', import.meta.url), 'utf8'))
  const typePattern = new RegExp(schema.properties.type.pattern, 'u')
  const versionPattern = new RegExp(schema.properties.version.pattern, 'u')
  const validTypes = [
    'example.comfyui-basic-image',
    'com.deepseek/video-upscale',
    'local.workflow.2f871a6e-208a-4f88-bc80-55c09df28385',
  ]
  const invalidTypes = [
    'video',
    '1example/video',
    'Example/video',
    'example//video',
    'example/video_2',
    'example/video-',
    'example/video.extra',
  ]
  const validVersions = [
    '0.1.0',
    '1.2.3-rc.1',
    '1.2.3-rc.1+cuda.12',
    '1.2.3+001',
  ]
  const invalidVersions = [
    '1.0',
    '01.0.0',
    '1.0.0-01',
    '1.0.0+',
    'v1.0.0',
  ]

  for (const type of validTypes) {
    assert.equal(typePattern.test(type), true, `schema should accept type ${type}`)
    const pack = await examplePack()
    pack.type = type
    assert.equal(normalizeVdNodePack(pack).type, type)
  }
  for (const type of invalidTypes) {
    assert.equal(typePattern.test(type), false, `schema should reject type ${type}`)
    const pack = await examplePack()
    pack.type = type
    assert.throws(() => normalizeVdNodePack(pack), /lowercase namespaced identifier/i)
  }
  for (const version of validVersions) {
    assert.equal(versionPattern.test(version), true, `schema should accept version ${version}`)
    const pack = await examplePack()
    pack.version = version
    assert.equal(normalizeVdNodePack(pack).version, version)
  }
  for (const version of invalidVersions) {
    assert.equal(versionPattern.test(version), false, `schema should reject version ${version}`)
    const pack = await examplePack()
    pack.version = version
    assert.throws(() => normalizeVdNodePack(pack), /node version/i)
  }

  const installable = await examplePack()
  installable.type = 'com.deepseek/video-upscale'
  installable.version = '1.2.3-rc.1+cuda.12'
  const installed = await nodes.install(installable)
  assert.equal(installed.type, installable.type)
  assert.equal(installed.version, installable.version)
  assert.equal(nodes.get(installable.type, installable.version).digest, installed.digest)
})
