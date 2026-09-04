import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

let chatSourceClass

async function ProjectChatSource() {
  if (chatSourceClass !== undefined) return chatSourceClass
  const entry = fileURLToPath(new URL('../src/client/chat-source.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  chatSourceClass = (await import(`data:text/javascript;base64,${source}`)).ProjectChatSource
  return chatSourceClass
}

function observable(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(next) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

test('project chat shares the Session model directory and sends native image prompt parts', async () => {
  const ChatSource = await ProjectChatSource()
  const sessionId = 'session-video-director'
  const project = { id: 'project-video-director', sessionId }
  const directorListeners = new Set()
  const director = {
    getSnapshot: () => ({ project }),
    subscribe(listener) {
      directorListeners.add(listener)
      return () => directorListeners.delete(listener)
    },
    currentContext: () => '{"canvas":"context"}',
  }
  const sessionSnapshot = observable({ running: false })
  const events = observable({ entries: [] })
  let retirement
  let submissionInput
  let promptInput
  const binding = {
    session: {
      ...sessionSnapshot,
      beginSubmission(input) {
        submissionInput = input
        retirement = input.onRetire
        return {
          requestId: 'request-1',
          abandon: () => retirement?.({ reason: 'failed' }),
        }
      },
      async prompt(content, mode, _signal, requestId) {
        promptInput = { content, mode, requestId }
        retirement?.({ reason: 'observed', attachments: [] })
        return { ok: true, value: { accepted: true } }
      },
      async rename(title) { return { ok: true, value: { title, seq: 1 } } },
    },
    eventSource: events,
  }
  const models = observable({
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    }],
    failures: [],
    status: 'ready',
    error: null,
  })
  let selectedModel
  const directory = {
    store: models,
    async load() { return models.getSnapshot() },
    async select(selection) {
      selectedModel = selection
      models.publish({ ...models.getSnapshot(), current: selection })
    },
  }
  const sessionsList = observable({ current: sessionId, byId: { [sessionId]: { id: sessionId } } })
  const source = new ChatSource({
    sessions: {
      list: sessionsList,
      binding: id => id === sessionId ? binding : undefined,
      open() {},
      async create() { throw new Error('not expected') },
    },
    modelDirectories: { directoryFor: id => id === sessionId ? directory : undefined },
  }, director)

  assert.equal(source.getSnapshot().models.current.model, 'deepseek-v4-flash')
  await source.selectModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.deepEqual(selectedModel, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(source.getSnapshot().models.current.model, 'deepseek-v4-pro')

  const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'frame.png', { type: 'image/png' })
  await source.send('Describe this frame', [image])

  assert.equal(submissionInput.images.length, 1)
  assert.equal(submissionInput.images[0].name, 'frame.png')
  assert.match(submissionInput.images[0].previewUrl, /^blob:/)
  assert.equal(promptInput.mode, 'queue')
  assert.equal(promptInput.requestId, 'request-1')
  assert.deepEqual(promptInput.content[0], {
    type: 'image',
    mediaType: 'image/png',
    data: 'iVBORw==',
    name: 'frame.png',
  })
  assert.equal(promptInput.content[1].type, 'text')
  assert.match(promptInput.content[1].text, /^Describe this frame/)
  assert.match(promptInput.content[1].text, /<dsh-video-director-context version="1">/)

  source.dispose()
})
