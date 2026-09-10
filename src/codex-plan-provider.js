import { createLocalCodex } from './codex-client.js'
import { actionableCodexError } from './codex-environment.js'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'

import { DirectorInputError, string } from './validation.js'

import { CodexModelCatalog } from './codex-model-catalog.js'

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
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

async function generatedFileImage(directory, excludedNames = new Set()) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile() && !excludedNames.has(entry.name) && IMAGE_MIME_BY_EXTENSION.has(extname(entry.name).toLowerCase()))
    .map(async entry => ({ name: entry.name, ...await stat(join(directory, entry.name)) })))
  const selected = candidates.filter(file => file.size > 0)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)).at(-1)
  if (selected === undefined) return undefined
  return {
    bytes: await readFile(join(directory, selected.name)),
    mimeType: IMAGE_MIME_BY_EXTENSION.get(extname(selected.name).toLowerCase()),
  }
}

export class CodexPlanImageRuntime {
  constructor(options) {
    this.store = options.store
    this.registerAsset = options.registerAsset ?? (async () => {})
    this.createCodex = options.createCodex ?? createLocalCodex
    this.models = options.codexModels ?? new CodexModelCatalog()
    this.temporaryRoot = options.temporaryRoot ?? tmpdir()
    this.generatedImagesRoot = options.generatedImagesRoot ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images')
  }

  check() {
    // The default factory checks host access without starting a model turn.
    try { this.createCodex() } catch (error) { throw actionableCodexError(error) }
  }

  async run(provider, input, signal, progress = () => {}) {
    if (input.operation !== 'image-generation') {
      throw new DirectorInputError(`${provider.label} only supports image generation`)
    }
    const directory = await mkdtemp(join(this.temporaryRoot, 'dsh-video-director-codex-'))
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

      const { model, reasoningEffort, serviceTier } = await this.models.resolve(input.model ?? provider.model, { fastMode: provider.fastMode, imageInput: true })
      signal?.throwIfAborted()
      const codex = this.createCodex({ serviceTier })
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
      let codexThreadId
      for await (const event of events) {
        if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && CODEX_THREAD_ID.test(event.thread_id)) {
          codexThreadId = event.thread_id
        }
        if (event?.type === 'item.completed') {
          outputs.push(...resultImages(event.item?.result))
          if (event.item?.type === 'mcp_tool_call') {
            await progress({ phase: 'importing-codex-image', progress: 0.88 })
          }
        }
        if (event?.type === 'turn.failed' || event?.type === 'error') throw new Error(event.error?.message ?? event.message ?? 'Codex image generation failed')
      }
      signal?.throwIfAborted()
      // Native imagegen can save a PNG without exposing image bytes in exec's JSON
      // stream. Read only this SDK thread's output folder, never another task's.
      const nativeOutput = codexThreadId === undefined ? undefined : await generatedFileImage(join(this.generatedImagesRoot, codexThreadId))
      const output = nativeOutput ?? outputs.at(-1) ?? await generatedFileImage(directory, temporaryNames)
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
    const directory = await mkdtemp(join(this.temporaryRoot, 'dsh-video-director-codex-text-'))
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

      const { model, reasoningEffort, serviceTier } = await this.models.resolve(input.model ?? provider.model, { fastMode: provider.fastMode, imageInput: attached.length > 0 })
      signal?.throwIfAborted()
      const codex = this.createCodex({ serviceTier })
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
