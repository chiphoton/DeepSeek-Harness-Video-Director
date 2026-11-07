import z from '@deepseek-ai/schemastery'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDirectorHost } from './director-host.js'
import { canvasTool } from './canvas-agent.js'
import { libraryTool } from './library-agent.js'
import { qualityTool } from './quality-agent.js'
import { workspaceTool } from './workspace-agent.js'
import { PROVIDER_SETTINGS_NAMESPACE } from './provider-settings.js'

export const name = 'video-director'
export const inject = ['connection']

const MAX_ASSET_BYTES = 200 * 1024 * 1024
const DIRECTOR_WORKSPACE = 'Video-Director'

function skillMarkdownBody(content) {
  if (!content.startsWith('---\n')) return content.trim()
  const closingFence = content.indexOf('\n---\n', 4)
  if (closingFence < 0) throw new Error('bundled skill has an unterminated YAML frontmatter block')
  return content.slice(closingFence + 5).trim()
}

const ProviderSchema = z.object({
  id: z.string().required(),
  label: z.string().required(),
  kind: z.union(['ollama', 'openai-compatible', 'codex-plan', 'comfyui', 'comfyui-mcp']).required(),
  baseUrl: z.string(),
  apiKey: z.string().role('secret'),
  requiresApiKey: z.boolean().default(false),
  model: z.string(),
  imageModel: z.string(),
  fastMode: z.boolean().default(false),
  mcpTool: z.string(),
  mcpBaseUrl: z.string(),
  timeoutMs: z.natural().min(1_000).default(120_000),
  pollIntervalMs: z.natural().min(100).default(1_500),
})

const ProviderOverrideSchema = z.object({
  label: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().role('secret'),
  model: z.string(),
  imageModel: z.string(),
  fastMode: z.boolean(),
})

export const Config = z.object({
  dataDir: z.string().default('./.dsh-video-director'),
  maxAssetBytes: z.natural().min(1).max(MAX_ASSET_BYTES).default(MAX_ASSET_BYTES),
  jobConcurrency: z.natural().min(1).max(8).default(2),
  minimaxH3LicenseAccepted: z.boolean().default(true).volatile(),
  providerOverrides: z.dict(ProviderOverrideSchema).default({}).volatile(),
  providers: z.array(ProviderSchema).default([
    { id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-vl' },
    {
      id: 'comfyui',
      label: 'ComfyUI',
      kind: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      mcpTool: 'mcp__comfyui__call_tool',
      mcpBaseUrl: 'http://127.0.0.1:8188',
    },
    { id: 'openai', label: 'OpenAI Compatible', kind: 'openai-compatible', requiresApiKey: true },
    { id: 'codex-plan', label: 'Codex Coding Plan', kind: 'codex-plan', timeoutMs: 600_000 },
  ]),
})

export async function apply(ctx, config) {
  let host
  let sessionWorkspace
  ctx.inject(['workspaceRegistry', 'dshHomePath'], (workspaceCtx) => {
    workspaceCtx.effect(() => {
      const path = workspaceCtx.dshHomePath('workspaces', DIRECTOR_WORKSPACE)
      const pending = mkdir(path, { recursive: true, mode: 0o700 })
        .then(() => workspaceCtx.workspaceRegistry.create(path, DIRECTOR_WORKSPACE))
        .then(workspace => workspace.id)
        .catch(error => {
          workspaceCtx.logger.warn('video-director: could not initialize its DSH workspace', error)
          return undefined
        })
      sessionWorkspace = pending
      return () => { if (sessionWorkspace === pending) sessionWorkspace = undefined }
    })
  })
  const assetRoutes = new Set()
  const registerAsset = async (asset) => {
    if (assetRoutes.has(asset.id)) return
    ctx.effect(() => ctx.connection.fetch.register({
      path: asset.url,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => host.store.assetResponse(asset.id, request),
    }))
    if (asset.kind === 'video' || asset.kind === 'audio') ctx.effect(() => ctx.connection.fetch.register({
      path: `${asset.url}/properties`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const result = await host.rpc('assets/properties', { assetId: asset.id }, request.signal)
        return Response.json(result, { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
      },
    }))
    assetRoutes.add(asset.id)
  }
  // Cordis keeps these handles stable while the profile is edited in place.
  const settingsSnapshot = () => ({
    providerOverrides: config.providerOverrides.get(),
    minimaxH3LicenseAccepted: config.minimaxH3LicenseAccepted.get(),
  })
  host = await createDirectorHost({ ...config, ...settingsSnapshot() }, { registerAsset, tools: ctx.get('tools') })
  ctx.inject(['tools'], toolsCtx => {
    for (const tool of [canvasTool(host, toolsCtx), libraryTool(host), qualityTool(host), workspaceTool(host)]) toolsCtx.tools.register(tool)
  })
  const { providerSettings } = host
  providerSettings.attach(undefined, settingsSnapshot)
  ctx.on('loader/volatile-update', () => providerSettings.refresh())
  ctx.on('dispose', () => host.close())
  ctx.inject(['settings'], (settingsCtx) => {
    const entryId = ctx.fiber.entry?.options.id ?? PROVIDER_SETTINGS_NAMESPACE
    settingsCtx.effect(() => {
      providerSettings.attach(settingsCtx.settings, settingsSnapshot, entryId)
      return () => providerSettings.attach(undefined, settingsSnapshot, entryId)
    })
  })
  // Exact /api routes inherit DSH's browser authentication and owner-only
  // admission. rc.2's custom-channel getter captures its provider Context,
  // which cannot access webServer in a normal plugin composition.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/video-director',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      const parsed = clientRequestSchema.safeParse(body)
      if (!parsed.success || parsed.data.method !== 'video-director'
        || typeof parsed.data.payload?.endpoint !== 'string') {
        return new Response('invalid Video Director request', { status: 400 })
      }
      const { rpcId, payload } = parsed.data
      const result = await host.rpc(payload.endpoint, payload.payload, request.signal)
      if (payload.endpoint === 'projects/list' && result.ok) {
        const workspaceId = await sessionWorkspace
        if (workspaceId !== undefined) result.value.workspaceId = workspaceId
      }
      return Response.json({ type: 'server-response', rpcId, result })
    },
  }))
  const skillUrl = new URL('../skills/comfyui-workflow-to-node/SKILL.md', import.meta.url)
  const skillContent = skillMarkdownBody(await readFile(skillUrl, 'utf8'))
  ctx.inject(['skills'], (skillsCtx) => {
    skillsCtx.skills.register({
      name: 'comfyui-workflow-to-node',
      description: 'Convert a trusted API-format comfyui-workflow or exactly mapped ComfyUI editor template into a registered comfyui-workflow or declarative vd-node pack (Custom Node v1).',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      resourceBase: { kind: 'directory', path: dirname(fileURLToPath(skillUrl)) },
      path: fileURLToPath(skillUrl),
      content: skillContent,
    })
  })
  ctx.logger.info(`video-director: serving ${String((await host.store.listProjects()).length)} vd-project(s), ${String(host.workflows.list().length)} registered comfyui-workflow(s), and ${String(host.nodes.list().length)} vd-node definition(s) from ${host.store.root}`)
}
