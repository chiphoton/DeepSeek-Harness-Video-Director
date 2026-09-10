import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Codex } from '@openai/codex-sdk'
import { CodexPlanImageRuntime } from '../src/codex-plan-provider.js'
import { modelFixture } from './fixtures/codex-models.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9k0AAAAASUVORK5CYII=', 'base64')

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-codex-image-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const threadId = options.threadId ?? randomUUID()
  const generatedImagesRoot = join(root, 'generated_images')
  const directory = join(generatedImagesRoot, options.savedThreadId ?? threadId)
  await mkdir(directory, { recursive: true })
  const imagePath = join(directory, `exec-${randomUUID()}.png`)
  await writeFile(imagePath, PNG)
  const events = [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    ...(options.error ? [{ type: 'error', message: options.error }] : []),
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ]
  const executable = join(root, 'codex-fixture')
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n'); });\n`, { mode: 0o755 })
  const saved = []
  const runtime = new CodexPlanImageRuntime({
      codexModels: modelFixture(),
    temporaryRoot: root, generatedImagesRoot,
    createCodex: () => new Codex({ codexPathOverride: executable }),
    store: { putAsset: async asset => { saved.push(asset); return { id: 'saved-image', ...asset } } },
  })
  const run = () => runtime.run({ id: 'codex-plan', label: 'Codex Plan', model: 'gpt-5.6-sol' }, {
    operation: 'image-generation', projectId: 'test-project', prompt: 'A cyclist on a bridge at dusk.',
  }, new AbortController().signal)
  return { run, saved, imagePath, directory }
}

test('Codex Plan imports the native image saved under the current SDK thread when no image payload reaches the stream', async t => {
  const { run, saved, imagePath } = await fixture(t)
  const result = await run()
  assert.equal(result.assets.length, 1)
  assert.equal(saved[0].dataBase64, PNG.toString('base64'))
  assert.deepEqual(await readFile(imagePath), PNG, 'Keep the native image in place')
})

test('Codex Plan never imports an image from a different thread or a traversal path', async t => {
  for (const threadId of [randomUUID(), '../outside-thread']) {
    const { run, saved } = await fixture(t, { threadId, savedThreadId: threadId.startsWith('../') ? threadId : randomUUID() })
    await assert.rejects(run(), /completed without returning an image/u)
    assert.equal(saved.length, 0)
  }
})

test('Codex Plan selects the newest nonempty image from its native thread folder', async t => {
  const { run, saved, imagePath, directory } = await fixture(t)
  const older = join(directory, 'zzzz-older.png')
  await writeFile(older, 'older bytes')
  await utimes(older, 1, 1)
  await writeFile(join(directory, 'zzzz-empty.png'), '')
  await run()
  assert.equal(saved[0].dataBase64, (await readFile(imagePath)).toString('base64'))
})

test('Codex Plan preserves an SDK error instead of masking it with a missing-image error or importing a partial result', async t => {
  const { run, saved } = await fixture(t, { error: 'Image generation request failed' })
  await assert.rejects(run(), /Image generation request failed/u)
  assert.equal(saved.length, 0)
})
