import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CodexModelCatalog } from './codex-model-catalog.js'
import { ExampleProjects } from './example-projects.js'
import { JobManager } from './jobs.js'
import { VdNodeRegistry } from './node-registry.js'
import { ProviderSettings } from './provider-settings.js'
import { ProjectStore } from './project-store.js'
import { ProviderRuntime } from './providers.js'
import { createDirectorRpc } from './rpc.js'
import { ComfyWorkflowStore } from './workflow-store.js'
import { DirectorInputError, record } from './validation.js'
import { chooseDataFolder, copyCanvasData, folderOpenLabel, loadStorageLocation, openDataFolder, saveStorageLocation, storageError } from './storage.js'

async function activeWorkReason(runtime) {
  if (runtime.jobs.running > 0 || runtime.jobs.queue.length > 0) return 'Wait for generation jobs to finish or cancel them before changing storage.'
  for (const project of await runtime.store.listProjects()) {
    if ((await runtime.store.listVdRuns(project.id)).some(run => run.status === 'queued' || run.status === 'running')) {
      return 'Wait for canvas workflows to finish or cancel them before changing storage.'
    }
  }
  return null
}

/** Harness owns authentication, settings and sessions; this host owns canvas data. */
export async function createDirectorHost(config, options = {}) {
  const location = await loadStorageLocation(config.dataDir)
  await mkdir(dirname(location.settingsPath), { recursive: true })
  const defaultDataDir = await realpath(dirname(location.settingsPath))
  const registerAsset = options.registerAsset ?? (async () => {})
  const examples = new ExampleProjects(options.examplesDir)
  let runtime
  let moving = false
  let choosing = false
  let closing = false
  let movePromise
  const inFlight = new Set()
  const providerSettings = new ProviderSettings(config, resolved => {
    runtime?.providers.configure(resolved.providers, resolved.minimaxH3LicenseAccepted)
  })

  const createRuntime = async dataDir => {
    const store = new ProjectStore(dataDir, config.maxAssetBytes)
    await store.init()
    const codexModels = new CodexModelCatalog({ cachePath: join(store.root, 'codex-models.json'), fetchModels: options.fetchCodexModels })
    try {
      await codexModels.init()
      const workflows = new ComfyWorkflowStore(store.root)
      await workflows.init()
      const nodes = new VdNodeRegistry(workflows)
      const providers = new ProviderRuntime({ ...options.providerOptions, store, registerAsset, tools: options.tools, ...providerSettings.resolved(), codexModels })
      const jobs = new JobManager(store, providers, { concurrency: config.jobConcurrency })
      await jobs.recover()
      const rpc = createDirectorRpc({ store, providers, jobs, registerAsset, workflows, nodes, providerSettings })
      for (const asset of store.listAssets()) await registerAsset(asset)
      return { store, providers, jobs, workflows, nodes, codexModels, rpc }
    } catch (error) {
      await codexModels.close()
      throw error
    }
  }
  runtime = await createRuntime(location.dataDir)

  const storageInfo = async () => {
    const blockedReason = moving ? 'Canvas data is being copied. Keep this window open.' : await activeWorkReason(runtime)
    return { dataDir: runtime.store.root, defaultDataDir, isDefault: await realpath(runtime.store.root) === defaultDataDir, openLabel: folderOpenLabel(), canChange: !blockedReason, blockedReason }
  }

  const moveStorage = async (payload, reset = false) => {
    if (moving || closing) throw storageError('Video Director is busy. Wait for the current storage operation to finish.', 409)
    if (payload.expectedDataDir !== runtime.store.root) throw storageError('The data folder changed in another window. Refresh Storage settings and try again.', 409)
    moving = true
    movePromise = (async () => {
      // Drain accepted writes and model-cache refreshes before copying; new RPCs wait for a retry.
      await Promise.allSettled([...inFlight])
      const blocked = await activeWorkReason(runtime)
      if (blocked) throw storageError(blocked, 409)
      const previousDataDir = runtime.store.root
      if (reset && await realpath(previousDataDir) === defaultDataDir) return { ...await storageInfo(), canChange: true, blockedReason: null, previousDataDir, backupDataDir: null }
      const { dataDir, backupDataDir } = await copyCanvasData(previousDataDir, reset ? defaultDataDir : payload.dataDir, { replaceDefault: reset })
      let next
      try {
        next = await createRuntime(dataDir)
        await saveStorageLocation(location.settingsPath, dataDir)
      } catch (error) {
        await next?.codexModels.close()
        throw storageError(`Data was copied to ${dataDir}, but Video Director could not activate it. The original folder is still in use. ${error.message}`)
      }
      await runtime.codexModels.close()
      runtime = next
      // Settings may have changed through Harness while the copy was in progress.
      providerSettings.refresh()
      return { ...await storageInfo(), canChange: true, blockedReason: null, previousDataDir, backupDataDir }
    })()
    try { return await movePromise }
    finally { moving = false; movePromise = undefined }
  }

  const rpc = async (endpoint, payload, signal) => {
    try {
      if (closing) throw storageError('Video Director is shutting down.', 503)
      const input = payload === undefined ? {} : record(payload, 'payload')
      if (endpoint.startsWith('storage/')) {
        let value
        if (endpoint === 'storage/info') value = await storageInfo()
        else if (endpoint === 'storage/change') value = await moveStorage(input)
        else if (endpoint === 'storage/reset') value = await moveStorage(input, true)
        else if (endpoint === 'storage/choose') {
          if (moving || choosing) throw storageError('Wait for the current folder operation to finish.', 409)
          choosing = true
          try { value = { dataDir: await (options.chooseFolder ?? chooseDataFolder)(runtime.store.root, { language: input.language, signal }) } }
          finally { choosing = false }
        } else if (endpoint === 'storage/open') {
          if (moving) throw storageError('Wait for the data folder change to finish.', 409)
          await (options.openFolder ?? openDataFolder)(runtime.store.root)
          value = { opened: true }
        } else throw storageError('Unknown storage operation.')
        return { ok: true, value }
      }
      if (moving) throw storageError('Canvas data is being copied. Try again when the folder change finishes.', 503)
      const operation = endpoint === 'examples/list'
        ? examples.list().then(examples => ({ ok: true, value: { examples } }))
        : endpoint === 'examples/get'
          ? examples.read(input.id).then(archive => ({ ok: true, value: { archive } }))
          : runtime.rpc(endpoint, input, signal)
      inFlight.add(operation)
      try { return await operation } finally { inFlight.delete(operation) }
    } catch (error) {
      return { ok: false, error: {
        code: typeof error?.code === 'string' ? error.code : error instanceof DirectorInputError ? 'video-director/invalid-input' : 'video-director/internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      } }
    }
  }

  return {
    rpc,
    providerSettings,
    get store() { return runtime.store },
    get workflows() { return runtime.workflows },
    get nodes() { return runtime.nodes },
    get jobs() { return runtime.jobs },
    get providers() { return runtime.providers },
    async close() {
      closing = true
      await movePromise?.catch(() => {})
      await runtime.codexModels.close()
      await Promise.allSettled([...inFlight])
    },
  }
}
