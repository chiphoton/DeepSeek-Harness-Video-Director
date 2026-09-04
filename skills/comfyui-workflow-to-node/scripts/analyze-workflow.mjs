#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const OPERATIONS = new Set([
  'image-generation',
  'image-edit',
  'video-generation',
  'audio-generation',
])

const PRIMARY_FIELDS = new Set(['prompt', 'width', 'height', 'duration', 'frames', 'seed'])
const TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const MEDIA_OUTPUTS = new Map([
  ['image', ['saveimage', 'previewimage']],
  ['video', ['savevideo', 'videocombine']],
  ['audio', ['saveaudio']],
])

function usage() {
  return `Usage: node analyze-workflow.mjs <workflow.json> [options]

Options:
  --type <namespaced-id>    Node type (default: local.<filename>)
  --title <title>           Display title (default: filename)
  --version <semver>        Node version (default: 0.1.0)
  --operation <operation>   image-generation | image-edit | video-generation | audio-generation
  --help                    Show this help

The analyzer reads one trusted ComfyUI API-format workflow and prints a
declarative Video Director node pack. It does not execute or install it.`
}

function fail(message) {
  process.stderr.write(`analyze-workflow: ${message}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help') return { help: true }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    if (!['type', 'title', 'version', 'operation'].includes(key)) {
      throw new Error(`unknown option ${token}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    options[key] = value
    index += 1
  }
  if (positional.length !== 1) throw new Error('provide exactly one workflow JSON path')
  return { path: positional[0], ...options }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveType(value) {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

function slug(value) {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'workflow'
  return normalized.slice(0, 100).replace(/-+$/u, '') || 'workflow'
}

function identifier(value) {
  const words = String(value).replace(/([a-z0-9])([A-Z])/gu, '$1 $2').split(/[^A-Za-z0-9]+/u).filter(Boolean)
  if (words.length === 0) return 'field'
  const [first, ...rest] = words
  const raw = first.toLowerCase() + rest.map(word => word[0].toUpperCase() + word.slice(1).toLowerCase()).join('')
  if (raw.length <= 120) return raw
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${raw.slice(0, 111)}-${digest}`
}

function label(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .replace(/\b\w/gu, letter => letter.toUpperCase())
}

function unwrapWorkflow(document) {
  if (!isRecord(document)) throw new Error('workflow document must be a JSON object')
  if (Array.isArray(document.nodes)) {
    throw new Error('editor/UI workflow detected; export Save (API Format) from ComfyUI first')
  }
  const embedded = isRecord(document.nodeData) ? document.nodeData : undefined
  const candidate = embedded?.workflow ?? document.prompt ?? document.workflow ?? document
  if (!isRecord(candidate)) throw new Error('ComfyUI API workflow must be an object keyed by node id')
  const entries = Object.entries(candidate)
  if (entries.length === 0 || entries.length > 4000) throw new Error('workflow must contain between 1 and 4000 nodes')
  for (const [nodeId, node] of entries) {
    if (!isRecord(node) || typeof node.class_type !== 'string' || node.class_type === '' || !isRecord(node.inputs)) {
      throw new Error(`workflow node ${nodeId} must contain string class_type and object inputs`)
    }
  }
  return candidate
}

function semanticField(classTypeValue, inputNameValue, state) {
  const classType = classTypeValue.toLowerCase()
  const input = inputNameValue.toLowerCase()
  if (input === 'negative_prompt' || input === 'negativeprompt' || input === 'negative') return 'negativePrompt'
  if (input === 'prompt' || input === 'positive_prompt' || input === 'positiveprompt') return 'prompt'
  if (classType.includes('textencode') && input === 'text') {
    const id = state.textEncoders === 0 ? 'prompt' : state.textEncoders === 1 ? 'negativePrompt' : undefined
    state.textEncoders += 1
    return id
  }
  if (['seed', 'noise_seed', 'random_seed'].includes(input)) return 'seed'
  if (input === 'width' || input === 'height' || input === 'fps' || input === 'steps' || input === 'cfg') return identifier(input)
  if (input === 'duration' || input === 'seconds') return 'duration'
  if (input === 'length' || input === 'frames' || input === 'frame_count' || input === 'num_frames') return 'frames'
  if (input === 'scheduler' || input === 'sampler_name') return identifier(input)
  return undefined
}

function inputPort(classTypeValue, inputNameValue, state) {
  const classType = classTypeValue.toLowerCase()
  const input = inputNameValue.toLowerCase()
  if (input !== 'image' || !classType.includes('loadimage')) return undefined
  const isMask = classType.includes('mask')
  const base = isMask ? 'mask' : state.imagePorts === 0 ? 'image' : `image${String(state.imagePorts + 1)}`
  if (!isMask) state.imagePorts += 1
  return {
    id: base,
    label: label(base),
    types: isMask ? ['mask', 'image'] : ['image', 'sketch'],
    required: true,
  }
}

function fieldSchema(type, id, value) {
  if (type === 'string') return { type: 'string', maxLength: id === 'prompt' || id === 'negativePrompt' ? 100000 : 2048 }
  if (type === 'boolean') return { type: 'boolean' }
  const schema = { type: 'number' }
  if (Number.isInteger(value)) schema.integer = true
  if (['seed', 'width', 'height', 'frames', 'steps', 'fps'].includes(id)) schema.min = 0
  return schema
}

function control(type, id) {
  if (id === 'prompt' || id === 'negativePrompt') return 'textarea'
  if (type === 'boolean') return 'checkbox'
  return 'input'
}

function inferOutputs(workflow) {
  const found = new Set()
  for (const node of Object.values(workflow)) {
    const classType = node.class_type.toLowerCase()
    for (const [kind, markers] of MEDIA_OUTPUTS) {
      if (markers.some(marker => classType.includes(marker))) found.add(kind)
    }
  }
  return [...found].map(kind => ({ id: kind, label: label(kind), types: [kind] }))
}

function inferOperation(outputs, inputs) {
  const kinds = new Set(outputs.flatMap(output => output.types))
  if (kinds.has('video')) return 'video-generation'
  if (kinds.has('audio') && !kinds.has('image')) return 'audio-generation'
  if (kinds.has('image')) return inputs.some(port => port.types.includes('image') || port.types.includes('sketch') || port.types.includes('mask'))
    ? 'image-edit'
    : 'image-generation'
  return undefined
}

function categoryFor(operation) {
  if (operation === 'video-generation') return 'video'
  if (operation === 'audio-generation') return 'audio'
  return 'image'
}

function makeDraft(workflow, options) {
  const warnings = []
  const fields = []
  const fieldsById = new Map()
  const inputs = []
  const inputIds = new Set()
  const bindings = []
  const state = { textEncoders: 0, imagePorts: 0 }

  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, defaultValue] of Object.entries(node.inputs)) {
      const type = primitiveType(defaultValue)
      if (type === undefined) continue

      const port = inputPort(node.class_type, inputName, state)
      if (port !== undefined) {
        if (!inputIds.has(port.id)) {
          inputs.push(port)
          inputIds.add(port.id)
        }
        bindings.push({
          target: { nodeId, input: inputName },
          source: { kind: 'port', portId: port.id },
        })
        continue
      }

      const semantic = semanticField(node.class_type, inputName, state)
      let fieldId = semantic ?? identifier(`${node.class_type}-${inputName}-${nodeId}`)
      if (fieldsById.has(fieldId) && fieldsById.get(fieldId).schema.type !== type) {
        fieldId = identifier(`${fieldId}-${nodeId}-${inputName}`)
      }
      let field = fieldsById.get(fieldId)
      if (field === undefined) {
        const fieldLabel = semantic === undefined ? `${label(node.class_type)} · ${label(inputName)}` : label(fieldId)
        field = {
          id: fieldId,
          label: fieldLabel.slice(0, 160),
          schema: fieldSchema(type, fieldId, defaultValue),
          default: defaultValue,
          placement: PRIMARY_FIELDS.has(fieldId) ? 'primary' : 'advanced',
          control: control(type, fieldId),
        }
        fieldsById.set(fieldId, field)
        fields.push(field)
      } else if (field.default !== defaultValue) {
        warnings.push(`field ${fieldId} maps inputs with conflicting defaults; retained ${JSON.stringify(field.default)} instead of ${JSON.stringify(defaultValue)}`)
      }
      bindings.push({
        target: { nodeId, input: inputName },
        source: { kind: 'field', fieldId },
      })
    }
  }

  const outputs = inferOutputs(workflow)
  if (outputs.length === 0) warnings.push('no supported SaveImage, SaveVideo, VideoCombine, or SaveAudio output was detected')
  const inferredOperation = inferOperation(outputs, inputs)
  const operation = options.operation ?? inferredOperation
  if (operation === undefined) throw new Error('operation is ambiguous; pass --operation explicitly')
  if (!OPERATIONS.has(operation)) throw new Error(`unsupported operation ${operation}`)
  if (!TYPE_PATTERN.test(options.type) || options.type.length > 128) {
    throw new Error(`node type ${options.type} must be a lowercase namespaced id with at most 128 characters`)
  }
  if (!VERSION_PATTERN.test(options.version) || options.version.length > 64) {
    throw new Error(`node version ${options.version} must be SemVer`)
  }
  if (options.title.length === 0 || options.title.length > 120) {
    throw new Error('node title must contain between 1 and 120 characters')
  }
  if (options.operation !== undefined && inferredOperation !== undefined && options.operation !== inferredOperation) {
    warnings.push(`declared operation ${options.operation} differs from inferred ${inferredOperation}; review input/output topology`)
  }
  if (inputs.length > 1) warnings.push('multiple media inputs were inferred; confirm each semantic role and ordering')
  if (state.textEncoders > 2) warnings.push('more than two text encoders were found; confirm prompt polarity and auxiliary text fields')

  const pack = {
    protocol: 'video-director.node/v1',
    type: options.type,
    version: options.version,
    manifest: {
      title: options.title,
      description: 'Offline-generated draft. Review every binding, field placement, dependency, and output before installation.',
      category: categoryFor(operation),
      inputs,
      outputs,
      fields,
    },
    implementation: {
      kind: 'comfyui.workflow',
      operation,
      workflow,
      bindings,
      output: 'auto',
    },
  }
  return { pack, warnings }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    process.stderr.write(`${usage()}\n`)
    return
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  try {
    const text = await readFile(args.path, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024) throw new Error('workflow document exceeds 20 MiB')
    const document = JSON.parse(text)
    const workflow = unwrapWorkflow(document)
    const stem = basename(args.path).replace(/\.[^.]+$/u, '')
    const options = {
      type: args.type ?? `local.${slug(stem)}`,
      title: args.title ?? label(stem),
      version: args.version ?? '0.1.0',
      operation: args.operation,
    }
    const { pack, warnings } = makeDraft(workflow, options)
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
    process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

await main()
