import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JobManager } from './jobs.js'
import { VdNodeRegistry } from './node-registry.js'
import { ProviderSettings, PROVIDER_SETTINGS_NAMESPACE } from './provider-settings.js'
import { ProjectStore } from './project-store.js'
import { ProviderRuntime } from './providers.js'
import { createDirectorRpc } from './rpc.js'
import { ComfyWorkflowStore } from './workflow-store.js'

export const name = 'video-director'
export const inject = ['connection']

const MAX_ASSET_BYTES = 200 * 1024 * 1024

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
})

const RuntimeSettingsSchema = z.object({
  providerOverrides: z.dict(ProviderOverrideSchema).default({}),
  minimaxH3LicenseAccepted: z.boolean().default(true),
})

export const Config = z.object({
  dataDir: z.string().default('./.dsh-video-director'),
  maxAssetBytes: z.natural().min(1).max(MAX_ASSET_BYTES).default(MAX_ASSET_BYTES),
  jobConcurrency: z.natural().min(1).max(8).default(2),
  minimaxH3LicenseAccepted: z.boolean().default(true),
  providers: z.array(ProviderSchema).default([]),
})

export async function apply(ctx, config) {
  const store = new ProjectStore(config.dataDir, config.maxAssetBytes)
  await store.init()
  const comfyWorkflows = new ComfyWorkflowStore(store.root)
  await comfyWorkflows.init()
  const vdNodes = new VdNodeRegistry(comfyWorkflows)

  const assetRoutes = new Set()
  const registerAsset = async (asset) => {
    if (assetRoutes.has(asset.id)) return
    ctx.connection.fetch.register({
      path: asset.url,
      methods: ['GET', 'HEAD'],
      fetch: request => store.assetResponse(asset.id, request),
    })
    assetRoutes.add(asset.id)
  }
  for (const asset of store.listAssets()) await registerAsset(asset)

  let providers
  const providerSettings = new ProviderSettings({
    providers: config.providers,
    minimaxH3LicenseAccepted: config.minimaxH3LicenseAccepted,
  }, resolved => {
    providers?.configure(resolved.providers, resolved.minimaxH3LicenseAccepted)
  })
  const initialProviderSettings = providerSettings.resolved()
  providers = new ProviderRuntime({
    store,
    registerAsset,
    providers: initialProviderSettings.providers,
    tools: ctx.get('tools'),
    minimaxH3LicenseAccepted: initialProviderSettings.minimaxH3LicenseAccepted,
  })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, PROVIDER_SETTINGS_NAMESPACE, RuntimeSettingsSchema, {
      providerOverrides: {},
      minimaxH3LicenseAccepted: config.minimaxH3LicenseAccepted,
    }, {
      setSource: source => providerSettings.attach(settingsCtx.settings, source),
      onChange: () => providerSettings.refresh(),
    })
  })
  const jobs = new JobManager(store, providers, { concurrency: config.jobConcurrency })
  await jobs.recover()
  ctx.connection.rpc.handle('/video-director', createDirectorRpc({
    store,
    providers,
    jobs,
    registerAsset,
    workflows: comfyWorkflows,
    nodes: vdNodes,
    providerSettings,
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
  ctx.logger.info(`video-director: serving ${String((await store.listProjects()).length)} vd-project(s), ${String(comfyWorkflows.list().length)} registered comfyui-workflow(s), and ${String(vdNodes.list().length)} vd-node definition(s) from ${store.root}`)
}
