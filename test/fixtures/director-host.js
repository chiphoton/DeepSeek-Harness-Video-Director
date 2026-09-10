import { createDirectorHost } from '../../src/director-host.js'
import { fetchTestModels } from './codex-models.js'

export async function testHost(dataDir, options = {}, settings = { providerOverrides: {} }) {
  const app = await createDirectorHost({
    dataDir, maxAssetBytes: 200 * 1024 * 1024, jobConcurrency: 2,
    providers: [
      { id: 'openai', label: 'OpenAI', kind: 'openai-compatible' },
      { id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan' },
    ],
  }, { fetchCodexModels: fetchTestModels, ...options })
  app.providerSettings.attach({ mutate: async (namespace, operations) => {
    if (namespace !== 'video-director') throw new Error('Unexpected settings namespace')
    for (const operation of operations) {
      const path = [...operation.path]
      const key = path.pop()
      let value = settings
      for (const segment of path) value = value[segment] ??= {}
      if (operation.op === 'unset') delete value[key]
      else value[key] = operation.value
    }
  } }, () => settings)
  return app
}
