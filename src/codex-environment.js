import { accessSync, constants, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PERMISSION_CODE = 'video-director/codex-runtime-permission'
const PERMISSION_MESSAGE = 'Codex Plan cannot access its local runtime state. Restart DeepSeek Harness from a normal terminal or through an approved launch outside the Codex task sandbox, then retry. Keep the same Video Director data directory to preserve your project.'

function permissionError() {
  return Object.assign(new Error(PERMISSION_MESSAGE), { code: PERMISSION_CODE })
}

// Check access only: never open the database, read credentials, or change permissions.
// A sandbox marker alone is insufficient; approved launches can inherit that marker.
export function codexRuntimeAccess() {
  const directory = process.env.CODEX_HOME || join(homedir(), '.codex')
  try {
    accessSync(directory, constants.R_OK | constants.W_OK)
    for (const name of readdirSync(directory)) {
      if (/^state_\d+\.sqlite(?:-wal|-shm)?$/u.test(name)) {
        accessSync(join(directory, name), constants.R_OK | constants.W_OK)
      }
    }
    return { ok: true, detail: 'Local Codex state is accessible; account and tool access are verified on use' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, code: 'video-director/codex-setup-required', detail: 'Codex state is missing. Run codex login in a normal terminal, then restart DeepSeek Harness.' }
    }
    return { ok: false, code: PERMISSION_CODE, detail: PERMISSION_MESSAGE }
  }
}

export function assertCodexRuntimeAccess() {
  const result = codexRuntimeAccess()
  if (!result.ok) throw Object.assign(new Error(result.detail), { code: result.code })
}

export function actionableCodexError(error) {
  if (error?.name === 'AbortError') return error
  const message = error instanceof Error ? error.message : String(error)
  if (error?.code === PERMISSION_CODE
    || /(?:codex_state|codex_rollout|state_\d+\.sqlite)[\s\S]*readonly database/iu.test(message)
    || /failed to initialize in-process app-server client:\s*(?:Operation not permitted|Permission denied)/iu.test(message)) {
    return permissionError()
  }
  if (/auth|login|sign[ -]?in|unauthorized|credential/iu.test(message)) {
    return new Error('Codex Plan could not authenticate. Sign in to Codex on this machine, then retry.')
  }
  return error instanceof Error ? error : new Error(message)
}
