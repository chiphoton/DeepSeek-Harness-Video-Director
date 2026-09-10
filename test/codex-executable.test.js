import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { codexExecutable } from '../src/codex-executable.js'

test('npm cannot shadow the installed Codex CLI with the SDK dependency', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-cli-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundled = join(root, 'plugin', 'node_modules', '.bin')
  const installed = join(root, 'desktop')
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const directory of [bundled, installed]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), '', { mode: 0o755 })
  }
  const env = { PATH: [bundled, installed].join(delimiter) }
  assert.equal(codexExecutable(env), join(installed, name))
  assert.equal(codexExecutable({ ...env, DSH_VIDEO_DIRECTOR_CODEX_PATH: '/explicit/codex' }), '/explicit/codex')
  assert.equal(codexExecutable({ PATH: bundled }), join(bundled, name))
  assert.equal(codexExecutable({ PATH: join(root, 'missing') }), 'codex')
})
