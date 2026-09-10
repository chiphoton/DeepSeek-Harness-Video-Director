import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Codex } from '@openai/codex-sdk'
import { CodexPlanImageRuntime } from '../src/codex-plan-provider.js'
import { modelFixture } from './fixtures/codex-models.js'

const STARTUP_FAILURE = 'WARN codex_state::runtime: failed to open state DB at /example/.codex/state_5.sqlite: attempt to write a readonly database\nError: failed to initialize in-process app-server client: Operation not permitted (os error 1)\n'

for (const operation of ['prompt-enhancer', 'image-generation']) {
  test(`${operation} explains a restricted Codex launch instead of exposing raw bootstrap logs`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-codex-launch-test-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const executable = join(root, 'codex-fixture')
    await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(STARTUP_FAILURE)}); process.exit(1);\n`, { mode: 0o755 })
    const runtime = new CodexPlanImageRuntime({
      codexModels: modelFixture(),
      store: {}, temporaryRoot: root,
      createCodex: () => new Codex({ codexPathOverride: executable }),
    })
    const provider = { id: 'codex-plan', label: 'Codex Plan', kind: 'codex-plan', model: 'gpt-5.6-sol' }
    const input = { operation, prompt: 'Test', assetIds: [] }
    const run = operation === 'image-generation' ? runtime.run.bind(runtime) : runtime.runText.bind(runtime)
    await assert.rejects(run(provider, input, new AbortController().signal), error => {
      assert.equal(error.code, 'video-director/codex-runtime-permission')
      assert.match(error.message, /restart deepseek harness.*terminal/iu)
      assert.doesNotMatch(error.message, /state_5\.sqlite|WARN codex_state/u)
      return true
    })
  })
}
