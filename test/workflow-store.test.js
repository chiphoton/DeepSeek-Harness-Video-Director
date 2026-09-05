import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ComfyWorkflowStore } from '../src/workflow-store.js'

async function createStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-director-workflows-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new ComfyWorkflowStore(root)
  await store.init()
  return { root, store }
}

function parameterDocument() {
  return {
    '1': {
      class_type: 'ConfigurableNode',
      inputs: {
        text: 'hello',
        count: 3,
        enabled: true,
        connection: ['2', 0],
      },
    },
    '2': { class_type: 'SourceNode', inputs: { value: 1 } },
  }
}

function explicitParameter(overrides = {}) {
  return {
    id: 'count',
    nodeId: '1',
    input: 'count',
    label: 'Count',
    group: 'Config',
    type: 'number',
    default: 3,
    ...overrides,
  }
}

function importDocument(store, name, options = {}) {
  return store.import({
    name,
    kind: 'image-generation',
    document: parameterDocument(),
    ...options,
  })
}

test('ComfyWorkflowStore exposes immutable built-ins without sending their full graphs to the client', async (t) => {
  const { store } = await createStore(t)
  const workflows = store.list()

  assert.equal(workflows.length, 6)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-minimax-h3-video-turbo'), true)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-minimax-h3-reference-to-video-turbo'), true)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-minimax-h3-audio-standard'), true)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-z-image-turbo'), true)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-comfyui-image-basic'), false)
  assert.equal(workflows.some(workflow => workflow.id === 'builtin-qwen-image-edit-consistent'), true)
  assert.equal(workflows.every(workflow => workflow.builtIn), true)
  assert.equal(workflows.every(workflow => !('workflow' in workflow) && !('bindings' in workflow)), true)
  await assert.rejects(store.remove('builtin-minimax-h3-video-turbo'), /built-in workflows cannot be removed/i)
})

test('every built-in workflow that exposes Seed starts new nodes at 1001', async (t) => {
  const { store } = await createStore(t)
  const seeded = store.list().filter(workflow => workflow.defaults.seed !== undefined)

  assert.ok(seeded.length > 0)
  assert.deepEqual(
    seeded.map(workflow => [workflow.id, workflow.defaults.seed]),
    seeded.map(workflow => [workflow.id, 1001]),
  )
})

test('Qwen-Image-Edit (Consistent) exposes two ordered references and only its requested Advanced controls', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-qwen-image-edit-consistent')
  const resolved = store.resolve(descriptor.id, {
    checkpointModel: 'qwen-edit-v2.safetensors',
    loraModel: 'consistent-style.safetensors',
    loraStrength: 0.65,
    steps: 8,
    cfg: 1.5,
  })

  assert.equal(descriptor.name, 'Qwen-Image-Edit (Consistent)')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    seed: 1001,
    seedControlAfterGenerate: 'randomize',
  })
  assert.deepEqual(descriptor.parameters.map(parameter => parameter.id), ['checkpointModel', 'loraModel', 'loraStrength', 'steps', 'cfg'])
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.group]),
    [
      ['checkpointModel', 'Models'],
      ['loraModel', 'LoRA'],
      ['loraStrength', 'LoRA'],
      ['steps', 'Sampling'],
      ['cfg', 'Sampling'],
    ],
  )
  assert.deepEqual(
    store.modelParameters()
      .filter(parameter => parameter.workflowId === descriptor.id)
      .filter(parameter => parameter.parameterId === 'checkpointModel' || parameter.parameterId === 'loraModel')
      .map(parameter => ({ parameterId: parameter.parameterId, targets: parameter.targets })),
    [
      { parameterId: 'checkpointModel', targets: [{ nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' }] },
      { parameterId: 'loraModel', targets: [{ nodeClass: 'LoraLoaderModelOnly', input: 'lora_name' }] },
    ],
  )
  assert.deepEqual(resolved.bindings, [
    { nodeId: '4', input: 'image', from: 'asset', portId: 'reference', portIndex: 0 },
    { nodeId: '5', input: 'image', from: 'asset', portId: 'reference', portIndex: 1, optional: true, omitNodeWhenMissing: true },
    { nodeId: '1', input: 'prompt', from: 'prompt' },
    { nodeId: '6', input: 'seed', from: 'seed' },
  ])
  assert.equal(resolved.workflow['1'].inputs.prompt, '<prompt_here>')
  assert.equal(resolved.workflow['17'].inputs.ckpt_name, 'qwen-edit-v2.safetensors')
  assert.equal(resolved.workflow['13'].inputs.lora_name, 'consistent-style.safetensors')
  assert.equal(resolved.workflow['13'].inputs.strength_model, 0.65)
  assert.equal(resolved.workflow['6'].inputs.steps, 8)
  assert.equal(resolved.workflow['6'].inputs.cfg, 1.5)
  assert.deepEqual(resolved.workflow['16'], {
    class_type: 'PreviewImage',
    inputs: { images: ['9', 0] },
  })
})

test('Z-Image Turbo exposes dimensions, exact KSampler controls, and no media bindings', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-z-image-turbo')
  const resolved = store.resolve(descriptor.id, {
    diffusionModel: 'z-image-test.safetensors',
    clipModel: 'qwen-test.safetensors',
    vaeModel: 'test-vae.safetensors',
    steps: 12,
    cfg: 1.5,
    samplerName: 'euler',
    scheduler: 'simple',
  })

  assert.equal(descriptor.name, 'Z-Image Turbo')
  assert.equal(descriptor.kind, 'image-generation')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    seed: 1001,
    width: 1024,
    height: 1024,
    steps: 8,
    scheduler: 'sgm_uniform',
    seedControlAfterGenerate: 'randomize',
  })
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.placement, parameter.group]),
    [
      ['diffusionModel', 'advanced', 'Models'],
      ['clipModel', 'advanced', 'Models'],
      ['vaeModel', 'advanced', 'Models'],
      ['steps', 'advanced', 'KSampler'],
      ['cfg', 'advanced', 'KSampler'],
      ['samplerName', 'advanced', 'KSampler'],
      ['scheduler', 'advanced', 'KSampler'],
    ],
  )
  assert.deepEqual(resolved.bindings, [
    { nodeId: '5', input: 'text', from: 'prompt' },
    { nodeId: '4', input: 'width', from: 'width' },
    { nodeId: '4', input: 'height', from: 'height' },
    { nodeId: '7', input: 'seed', from: 'seed' },
  ])
  assert.equal(resolved.bindings.some(binding => binding.from === 'asset' || binding.from === 'maskAsset'), false)
  assert.deepEqual(resolved.workflow['4'].inputs, { width: 1024, height: 1024, batch_size: 1 })
  assert.deepEqual(resolved.workflow['5'].inputs, { text: '<prompt_here>', clip: ['2', 0] })
  assert.deepEqual(resolved.workflow['6'].inputs, { model: ['1', 0], shift: 3 })
  assert.equal(resolved.workflow['1'].inputs.unet_name, 'z-image-test.safetensors')
  assert.equal(resolved.workflow['2'].inputs.clip_name, 'qwen-test.safetensors')
  assert.equal(resolved.workflow['3'].inputs.vae_name, 'test-vae.safetensors')
  assert.deepEqual(resolved.workflow['7'].inputs, {
    model: ['6', 0],
    seed: 1001,
    steps: 12,
    cfg: 1.5,
    sampler_name: 'euler',
    scheduler: 'simple',
    positive: ['5', 0],
    negative: ['8', 0],
    latent_image: ['4', 0],
    denoise: 1,
  })
  assert.deepEqual(resolved.workflow['10'], {
    class_type: 'PreviewImage',
    inputs: { images: ['9', 0] },
  })
  assert.deepEqual(
    store.modelParameters()
      .filter(parameter => parameter.workflowId === descriptor.id)
      .map(parameter => ({ parameterId: parameter.parameterId, targets: parameter.targets })),
    [
      { parameterId: 'diffusionModel', targets: [{ nodeClass: 'UNETLoader', input: 'unet_name' }] },
      { parameterId: 'clipModel', targets: [{ nodeClass: 'CLIPLoader', input: 'clip_name' }] },
      { parameterId: 'vaeModel', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
      { parameterId: 'steps', targets: [{ nodeClass: 'KSampler', input: 'steps' }] },
      { parameterId: 'cfg', targets: [{ nodeClass: 'KSampler', input: 'cfg' }] },
      { parameterId: 'samplerName', targets: [{ nodeClass: 'KSampler', input: 'sampler_name' }] },
      { parameterId: 'scheduler', targets: [{ nodeClass: 'KSampler', input: 'scheduler' }] },
    ],
  )
})

test('MiniMax-H3 Text/Image to Video (Turbo) maps resolution controls and prunes frame loaders for each mode', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-minimax-h3-video-turbo')

  assert.equal(descriptor.name, 'MiniMax-H3 Text/Image to Video (Turbo)')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    modelFamily: 'minimax-h3',
    seed: 1001,
    duration: 5,
    fps: 24,
    variant: 'turbo',
    steps: 4,
    scheduler: 'simple',
    seedControlAfterGenerate: 'randomize',
    videoMode: 'text-to-video',
  })
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.placement, parameter.group]),
    [
      ['aspectRatio', 'primary', 'Resolution Selector'],
      ['megapixels', 'primary', 'Resolution Selector'],
      ['diffusionModel', 'advanced', 'Models'],
      ['clipModel', 'advanced', 'Models'],
      ['loraModel', 'advanced', 'LoRA'],
      ['loraStrength', 'advanced', 'LoRA'],
      ['videoVae', 'advanced', 'Models'],
      ['audioVae', 'advanced', 'Models'],
    ],
  )

  const values = {
    aspectRatio: '16:9 (Widescreen)',
    megapixels: 0.98,
    diffusionModel: 'h3-video.safetensors',
    clipModel: 'h3-clip.safetensors',
    loraModel: 'h3-turbo.safetensors',
    loraStrength: 0.8,
    videoVae: 'h3-video-vae.safetensors',
    audioVae: 'h3-audio-vae.safetensors',
  }
  const textToVideo = store.resolve(descriptor.id, values, { videoMode: 'text-to-video' })
  assert.equal('136' in textToVideo.workflow, false)
  assert.equal('139' in textToVideo.workflow, false)
  assert.equal('first_frame' in textToVideo.workflow['131'].inputs, false)
  assert.equal('last_frame' in textToVideo.workflow['131'].inputs, false)
  assert.equal(textToVideo.requiredReferenceCount, 0)
  assert.equal(textToVideo.workflow['115'].inputs.aspect_ratio, '16:9 (Widescreen)')
  assert.equal(textToVideo.workflow['115'].inputs.megapixels, 0.98)
  assert.equal(textToVideo.workflow['127'].inputs.unet_name, 'h3-video.safetensors')
  assert.equal(textToVideo.workflow['128'].inputs.clip_name, 'h3-clip.safetensors')
  assert.equal(textToVideo.workflow['134'].inputs.lora_name, 'h3-turbo.safetensors')
  assert.equal(textToVideo.workflow['134'].inputs.strength, 0.8)
  assert.equal(textToVideo.workflow['119'].inputs.vae_name, 'h3-video-vae.safetensors')
  assert.equal(textToVideo.workflow['120'].inputs.vae_name, 'h3-audio-vae.safetensors')

  const firstFrame = store.resolve(descriptor.id, values, { videoMode: 'first-frame-locked' })
  assert.equal('136' in firstFrame.workflow, true)
  assert.equal('139' in firstFrame.workflow, false)
  assert.deepEqual(firstFrame.bindings.filter(binding => binding.frameRole !== undefined), [
    { nodeId: '136', input: 'image', from: 'asset', portId: 'reference', portIndex: 0, frameRole: 'first' },
  ])
  assert.equal(firstFrame.requiredReferenceCount, 1)

  const lastFrame = store.resolve(descriptor.id, values, { videoMode: 'last-frame-locked' })
  assert.equal('136' in lastFrame.workflow, false)
  assert.equal('139' in lastFrame.workflow, true)
  assert.deepEqual(lastFrame.bindings.filter(binding => binding.frameRole !== undefined), [
    { nodeId: '139', input: 'image', from: 'asset', portId: 'reference', portIndex: 0, frameRole: 'last' },
  ])
  assert.equal(lastFrame.requiredReferenceCount, 1)

  const firstToLast = store.resolve(descriptor.id, values, { videoMode: 'first-to-last-frame' })
  assert.equal('136' in firstToLast.workflow, true)
  assert.equal('139' in firstToLast.workflow, true)
  assert.deepEqual(firstToLast.bindings.filter(binding => binding.frameRole !== undefined), [
    { nodeId: '136', input: 'image', from: 'asset', portId: 'reference', portIndex: 0, frameRole: 'first' },
    { nodeId: '139', input: 'image', from: 'asset', portId: 'reference', portIndex: 1, frameRole: 'last' },
  ])
  assert.equal(firstToLast.requiredReferenceCount, 2)
  assert.deepEqual(
    store.modelParameters()
      .filter(parameter => parameter.workflowId === descriptor.id)
      .map(parameter => ({ parameterId: parameter.parameterId, targets: parameter.targets })),
    [
      { parameterId: 'aspectRatio', targets: [{ nodeClass: 'ResolutionSelector', input: 'aspect_ratio' }] },
      { parameterId: 'megapixels', targets: [{ nodeClass: 'ResolutionSelector', input: 'megapixels' }] },
      { parameterId: 'diffusionModel', targets: [{ nodeClass: 'UNETLoader', input: 'unet_name' }] },
      { parameterId: 'clipModel', targets: [{ nodeClass: 'CLIPLoader', input: 'clip_name' }] },
      { parameterId: 'loraModel', targets: [{ nodeClass: 'MiniMaxH3TurboLoRA', input: 'lora_name' }] },
      { parameterId: 'loraStrength', targets: [{ nodeClass: 'MiniMaxH3TurboLoRA', input: 'strength' }] },
      { parameterId: 'videoVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
      { parameterId: 'audioVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
    ],
  )
})

test('MiniMax-H3 Reference to Video (Turbo) maps typed references and mirrors the Turbo video controls', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-minimax-h3-reference-to-video-turbo')
  const resolved = store.resolve(descriptor.id, {
    aspectRatio: '16:9 (Widescreen)',
    megapixels: 0.98,
    diffusionModel: 'h3-ref.safetensors',
    clipModel: 'h3-clip.safetensors',
    loraModel: 'h3-turbo.safetensors',
    loraStrength: 0.75,
    videoVae: 'h3-video-vae.safetensors',
    audioVae: 'h3-audio-vae.safetensors',
  })

  assert.equal(descriptor.name, 'MiniMax-H3 Reference to Video (Turbo)')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    modelFamily: 'minimax-h3',
    seed: 1001,
    duration: 15,
    fps: 24,
    variant: 'turbo',
    steps: 4,
    scheduler: 'simple',
    seedControlAfterGenerate: 'randomize',
  })
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.placement, parameter.group]),
    [
      ['aspectRatio', 'primary', 'Resolution Selector'],
      ['megapixels', 'primary', 'Resolution Selector'],
      ['diffusionModel', 'advanced', 'Models'],
      ['clipModel', 'advanced', 'Models'],
      ['loraModel', 'advanced', 'LoRA'],
      ['loraStrength', 'advanced', 'LoRA'],
      ['videoVae', 'advanced', 'Models'],
      ['audioVae', 'advanced', 'Models'],
    ],
  )
  assert.deepEqual(
    resolved.bindings.filter(binding => binding.referenceKind !== undefined),
    [
      { nodeId: '137', input: 'image', from: 'asset', portId: 'reference', portIndex: 0, optional: true, omitNodeWhenMissing: true, referenceKind: 'image' },
      { nodeId: '139', input: 'image', from: 'asset', portId: 'reference', portIndex: 1, optional: true, omitNodeWhenMissing: true, referenceKind: 'image' },
      { nodeId: '145', input: 'audio', from: 'asset', portId: 'reference', portIndex: 0, optional: true, omitNodeWhenMissing: true, referenceKind: 'audio' },
      { nodeId: '146', input: 'audio', from: 'asset', portId: 'reference', portIndex: 1, optional: true, omitNodeWhenMissing: true, referenceKind: 'audio' },
      { nodeId: '144', input: 'file', from: 'asset', portId: 'reference', portIndex: 0, optional: true, omitNodeWhenMissing: true, referenceKind: 'video', omitNodeIdsWhenMissing: ['144', '143'] },
    ],
  )
  assert.deepEqual(resolved.workflow['136'].inputs['ref_images.ref_image_0'], ['137', 0])
  assert.deepEqual(resolved.workflow['136'].inputs['ref_images.ref_image_1'], ['139', 0])
  assert.deepEqual(resolved.workflow['136'].inputs['ref_videos.ref_video_0'], ['143', 0])
  assert.deepEqual(resolved.workflow['136'].inputs['ref_video_audios.ref_video_audio_0'], ['143', 1])
  assert.deepEqual(resolved.workflow['136'].inputs['ref_audios.ref_audio_0'], ['145', 0])
  assert.deepEqual(resolved.workflow['136'].inputs['ref_audios.ref_audio_1'], ['146', 0])
  assert.deepEqual(resolved.workflow['136'].inputs.prompt, ['138', 0])
  assert.equal(resolved.workflow['138'].inputs.value, '<video_prompt>')
  assert.equal(resolved.workflow['132'].inputs.value, 15)
  assert.equal(resolved.workflow['115'].inputs.aspect_ratio, '16:9 (Widescreen)')
  assert.equal(resolved.workflow['115'].inputs.megapixels, 0.98)
  assert.equal(resolved.workflow['127'].inputs.unet_name, 'h3-ref.safetensors')
  assert.equal(resolved.workflow['128'].inputs.clip_name, 'h3-clip.safetensors')
  assert.equal(resolved.workflow['141'].inputs.lora_name, 'h3-turbo.safetensors')
  assert.equal(resolved.workflow['141'].inputs.strength, 0.75)
  assert.equal(resolved.workflow['119'].inputs.vae_name, 'h3-video-vae.safetensors')
  assert.equal(resolved.workflow['120'].inputs.vae_name, 'h3-audio-vae.safetensors')
})

test('MiniMax-H3 Audio (Turbo) maps the supplied audio template controls and model selectors', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-minimax-h3-audio-turbo')
  const resolved = store.resolve(descriptor.id, {
    format: 'opus',
    diffusionModel: 'h3-unet.safetensors',
    clipModel: 'h3-clip.safetensors',
    loraModel: 'h3-turbo.safetensors',
    videoVae: 'h3-video-vae.safetensors',
    audioVae: 'h3-audio-vae.safetensors',
  })

  assert.equal(descriptor.name, 'MiniMax-H3 Audio (Turbo)')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    modelFamily: 'minimax-h3',
    seed: 1001,
    width: 32,
    height: 32,
    duration: 5,
    fps: 24,
    variant: 'turbo',
    steps: 4,
    scheduler: 'simple',
    seedControlAfterGenerate: 'randomize',
  })
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.placement, parameter.group]),
    [
      ['format', 'primary', 'Output'],
      ['diffusionModel', 'advanced', 'Models'],
      ['clipModel', 'advanced', 'Models'],
      ['loraModel', 'advanced', 'Models'],
      ['videoVae', 'advanced', 'Models'],
      ['audioVae', 'advanced', 'Models'],
    ],
  )
  assert.deepEqual(resolved.bindings, [
    { nodeId: '104', input: 'prompt', from: 'prompt' },
    { nodeId: '104', input: 'width', from: 'literal', value: 32 },
    { nodeId: '104', input: 'height', from: 'literal', value: 32 },
    { nodeId: '135', input: 'value', from: 'duration' },
    { nodeId: '15', input: 'noise_seed', from: 'seed' },
    { nodeId: '9', input: 'steps', from: 'steps' },
  ])
  assert.equal(resolved.workflow['104'].inputs.prompt, '<audio_prompt>')
  assert.deepEqual(resolved.workflow['104'].inputs.length, ['136', 1])
  assert.equal(resolved.workflow['136'].inputs['values.a'][0], '135')
  assert.equal(resolved.workflow['137'].class_type, 'SaveAudioAdvanced')
  assert.equal(resolved.workflow['137'].inputs.format, 'opus')
  assert.equal(resolved.workflow['6'].inputs.unet_name, 'h3-unet.safetensors')
  assert.equal(resolved.workflow['13'].inputs.clip_name, 'h3-clip.safetensors')
  assert.equal(resolved.workflow['134'].inputs.lora_name, 'h3-turbo.safetensors')
  assert.equal(resolved.workflow['11'].inputs.vae_name, 'h3-video-vae.safetensors')
  assert.equal(resolved.workflow['24'].inputs.vae_name, 'h3-audio-vae.safetensors')
  assert.deepEqual(
    store.modelParameters()
      .filter(parameter => parameter.workflowId === descriptor.id)
      .map(parameter => ({ parameterId: parameter.parameterId, targets: parameter.targets })),
    [
      { parameterId: 'format', targets: [{ nodeClass: 'SaveAudioAdvanced', input: 'format' }] },
      { parameterId: 'diffusionModel', targets: [{ nodeClass: 'UNETLoader', input: 'unet_name' }] },
      { parameterId: 'clipModel', targets: [{ nodeClass: 'CLIPLoader', input: 'clip_name' }] },
      { parameterId: 'loraModel', targets: [{ nodeClass: 'MiniMaxH3TurboLoRA', input: 'lora_name' }] },
      { parameterId: 'videoVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
      { parameterId: 'audioVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
    ],
  )
})

test('MiniMax-H3 Audio (Standard) maps the supplied non-LoRA audio template', async (t) => {
  const { store } = await createStore(t)
  const descriptor = store.list().find(workflow => workflow.id === 'builtin-minimax-h3-audio-standard')
  const resolved = store.resolve(descriptor.id, {
    format: 'opus',
    diffusionModel: 'h3-unet.safetensors',
    clipModel: 'h3-clip.safetensors',
    videoVae: 'h3-video-vae.safetensors',
    audioVae: 'h3-audio-vae.safetensors',
  })

  assert.equal(descriptor.name, 'MiniMax-H3 Audio (Standard)')
  assert.deepEqual(descriptor.defaults, {
    prompt: '',
    modelFamily: 'minimax-h3',
    seed: 1001,
    width: 32,
    height: 32,
    duration: 5,
    fps: 24,
    variant: 'standard',
    steps: 20,
    scheduler: 'simple',
    seedControlAfterGenerate: 'randomize',
  })
  assert.deepEqual(
    descriptor.parameters.map(parameter => [parameter.id, parameter.placement, parameter.group]),
    [
      ['format', 'primary', 'Output'],
      ['diffusionModel', 'advanced', 'Models'],
      ['clipModel', 'advanced', 'Models'],
      ['videoVae', 'advanced', 'Models'],
      ['audioVae', 'advanced', 'Models'],
    ],
  )
  assert.deepEqual(resolved.bindings, [
    { nodeId: '104', input: 'prompt', from: 'prompt' },
    { nodeId: '104', input: 'width', from: 'literal', value: 32 },
    { nodeId: '104', input: 'height', from: 'literal', value: 32 },
    { nodeId: '105', input: 'value', from: 'duration' },
    { nodeId: '15', input: 'noise_seed', from: 'seed' },
    { nodeId: '9', input: 'steps', from: 'steps' },
  ])
  assert.equal(resolved.workflow['104'].inputs.prompt, '<audio_prompt>')
  assert.deepEqual(resolved.workflow['104'].inputs.length, ['106', 1])
  assert.equal(resolved.workflow['106'].inputs['values.a'][0], '105')
  assert.equal(resolved.workflow['107'].class_type, 'SaveAudioAdvanced')
  assert.equal(resolved.workflow['107'].inputs.format, 'opus')
  assert.equal(resolved.workflow['6'].inputs.unet_name, 'h3-unet.safetensors')
  assert.equal(resolved.workflow['13'].inputs.clip_name, 'h3-clip.safetensors')
  assert.equal(resolved.workflow['11'].inputs.vae_name, 'h3-video-vae.safetensors')
  assert.equal(resolved.workflow['24'].inputs.vae_name, 'h3-audio-vae.safetensors')
  assert.deepEqual(resolved.workflow['9'].inputs.model, ['6', 0])
  assert.deepEqual(resolved.workflow['16'].inputs.model, ['6', 0])
  assert.equal(resolved.workflow['17'].class_type, 'KSamplerSelect')
  assert.equal(resolved.workflow['17'].inputs.sampler_name, 'res_multistep')
  assert.equal(Object.values(resolved.workflow).some(node => node.class_type === 'MiniMaxH3TurboLoRA'), false)
  assert.deepEqual(
    store.modelParameters()
      .filter(parameter => parameter.workflowId === descriptor.id)
      .map(parameter => ({ parameterId: parameter.parameterId, targets: parameter.targets })),
    [
      { parameterId: 'format', targets: [{ nodeClass: 'SaveAudioAdvanced', input: 'format' }] },
      { parameterId: 'diffusionModel', targets: [{ nodeClass: 'UNETLoader', input: 'unet_name' }] },
      { parameterId: 'clipModel', targets: [{ nodeClass: 'CLIPLoader', input: 'clip_name' }] },
      { parameterId: 'videoVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
      { parameterId: 'audioVae', targets: [{ nodeClass: 'VAELoader', input: 'vae_name' }] },
    ],
  )
})

test('ComfyWorkflowStore imports API-format graphs, extracts an interface, persists it, and resolves parameter values', async (t) => {
  const { root, store } = await createStore(t)
  const document = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'positive', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'negative', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7.5, model: ['1', 0] } },
  }
  const descriptor = await store.import({
    name: 'Portrait workflow',
    kind: 'image-generation',
    description: 'Test import',
    document,
  })

  assert.equal(descriptor.name, 'Portrait workflow')
  assert.equal(descriptor.builtIn, false)
  assert.equal(descriptor.parameters.some(parameter => parameter.input === 'ckpt_name'), true)
  assert.equal(descriptor.parameters.some(parameter => parameter.input === 'cfg'), true)
  assert.equal(descriptor.parameters.some(parameter => parameter.input === 'text'), false)

  const checkpointModelParameter = store.modelParameters().find(parameter => (
    parameter.workflowId === descriptor.id && parameter.parameterId === descriptor.parameters.find(candidate => candidate.input === 'ckpt_name').id
  ))
  assert.deepEqual(checkpointModelParameter.targets, [{ nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' }])
  assert.equal(store.modelParameters().some(parameter => (
    parameter.workflowId === 'builtin-minimax-h3-video-turbo' && parameter.parameterId === 'diffusionModel'
  )), true)

  const checkpoint = descriptor.parameters.find(parameter => parameter.input === 'ckpt_name')
  const cfg = descriptor.parameters.find(parameter => parameter.input === 'cfg')
  const resolved = store.resolve(descriptor.id, {
    [checkpoint.id]: 'portrait-v2.safetensors',
    [cfg.id]: 5.25,
  })
  assert.equal(resolved.workflow['1'].inputs.ckpt_name, 'portrait-v2.safetensors')
  assert.equal(resolved.workflow['5'].inputs.cfg, 5.25)
  assert.deepEqual(resolved.bindings.filter(binding => binding.from === 'prompt' || binding.from === 'negativePrompt'), [
    { nodeId: '2', input: 'text', from: 'prompt' },
    { nodeId: '3', input: 'text', from: 'negativePrompt' },
  ])

  const reloaded = new ComfyWorkflowStore(root)
  await reloaded.init()
  assert.equal(reloaded.list().some(workflow => workflow.id === descriptor.id), true)
  assert.equal(reloaded.resolve(descriptor.id, {}).workflow['1'].inputs.ckpt_name, 'base.safetensors')
})

test('ComfyWorkflowStore rejects ComfyUI UI-format graphs with an actionable export instruction', async (t) => {
  const { store } = await createStore(t)
  await assert.rejects(store.import({
    name: 'Wrong format',
    kind: 'image-edit',
    document: { nodes: [], links: [] },
  }), /Save \(API Format\)/i)
})

test('ComfyWorkflowStore infers the MiniMax H3 policy family from custom API graphs', async (t) => {
  const { store } = await createStore(t)
  const descriptor = await store.import({
    name: 'Custom H3 workflow',
    kind: 'video-generation',
    document: {
      '1': { class_type: 'MiniMaxH3TurboSampler', inputs: { steps: 6 } },
      '2': { class_type: 'ModelLoader', inputs: { model: 'minimax_h3_video_fp16.safetensors' } },
    },
  })

  assert.equal(descriptor.modelFamily, 'minimax-h3')
  assert.equal(store.resolve(descriptor.id, {}).modelFamily, 'minimax-h3')

  await assert.rejects(store.import({
    name: 'Disguised H3 workflow',
    kind: 'video-generation',
    document: {
      nodeData: {
        modelFamily: 'ordinary-model',
        workflow: {
          '1': { class_type: 'MiniMaxH3TurboSampler', inputs: { steps: 6 } },
        },
      },
    },
  }), /conflicts with detected minimax-h3 topology/i)

  const promptOnly = await store.import({
    name: 'Prompt mentions H3',
    kind: 'image-generation',
    document: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'A comparison with MiniMax H3', clip: ['2', 0] } },
      '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ordinary.safetensors' } },
    },
  })
  assert.equal(promptOnly.modelFamily, undefined)
})

test('ComfyWorkflowStore validates caller-defined parameters against the workflow graph', async (t) => {
  const { store } = await createStore(t)

  const descriptor = await importDocument(store, 'Explicit parameters', {
    parameters: [explicitParameter()],
  })
  assert.equal(store.resolve(descriptor.id, { count: 9 }).workflow['1'].inputs.count, 9)

  await assert.rejects(importDocument(store, 'Too many parameters', {
    parameters: Array.from({ length: 257 }, (_, index) => explicitParameter({ id: `parameter-${String(index)}` })),
  }), /at most 256 entries/i)

  await assert.rejects(importDocument(store, 'Duplicate parameter ids', {
    parameters: [
      explicitParameter({ id: 'duplicate' }),
      explicitParameter({ id: 'duplicate', input: 'enabled', label: 'Enabled', type: 'boolean', default: true }),
    ],
  }), /id duplicate must be unique/i)

  await assert.rejects(importDocument(store, 'Missing node', {
    parameters: [explicitParameter({ nodeId: '404' })],
  }), /references missing node 404/i)

  await assert.rejects(importDocument(store, 'Missing input', {
    parameters: [explicitParameter({ input: 'missing' })],
  }), /references missing input 1\.missing/i)

  await assert.rejects(importDocument(store, 'Non-primitive input', {
    parameters: [explicitParameter({ input: 'connection', label: 'Connection' })],
  }), /must reference a primitive workflow input/i)

  await assert.rejects(importDocument(store, 'Mismatched input type', {
    parameters: [explicitParameter({ type: 'text', default: 'three' })],
  }), /type text does not match workflow input type number/i)

  const recovered = await importDocument(store, 'Queue remains usable', {
    parameters: [explicitParameter({ input: 'enabled', id: 'enabled', label: 'Enabled', type: 'boolean', default: true })],
  })
  assert.equal(recovered.name, 'Queue remains usable')
})

test('ComfyWorkflowStore validates explicit binding targets and media indexes', async (t) => {
  const { store } = await createStore(t)
  const base = {
    name: 'Explicit bindings',
    kind: 'image-edit',
    document: parameterDocument(),
  }

  await assert.rejects(store.import({
    ...base,
    bindings: [{ nodeId: '404', input: 'text', from: 'prompt' }],
  }), /missing comfyui-node/i)
  await assert.rejects(store.import({
    ...base,
    bindings: [{ nodeId: '1', input: 'missing', from: 'prompt' }],
  }), /missing comfyui-node input/i)
  await assert.rejects(store.import({
    ...base,
    bindings: [{ nodeId: '1', input: 'text', from: 'asset', mediaIndex: -1 }],
  }), /integer from 0 to 31/i)
  await assert.rejects(store.import({
    ...base,
    bindings: [
      { nodeId: '1', input: 'text', from: 'prompt' },
      { nodeId: '1', input: 'text', from: 'negativePrompt' },
    ],
  }), /binding target 1\.text must be unique/i)

  const valid = await store.import({
    ...base,
    bindings: [{ nodeId: '1', input: 'text', from: 'asset', mediaIndex: 2 }],
  })
  assert.equal(valid.name, base.name)
})

test('ComfyWorkflowStore serializes concurrent writes and persists their final snapshot', async (t) => {
  const { root, store } = await createStore(t)
  const imported = await Promise.all(Array.from(
    { length: 20 },
    (_, index) => importDocument(store, `Concurrent ${String(index)}`),
  ))

  const removed = imported.filter((_, index) => index % 2 === 0)
  const added = await Promise.all([
    ...removed.map(workflow => store.remove(workflow.id)),
    ...Array.from({ length: 6 }, (_, index) => importDocument(store, `Later ${String(index)}`)),
  ])
  assert.equal(added.length, 16)

  const expectedIds = store.list().filter(workflow => !workflow.builtIn).map(workflow => workflow.id).sort()
  const reloaded = new ComfyWorkflowStore(root)
  await reloaded.init()
  const persistedIds = reloaded.list().filter(workflow => !workflow.builtIn).map(workflow => workflow.id).sort()
  assert.deepEqual(persistedIds, expectedIds)
  assert.equal(persistedIds.length, 16)
})

test('ComfyWorkflowStore publishes copy-on-write state only after persistence succeeds', async (t) => {
  const { root, store } = await createStore(t)
  const existing = await importDocument(store, 'Existing')
  const registryPath = store.path
  const before = store.list()
  const blockedPath = join(root, 'blocked-target')
  await mkdir(blockedPath)
  store.path = blockedPath

  await assert.rejects(importDocument(store, 'Must not leak'))
  assert.deepEqual(store.list(), before)

  await assert.rejects(store.remove(existing.id))
  assert.equal(store.list().some(workflow => workflow.id === existing.id), true)

  store.path = registryPath
  const recovered = await importDocument(store, 'Recovered after failure')
  await store.remove(existing.id)

  const reloaded = new ComfyWorkflowStore(root)
  await reloaded.init()
  const custom = reloaded.list().filter(workflow => !workflow.builtIn)
  assert.deepEqual(custom.map(workflow => workflow.id), [recovered.id])
})
