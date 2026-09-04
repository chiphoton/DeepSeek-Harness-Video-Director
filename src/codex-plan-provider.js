import { Codex } from '@openai/codex-sdk'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

import { DirectorInputError, string } from './validation.js'

export const CODEX_PLAN_MODELS = Object.freeze([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
])

const MODEL_SET = new Set(CODEX_PLAN_MODELS)
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])
const EXTENSION_BY_IMAGE_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])

export function codexPlanReasoningEffort(model) {
  if (!MODEL_SET.has(model)) {
    throw new DirectorInputError(`Codex Plan model must be one of: ${CODEX_PLAN_MODELS.join(', ')}`)
  }
  return 'medium'
}

function selectedModel(input, provider) {
  const model = string(input.model ?? provider.model ?? CODEX_PLAN_MODELS[0], 'Codex Plan model', { min: 1, max: 128 })
  if (!MODEL_SET.has(model)) {
    throw new DirectorInputError(`Codex Plan model must be one of: ${CODEX_PLAN_MODELS.join(', ')}`)
  }
  return model
}

function canonicalImageData(data, mimeType) {
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return undefined
  const normalized = data.trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) return undefined
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== normalized) return undefined
  return { bytes, mimeType: mimeType.split(';', 1)[0].toLowerCase() }
}

function imageDataUrl(value) {
  if (typeof value !== 'string') return undefined
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value.trim())
  return match === null ? undefined : canonicalImageData(match[2], match[1])
}

function resultImages(value, seen = new Set()) {
  if (typeof value === 'string') {
    const decoded = imageDataUrl(value)
    return decoded === undefined ? [] : [decoded]
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap(item => resultImages(item, seen))

  const direct = canonicalImageData(value.data, value.mimeType ?? value.mime_type)
  const embedded = value.type === 'resource' && typeof value.resource === 'object' && value.resource !== null
    ? canonicalImageData(value.resource.blob, value.resource.mimeType ?? value.resource.mime_type)
    : undefined
  const imageUrlValue = typeof value.image_url === 'string'
    ? value.image_url
    : typeof value.image_url?.url === 'string'
      ? value.image_url.url
      : typeof value.imageUrl === 'string'
        ? value.imageUrl
        : typeof value.imageUrl?.url === 'string'
          ? value.imageUrl.url
          : undefined
  return [
    ...(direct === undefined ? [] : [direct]),
    ...(embedded === undefined ? [] : [embedded]),
    ...(imageUrlValue === undefined ? [] : resultImages(imageUrlValue, seen)),
    ...resultImages(value.content, seen),
    ...resultImages(value.structured_content, seen),
    ...resultImages(value.structuredContent, seen),
    ...resultImages(value.output, seen),
    ...resultImages(value.result, seen),
  ]
}

function assetExtension(asset) {
  return EXTENSION_BY_IMAGE_MIME.get(asset.mimeType)
    ?? extname(asset.name).slice(1).replace(/[^A-Za-z0-9]/gu, '').toLowerCase()
    ?? 'png'
}

function imagePrompt(input, referenceCount) {
  const prompt = string(input.prompt ?? '', 'prompt', { min: 1, max: 100_000 })
  const width = Number.isSafeInteger(input.width) && input.width > 0 ? input.width : 1024
  const height = Number.isSafeInteger(input.height) && input.height > 0 ? input.height : 1024
  const negativePrompt = typeof input.negativePrompt === 'string' && input.negativePrompt.trim() !== ''
    ? `\nNegative constraints: ${input.negativePrompt.trim()}`
    : ''
  const references = referenceCount === 0
    ? ''
    : `\nUse the ${String(referenceCount)} attached local image${referenceCount === 1 ? '' : 's'} as visual references while preserving the user's requested intent.`
  return [
    'Use the installed $imagegen skill and its native image-generation tool to create exactly one finished image.',
    'Improve the art direction internally where helpful, but do not change the user’s subject, story, or constraints.',
    `Requested canvas: ${String(width)} x ${String(height)} pixels.${references}${negativePrompt}`,
    `User art direction:\n${prompt}`,
    'Return the generated image in the tool result or save it in the current working directory. Do not modify any other files.',
  ].join('\n\n')
}

function textPrompt(input, referenceCount) {
  const prompt = string(input.prompt ?? '', 'prompt', { min: 1, max: 100_000 })
  const defaultInstruction = input.operation === 'prompt-enhancer'
    ? 'Expand the user prompt into one production-ready prompt. Preserve the user intent and return only the enhanced prompt.'
    : 'Follow the user request and return only the requested final text.'
  const systemPrompt = typeof input.systemPrompt === 'string' && input.systemPrompt.trim() !== ''
    ? string(input.systemPrompt, 'system prompt', { min: 1, max: 100_000 })
    : defaultInstruction
  const context = typeof input.context === 'string' && input.context.trim() !== ''
    ? `\n\nConnected-node context:\n${input.context}`
    : ''
  const references = referenceCount === 0
    ? ''
    : `\n\nUse the ${String(referenceCount)} attached local image${referenceCount === 1 ? '' : 's'} as visual reference material.`
  return `${systemPrompt}\n\nUser prompt:\n${prompt}${context}${references}\n\nReturn only the finished text, without commentary or Markdown fences.`
}

async function generatedFileImage(directory, excludedNames) {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter(entry => entry.isFile() && !excludedNames.has(entry.name) && IMAGE_MIME_BY_EXTENSION.has(extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))
  const selected = candidates.at(-1)
  if (selected === undefined) return undefined
  return {
    bytes: await readFile(join(directory, selected.name)),
    mimeType: IMAGE_MIME_BY_EXTENSION.get(extname(selected.name).toLowerCase()),
  }
}

function actionableCodexError(error) {
  if (error?.name === 'AbortError') return error
  const message = error instanceof Error ? error.message : String(error)
  if (/auth|login|sign[ -]?in|unauthorized|credential/iu.test(message)) {
    return new Error('Codex Plan could not authenticate. Sign in to Codex on this machine, then retry the workflow node.')
  }
  return error instanceof Error ? error : new Error(message)
}

export class CodexPlanImageRuntime {
  constructor(options) {
    this.store = options.store
    this.registerAsset = options.registerAsset ?? (async () => {})
    this.createCodex = options.createCodex ?? (() => new Codex())
    this.temporaryRoot = options.temporaryRoot ?? tmpdir()
  }

  async run(provider, input, signal, progress = () => {}) {
    if (input.operation !== 'image-generation') {
      throw new DirectorInputError(`${provider.label} only supports image generation`)
    }
    const model = selectedModel(input, provider)
    const reasoningEffort = codexPlanReasoningEffort(model)
    const directory = await mkdtemp(join(this.temporaryRoot, 'dsh-video-director-codex-plan-'))
    const attached = []
    const temporaryNames = new Set()
    try {
      await progress({ phase: 'preparing-references', progress: 0.05 })
      for (const [index, assetId] of (Array.isArray(input.assetIds) ? input.assetIds : []).entries()) {
        const { asset, data } = await this.store.assetBytes(assetId)
        if (asset.kind !== 'image' && asset.kind !== 'sketch' && asset.kind !== 'mask') continue
        const extension = assetExtension(asset) || 'png'
        const name = `reference-${String(index + 1)}.${extension}`
        const path = join(directory, name)
        await writeFile(path, data, { flag: 'wx' })
        temporaryNames.add(name)
        attached.push({ type: 'local_image', path })
      }

      const codex = this.createCodex()
      const thread = codex.startThread({
        model,
        modelReasoningEffort: reasoningEffort,
        workingDirectory: directory,
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      })
      await progress({ phase: 'generating-with-codex', progress: 0.12 })
      const { events } = await thread.runStreamed([
        { type: 'text', text: imagePrompt(input, attached.length) },
        ...attached,
      ], { signal })
      const outputs = []
      for await (const event of events) {
        if (event?.type === 'item.completed') {
          outputs.push(...resultImages(event.item?.result))
          if (event.item?.type === 'mcp_tool_call') {
            await progress({ phase: 'importing-codex-image', progress: 0.88 })
          }
        }
        if (event?.type === 'turn.failed') throw new Error(event.error?.message ?? 'Codex image generation failed')
      }
      const output = outputs.at(-1) ?? await generatedFileImage(directory, temporaryNames)
      if (output === undefined || output.bytes.length === 0 || !output.mimeType.startsWith('image/')) {
        throw new Error(`${provider.label} completed without returning an image`)
      }
      await progress({ phase: 'saving-codex-image', progress: 0.95 })
      const extension = EXTENSION_BY_IMAGE_MIME.get(output.mimeType) ?? 'png'
      const asset = await this.store.putAsset({
        projectId: input.projectId,
        kind: 'image',
        name: `codex-plan-${Date.now()}.${extension}`,
        mimeType: output.mimeType,
        dataBase64: output.bytes.toString('base64'),
      })
      await this.registerAsset(asset)
      return {
        kind: 'assets',
        assets: [asset],
        providerId: provider.id,
        model,
        reasoningEffort,
        transport: 'codex-sdk',
      }
    } catch (error) {
      throw actionableCodexError(error)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async runText(provider, input, signal, progress = () => {}) {
    if (input.operation !== 'prompt-enhancer' && input.operation !== 'text-generation') {
      throw new DirectorInputError(`${provider.label} cannot run ${String(input.operation)}`)
    }
    const model = selectedModel(input, provider)
    const reasoningEffort = codexPlanReasoningEffort(model)
    const directory = await mkdtemp(join(this.temporaryRoot, 'dsh-video-director-codex-plan-text-'))
    const attached = []
    try {
      await progress({ phase: 'preparing-codex-text', progress: 0.05 })
      for (const [index, assetId] of (Array.isArray(input.assetIds) ? input.assetIds : []).entries()) {
        const { asset, data } = await this.store.assetBytes(assetId)
        if (asset.kind !== 'image' && asset.kind !== 'sketch' && asset.kind !== 'mask') continue
        const extension = assetExtension(asset) || 'png'
        const path = join(directory, `reference-${String(index + 1)}.${extension}`)
        await writeFile(path, data, { flag: 'wx' })
        attached.push({ type: 'local_image', path })
      }

      const codex = this.createCodex()
      const thread = codex.startThread({
        model,
        modelReasoningEffort: reasoningEffort,
        workingDirectory: directory,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
      })
      await progress({ phase: 'enhancing-with-codex', progress: 0.15 })
      const result = await thread.run([
        { type: 'text', text: textPrompt(input, attached.length) },
        ...attached,
      ], { signal })
      const text = typeof result.finalResponse === 'string' ? result.finalResponse.trim() : ''
      if (text === '') throw new Error(`${provider.label} returned no text`)
      await progress({ phase: 'completed', progress: 1 })
      return {
        kind: 'text',
        text,
        providerId: provider.id,
        model,
        reasoningEffort,
        transport: 'codex-sdk',
      }
    } catch (error) {
      throw actionableCodexError(error)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
