import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let portsModule
let parameterInputsModule

async function ports() {
  if (portsModule !== undefined) return portsModule
  const entry = fileURLToPath(new URL('../src/client/ports.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  portsModule = await import(`data:text/javascript;base64,${source}`)
  return portsModule
}

async function parameterInputs() {
  if (parameterInputsModule !== undefined) return parameterInputsModule
  const entry = fileURLToPath(new URL('../src/client/parameter-inputs.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  parameterInputsModule = await import(`data:text/javascript;base64,${source}`)
  return parameterInputsModule
}

test('synthetic Result output ports keep their handle but hide the overlapping label', async () => {
  const { shouldShowPortLabel } = await ports()

  assert.equal(shouldShowPortLabel('output', { id: 'result', label: 'Result' }), false)
  assert.equal(shouldShowPortLabel('output', { id: 'audio', label: 'Audio' }), true)
  assert.equal(shouldShowPortLabel('output', { id: 'audio', label: 'Audio' }, false), false)
  assert.equal(shouldShowPortLabel('input', { id: 'reference', label: 'Reference' }), false)
})

test('reference panels render only when the workflow exposes a real reference port', async () => {
  const { shouldShowReferencePanel } = await ports()
  const reference = { id: 'reference', label: 'References', types: ['image'], multiple: true }

  assert.equal(shouldShowReferencePanel('prompt-enhancer', undefined), true)
  assert.equal(shouldShowReferencePanel('image-generation', reference), true)
  assert.equal(shouldShowReferencePanel('image-generation', undefined), false)
  assert.equal(shouldShowReferencePanel('video-generation', reference), true)
  assert.equal(shouldShowReferencePanel('video-generation', undefined), false)
  assert.equal(shouldShowReferencePanel('audio-generation', reference), true)
  assert.equal(shouldShowReferencePanel('audio-generation', undefined), false)
})

test('workflow References and enabled text parameters stay embedded beside their own controls', async () => {
  const { embeddedWorkflowInputPortIds, inputPortsFor } = await ports()
  const reference = { id: 'reference', label: 'References', types: ['image'], multiple: true }
  const definition = { inputs: [reference, { id: 'flow', label: 'Flow', types: ['flow'], multiple: true }] }

  for (const kind of ['video-generation', 'image-generation', 'prompt-enhancer']) {
    const data = { kind, title: kind, fieldInputModes: { prompt: { mode: 'input' } } }
    const inputs = inputPortsFor(data, definition)
    assert.deepEqual(embeddedWorkflowInputPortIds(data, inputs), ['reference', 'field:prompt'])
  }

  const audio = { kind: 'audio-generation', title: 'Audio', fieldInputModes: { prompt: { mode: 'input' } } }
  const audioInputs = inputPortsFor(audio, { inputs: [{ id: 'flow', label: 'Flow', types: ['flow'], multiple: true }] })
  assert.deepEqual(embeddedWorkflowInputPortIds(audio, audioInputs), ['field:prompt'])
})

test('video modes expose the exact number of frame reference inputs', async () => {
  const { inputPortsFor } = await ports()
  const definition = {
    inputs: [
      { id: 'reference', label: 'Reference', types: ['image'], multiple: true },
      { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
    ],
  }

  assert.deepEqual(
    inputPortsFor({ kind: 'video-generation', videoMode: 'text-to-video' }, definition).map(port => port.id),
    ['flow'],
  )
  assert.deepEqual(
    inputPortsFor({ kind: 'video-generation', workflowId: 'builtin-minimax-h3-video-turbo' }, definition).map(port => port.id),
    ['flow'],
  )
  assert.deepEqual(
    inputPortsFor({ kind: 'video-generation', videoMode: 'first-frame-locked' }, definition),
    [
      { id: 'reference', label: 'Reference', types: ['image'], multiple: false, required: true },
      { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
    ],
  )
  assert.deepEqual(
    inputPortsFor({ kind: 'video-generation', videoMode: 'first-to-last-frame' }, definition),
    [
      { id: 'reference', label: 'Reference', types: ['image'], multiple: true, required: true },
      { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
    ],
  )
})

test('reference-to-video keeps its typed Reference port even if stale frame-mode state exists', async () => {
  const { inputPortsFor } = await ports()
  const reference = {
    id: 'reference', label: 'Reference', types: ['image', 'audio', 'video'], multiple: true,
    maxByType: { image: 2, audio: 2, video: 1 },
  }
  const definition = { inputs: [reference, { id: 'flow', label: 'Flow', types: ['flow'], multiple: true }] }

  assert.deepEqual(
    inputPortsFor({
      kind: 'video-generation',
      workflowId: 'builtin-minimax-h3-reference-to-video-turbo',
      videoMode: 'text-to-video',
    }, definition),
    definition.inputs,
  )
})

test('reference-to-video rejects connections beyond each media-type slot limit', async () => {
  const { resolveConnectionPorts } = await ports()
  const definition = {
    type: 'builtin.r2v', version: '1.0.0', digest: 'r2v', title: 'R2V', description: '', category: 'video',
    builtIn: true, behavior: 'workflow', workflowId: 'builtin-minimax-h3-reference-to-video-turbo', fields: [],
    inputs: [{
      id: 'reference', label: 'Reference', types: ['image', 'audio', 'video'], multiple: true,
      maxByType: { image: 2, audio: 2, video: 1 },
    }],
    outputs: [{ id: 'result', label: 'Result', types: ['video'] }],
  }
  const graph = {
    nodes: [
      ...['one', 'two', 'three'].map(id => ({
        id, type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: id, mediaKind: 'image' },
      })),
      {
        id: 'target', type: 'director', position: { x: 300, y: 0 },
        data: { kind: 'video-generation', title: 'R2V', nodeType: definition.type, nodeVersion: definition.version, workflowId: definition.workflowId },
      },
    ],
    edges: [
      { id: 'one-target', source: 'one', sourceHandle: 'out', target: 'target', targetHandle: 'in', data: { targetPortId: 'reference' } },
      { id: 'two-target', source: 'two', sourceHandle: 'out', target: 'target', targetHandle: 'in', data: { targetPortId: 'reference' } },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  assert.throws(() => resolveConnectionPorts(graph, [definition], {
    source: 'three', sourceHandle: 'out', target: 'target', targetHandle: 'in',
  }), /at most 2 image/i)
})

test('parameter inputs expose only eligible text fields and resolve connected values over local fallbacks', async () => {
  const {
    activeFieldInputModes,
    parameterInputCandidates,
    resolveParameterInputs,
  } = await parameterInputs()
  const definition = {
    type: 'local.workflow.example', version: '1.0.0', digest: 'test', title: 'Example', description: '', category: 'video',
    builtIn: false, behavior: 'workflow', workflowId: 'workflow-example', inputs: [], outputs: [],
    fields: [
      { id: 'prompt', label: 'Manifest prompt', type: 'text', default: '', placement: 'primary' },
      { id: 'style', label: 'Style', type: 'text', default: '', placement: 'primary' },
      { id: 'steps', label: 'Steps', type: 'number', default: 6, placement: 'advanced' },
    ],
    parameterInputs: [
      { id: 'prompt', label: 'Prompt', type: 'text' },
      { id: 'style', label: 'Style', type: 'text' },
    ],
  }
  const generic = {
    kind: 'video-generation', title: 'Generic', workflowId: definition.workflowId,
    prompt: 'local prompt', negativePrompt: 'local negative', workflowValues: { style: 'local style' },
    fieldInputModes: { prompt: { mode: 'input' }, style: { mode: 'input' }, steps: { mode: 'input' } },
  }

  assert.deepEqual(parameterInputCandidates(generic, definition), [
    { id: 'prompt', label: 'Prompt', type: 'text' },
    { id: 'style', label: 'Style', type: 'text' },
  ])
  assert.deepEqual(activeFieldInputModes(generic, definition), {
    prompt: { mode: 'input' },
    style: { mode: 'input' },
  })
  assert.deepEqual(resolveParameterInputs(generic, definition, [
    { targetPortId: 'field:prompt', text: 'connected prompt' },
  ]), {
    prompt: 'connected prompt',
    negativePrompt: 'local negative',
    workflowValues: { style: 'local style' },
  })
  assert.throws(
    () => resolveParameterInputs(generic, definition, [{ targetPortId: 'field:style' }]),
    /Style is connected.*no text value/i,
  )

  const pinned = { ...generic, nodeType: definition.type, nodeVersion: definition.version }
  assert.deepEqual(parameterInputCandidates(pinned, definition).map(candidate => candidate.id), ['prompt', 'style'])

  assert.deepEqual(parameterInputCandidates({
    kind: 'image-generation', title: 'Direct provider', prompt: '', negativePrompt: '',
  }, undefined).map(candidate => candidate.id), ['prompt', 'negativePrompt'])
  assert.deepEqual(parameterInputCandidates({
    kind: 'prompt-enhancer', title: 'Enhancer', prompt: '',
  }, undefined).map(candidate => candidate.id), ['prompt'])
  assert.deepEqual(parameterInputCandidates({
    kind: 'video-generation', title: 'Legacy inline', prompt: '', negativePrompt: '',
    workflow: { sampler: { class_type: 'Sampler', inputs: {} } },
    bindings: [{ nodeId: 'sampler', input: 'prompt', from: 'prompt' }],
  }, undefined).map(candidate => candidate.id), ['prompt'])
})

test('legacy inline workflows infer only media ports backed by asset bindings', async () => {
  const { inputPortsFor } = await ports()
  const promptOnly = {
    kind: 'video-generation', title: 'Prompt only', workflow: { node: {} },
    bindings: [{ nodeId: 'node', input: 'prompt', from: 'prompt' }],
  }
  assert.deepEqual(inputPortsFor(promptOnly, undefined).filter(port => !port.types.includes('flow')), [])

  const reference = {
    ...promptOnly,
    bindings: [
      ...promptOnly.bindings,
      { nodeId: 'load', input: 'image', from: 'asset', portId: 'image-reference' },
    ],
  }
  assert.deepEqual(inputPortsFor(reference, undefined).filter(port => !port.types.includes('flow')), [{
    id: 'image-reference',
    label: 'image-reference',
    types: ['image', 'audio', 'video', 'sketch', 'mask'],
    multiple: true,
  }])
})

test('dynamic field ports keep canonical handles without renaming a lone static input', async () => {
  const {
    inputPortsFor,
    nodeDefinition,
    portHandleId,
    resolveConnectionPorts,
  } = await ports()
  const definition = {
    type: 'local.workflow.caption', version: '1.0.0', digest: 'test', title: 'Caption', description: '', category: 'video',
    builtIn: false, behavior: 'workflow', workflowId: 'workflow-caption',
    fields: [{ id: 'caption', label: 'Caption', type: 'text', default: '', placement: 'primary' }],
    inputs: [{ id: 'reference', label: 'Reference', types: ['image'], multiple: true }],
    outputs: [{ id: 'result', label: 'Result', types: ['video'] }],
  }
  const targetData = {
    kind: 'video-generation', title: 'Target', workflowId: definition.workflowId,
    fieldInputModes: { caption: { mode: 'input' } },
  }
  const resolvedDefinition = nodeDefinition(targetData, [definition])
  const inputs = inputPortsFor(targetData, resolvedDefinition)

  assert.equal(resolvedDefinition, definition)
  assert.deepEqual(inputs.map(port => ({
    id: port.id,
    handle: portHandleId('input', port, inputs),
  })), [
    { id: 'reference', handle: 'in' },
    { id: 'flow', handle: 'in:flow' },
    { id: 'field:caption', handle: 'in:field:caption' },
  ])

  const graph = {
    nodes: [
      { id: 'source', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Text', mediaKind: 'text', text: 'hello' } },
      { id: 'target', type: 'director', position: { x: 300, y: 0 }, data: targetData },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  const resolved = resolveConnectionPorts(graph, [definition], {
    source: 'source', sourceHandle: 'out', target: 'target', targetHandle: 'in:field:caption',
  })
  assert.equal(resolved.targetPortId, 'field:caption')
  assert.equal(resolved.targetHandle, 'in:field:caption')
})

test('quick-add recommendation prefers a compatible required input but supports optional-only Custom Nodes', async () => {
  const { preferredCompatibleInputPort } = await ports()
  const inputs = [
    { id: 'optional-image', label: 'Optional image', types: ['image'] },
    { id: 'required-audio', label: 'Audio', types: ['audio'], required: true },
    { id: 'required-image', label: 'Image', types: ['image', 'mask'], required: true },
  ]

  assert.equal(preferredCompatibleInputPort(inputs, ['image']).id, 'required-image')
  assert.equal(preferredCompatibleInputPort([inputs[0]], ['image']).id, 'optional-image')
  assert.equal(preferredCompatibleInputPort(inputs, ['video']), undefined)
})

test('flow ports connect as ordering edges without satisfying required media inputs', async () => {
  const { mediaTypesIntersect, validateNodeInputPorts } = await ports()
  assert.equal(mediaTypesIntersect(['image'], ['flow']), true)
  assert.equal(mediaTypesIntersect(['flow'], ['video']), true)

  const trigger = {
    type: 'core.comfyui-clear', version: '1.0.0', digest: 'test-trigger', title: 'Clear', description: '', category: 'utility',
    builtIn: true, behavior: 'trigger', triggerAction: 'comfyui-clear', fields: [],
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }],
  }
  const generator = {
    type: 'example.image-edit', version: '1.0.0', digest: 'test-generator', title: 'Edit', description: '', category: 'image',
    builtIn: false, behavior: 'workflow', fields: [], outputs: [{ id: 'result', label: 'Result', types: ['image'] }],
    inputs: [{ id: 'reference', label: 'Reference', types: ['image'], required: true }],
  }
  const graph = {
    nodes: [
      { id: 'clear', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'comfyui-clear', title: 'Clear', nodeType: trigger.type } },
      { id: 'edit', type: 'director', position: { x: 300, y: 0 }, data: { kind: 'image-edit', title: 'Edit', nodeType: generator.type } },
    ],
    edges: [{ id: 'clear-edit', source: 'clear', target: 'edit', sourceHandle: 'out', targetHandle: 'in' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  assert.throws(() => validateNodeInputPorts(graph, [trigger, generator], 'edit'), /Reference is required/)
})

test('text workflow output connects to the rendered VRAM trigger flow handle', async () => {
  const {
    inputPortsFor,
    nodeDefinition,
    portHandleId,
    resolveConnectionPorts,
  } = await ports()
  const trigger = {
    type: 'core.ollama-eject', version: '1.0.0', digest: 'test-trigger', title: 'Ollama Eject Model', description: '', category: 'utility',
    builtIn: true, behavior: 'trigger', triggerAction: 'ollama-eject', fields: [],
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }],
  }
  const targetData = {
    kind: 'ollama-eject', title: trigger.title, nodeType: trigger.type, nodeVersion: trigger.version,
  }
  const targetDefinition = nodeDefinition(targetData, [trigger])
  const targetInputs = inputPortsFor(targetData, targetDefinition)
  const renderedTargetHandle = portHandleId('input', targetInputs[0], targetInputs)
  const graph = {
    nodes: [
      { id: 'text', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'prompt-enhancer', title: 'Prompt Enhancer', prompt: '' } },
      { id: 'eject', type: 'director', position: { x: 300, y: 0 }, data: targetData },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const resolved = resolveConnectionPorts(graph, [trigger], {
    source: 'text', sourceHandle: 'out', target: 'eject', targetHandle: renderedTargetHandle,
  })

  assert.equal(resolved.sourcePortId, 'output')
  assert.equal(resolved.targetPortId, 'flow-in')
  assert.equal(resolved.targetHandle, renderedTargetHandle)
})

test('quick-add resolves the exact dragged output handle and its media types', async () => {
  const { resolveNodePort } = await ports()
  const definition = {
    type: 'example.multi-output', version: '1.0.0', digest: 'test', title: 'Multi', description: '', category: 'utility',
    builtIn: false, behavior: 'workflow', fields: [], inputs: [],
    outputs: [
      { id: 'image', label: 'Image', types: ['image'] },
      { id: 'audio', label: 'Audio', types: ['audio'] },
    ],
  }
  const graph = {
    nodes: [{
      id: 'source', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'video-generation', title: 'Source', nodeType: definition.type, nodeVersion: definition.version },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  const output = resolveNodePort(graph, [definition], 'source', 'output', 'out:audio')

  assert.equal(output.handle, 'out:audio')
  assert.equal(output.port.id, 'audio')
  assert.deepEqual(output.port.types, ['audio'])
})
