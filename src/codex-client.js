import { Codex } from '@openai/codex-sdk'
import { assertCodexRuntimeAccess } from './codex-environment.js'
import { codexExecutable } from './codex-executable.js'

// Use the same installed CLI and sign-in checked by the environment adviser.
export function createLocalCodex({ serviceTier = 'default' } = {}) {
  assertCodexRuntimeAccess()
  return new Codex({
    codexPathOverride: codexExecutable(),
    // Explicit Standard overrides any personal Codex Fast default.
    config: { service_tier: serviceTier, features: { fast_mode: serviceTier !== 'default' } },
  })
}
