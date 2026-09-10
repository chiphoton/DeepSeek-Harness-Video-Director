import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** npm prepends the SDK's pinned CLI to PATH. Prefer the user's installed CLI. */
export function codexExecutable(env = process.env) {
  if (env.DSH_VIDEO_DIRECTOR_CODEX_PATH) return env.DSH_VIDEO_DIRECTOR_CODEX_PATH
  const directories = [...new Set((env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean))]
  const npmBin = directory => /(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$/iu.test(directory)
  const ordered = [...directories.filter(directory => !npmBin(directory)), ...directories.filter(npmBin)]
  const names = process.platform === 'win32' ? ['codex.exe', 'codex'] : ['codex']
  for (const directory of ordered) {
    for (const name of names) {
      const candidate = resolve(join(directory, name))
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch { /* Continue to the next PATH entry. */ }
    }
  }
  return 'codex'
}
