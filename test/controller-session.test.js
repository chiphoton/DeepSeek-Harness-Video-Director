import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { build } from 'esbuild'

import { VdNodeRegistry } from '../src/node-registry.js'
import { ProjectStore } from '../src/project-store.js'
import { createDirectorRpc } from '../src/rpc.js'
import { record } from '../src/validation.js'
import { ComfyWorkflowStore } from '../src/workflow-store.js'

let controllerClass

async function DirectorController() {
  if (controllerClass !== undefined) return controllerClass
  const entry = fileURLToPath(new URL('../src/client/controller.ts', import.meta.url))
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  controllerClass = (await import(`data:text/javascript;base64,${source}`)).DirectorController
  return controllerClass
}

function projectFixture(sessionId) {
  return {
    schemaVersion: 1,
    revision: 1,
    id: '00000000-0000-4000-8000-000000000041',
    name: 'Recovered storyboard',
    sessionId,
    status: 'draft',
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    settings: {},
    jobs: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

test('loading a project adopts its missing Session identity before opening it', async () => {
  const Controller = await DirectorController()
  const sessionId = '00000000-0000-4000-8000-000000000042'
  const project = projectFixture(sessionId)
  const list = { current: undefined, ids: [], byId: {} }
  const bindings = new Map()
  const createCalls = []
  const openCalls = []
  const renameCalls = []
  const sessions = {
    list: {
      getSnapshot: () => list,
      subscribe: () => () => {},
    },
    async create(options = {}) {
      createCalls.push(options)
      const id = options.sessionId
      list.ids.push(id)
      list.byId[id] = { id }
      bindings.set(id, {
        session: {
          getSnapshot: () => ({ blank: true }),
          rename: async (title) => {
            renameCalls.push(title)
            return { ok: true, value: { title, seq: 1 } }
          },
        },
      })
      return id
    },
    binding: id => bindings.get(id),
    open(id) {
      if (list.byId[id] === undefined) throw new Error(`sessions.select: unknown session ${id}`)
      list.current = id
      openCalls.push(id)
    },
  }
  const ctx = {
    sessions,
    connection: {
      rpc: {
        async call(_channel, endpoint) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [project] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'projects/get') return { ok: true, value: { project } }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  }

  const controller = new Controller(ctx)
  await controller.start()

  assert.equal(controller.getSnapshot().project?.id, project.id)
  assert.deepEqual(createCalls, [{ sessionId }])
  assert.deepEqual(renameCalls, [project.name])
  assert.deepEqual(openCalls, [sessionId])
})

test('a failed Session adoption leaves the Video Project and canvas usable for chat recovery', async () => {
  const Controller = await DirectorController()
  const sessionId = '00000000-0000-4000-8000-000000000042'
  const project = projectFixture(sessionId)
  const failure = new Error('corrupt Zstandard session log: event sequence rewound')
  const openCalls = []
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ current: undefined, ids: [], byId: {} }),
        subscribe: () => () => {},
      },
      create: async () => { throw failure },
      binding: () => undefined,
      open: id => { openCalls.push(id) },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [project] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'projects/get') return { ok: true, value: { project } }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  }

  const controller = new Controller(ctx)
  await controller.start()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.project?.id, project.id)
  assert.equal(snapshot.phase, 'ready')
  assert.equal(snapshot.error, failure.message)
  assert.deepEqual(openCalls, [])
})

test('creating a project rejects a failed durable Session rename before persisting the project', async () => {
  const Controller = await DirectorController()
  const sessionId = '00000000-0000-4000-8000-000000000043'
  const projectCreateCalls = []
  const list = { current: undefined, ids: [], byId: {} }
  const binding = {
    session: {
      getSnapshot: () => ({ blank: true }),
      rename: async () => ({
        ok: false,
        error: {
          code: 'gateway/internal',
          message: 'session title was not persisted',
          details: { sessionId },
        },
      }),
    },
  }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => list,
        subscribe: () => () => {},
      },
      async create(options = {}) {
        assert.deepEqual(options, {})
        list.ids.push(sessionId)
        list.byId[sessionId] = { id: sessionId }
        return sessionId
      },
      binding: id => id === sessionId ? binding : undefined,
      open() {
        throw new Error('the failed Session must not be opened')
      },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/create') {
            projectCreateCalls.push(payload)
            return { ok: true, value: { project: projectFixture(sessionId) } }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  }

  const controller = new Controller(ctx)
  const failure = await controller.createProject('Unpersisted project').catch(error => error)

  assert.equal(failure.message, 'session title was not persisted')
  assert.equal(failure.code, 'gateway/internal')
  assert.deepEqual(failure.details, { sessionId })
  assert.deepEqual(projectCreateCalls, [])
  assert.equal(controller.getSnapshot().project, null)
  assert.equal(controller.getSnapshot().phase, 'error')
})

test('project export and Duplicate preserve canvas assets while resetting active runtime state', async () => {
  const Controller = await DirectorController()
  const sourceSessionId = '00000000-0000-4000-8000-000000000043'
  const copySessionId = '00000000-0000-4000-8000-000000000044'
  const copyProjectId = '00000000-0000-4000-8000-000000000045'
  const sourceAssetId = '00000000-0000-4000-8000-000000000046'
  const copyAssetId = '00000000-0000-4000-8000-000000000047'
  const importedSessionId = '00000000-0000-4000-8000-000000000048'
  const importedProjectId = '00000000-0000-4000-8000-000000000049'
  const importedAssetId = '00000000-0000-4000-8000-000000000050'
  const sourceAsset = {
    id: sourceAssetId,
    projectId: '00000000-0000-4000-8000-000000000041',
    kind: 'image',
    name: 'reference.png',
    mimeType: 'image/png',
    size: 11,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
    url: `/api/video-director/assets/${sourceAssetId}`,
  }
  const source = {
    ...projectFixture(sourceSessionId),
    name: 'Storyboard',
    graph: {
      nodes: [{
        id: 'load',
        type: 'director',
        position: { x: 20, y: 40 },
        data: { kind: 'load-image', title: 'Reference', status: 'running', jobId: 'old-job', asset: sourceAsset },
      }],
      edges: [],
      viewport: { x: 5, y: -10, zoom: 1.2 },
    },
    settings: { defaultTextProvider: 'ollama', custom: true },
    jobs: [{ id: 'old-job', nodeId: 'load', status: 'running' }],
  }
  const list = {
    current: sourceSessionId,
    ids: [sourceSessionId],
    byId: { [sourceSessionId]: { id: sourceSessionId } },
  }
  const bindings = new Map([[sourceSessionId, {
    session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) },
  }]])
  const savedProjects = []
  const createdSessions = [copySessionId, importedSessionId]
  const ctx = {
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      async create(options = {}) {
        assert.deepEqual(options, {})
        const sessionId = createdSessions.shift()
        assert.notEqual(sessionId, undefined)
        list.ids.push(sessionId)
        list.byId[sessionId] = { id: sessionId }
        bindings.set(sessionId, {
          session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) },
        })
        return sessionId
      },
      binding: id => bindings.get(id),
      open: id => { list.current = id },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [{ ...source, nodeCount: 1 }] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
          if (endpoint === 'projects/get') return { ok: true, value: { project: source } }
          if (endpoint === 'projects/create') {
            const projectId = payload.sessionId === copySessionId ? copyProjectId : importedProjectId
            return {
              ok: true,
              value: {
                project: {
                  ...projectFixture(payload.sessionId),
                  id: projectId,
                  name: payload.name,
                },
              },
            }
          }
          if (endpoint === 'assets/put') {
            assert.ok(payload.projectId === copyProjectId || payload.projectId === importedProjectId)
            assert.equal(payload.dataBase64, Buffer.from('asset-data').toString('base64'))
            const assetId = payload.projectId === copyProjectId ? copyAssetId : importedAssetId
            return {
              ok: true,
              value: {
                asset: {
                  ...sourceAsset,
                  id: assetId,
                  projectId: payload.projectId,
                  url: `/api/video-director/assets/${assetId}`,
                },
              },
            }
          }
          if (endpoint === 'projects/draft') {
            savedProjects.push(payload.draft)
            return { ok: true, value: {} }
          }
          if (endpoint === 'projects/save') {
            savedProjects.push(payload.project)
            return {
              ok: true,
              value: {
                project: {
                  ...payload.project,
                  revision: 2,
                  updatedAt: '2026-09-02T00:00:00.000Z',
                },
              },
            }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    assert.equal(String(url), sourceAsset.url)
    return new Response(Buffer.from('asset-data'), { status: 200, headers: { 'Content-Type': 'image/png' } })
  }
  try {
    const controller = new Controller(ctx)
    await controller.start()

    const exported = await controller.exportProject()
    const archive = JSON.parse(exported.text)
    assert.equal(exported.filename, 'Storyboard.video-director.json')
    assert.equal(archive.format, 'deepseek-harness-video-director-project')
    assert.equal(archive.assets[0].dataBase64, Buffer.from('asset-data').toString('base64'))
    assert.equal(archive.project.graph.nodes[0].data.status, 'idle')
    assert.equal(archive.project.graph.nodes[0].data.jobId, undefined)

    await controller.duplicateProject()
    const copy = controller.getSnapshot().project
    assert.equal(copy.id, copyProjectId)
    assert.equal(copy.name, 'Storyboard Copy')
    assert.equal(copy.sessionId, copySessionId)
    assert.deepEqual(copy.jobs, [])
    assert.equal(copy.graph.nodes[0].data.asset.id, copyAssetId)
    assert.equal(copy.graph.nodes[0].data.asset.projectId, copyProjectId)
    assert.equal(copy.graph.nodes[0].data.status, 'idle')
    assert.deepEqual(copy.settings, source.settings)
    assert.equal(savedProjects.length, 1)

    await controller.importProject(exported.text)
    const imported = controller.getSnapshot().project
    assert.equal(imported.id, importedProjectId)
    assert.equal(imported.name, 'Storyboard')
    assert.equal(imported.sessionId, importedSessionId)
    assert.deepEqual(imported.jobs, [])
    assert.equal(imported.graph.nodes[0].data.asset.id, importedAssetId)
    assert.equal(imported.graph.nodes[0].data.asset.projectId, importedProjectId)
    assert.equal(imported.graph.nodes[0].data.status, 'idle')
    assert.equal(savedProjects.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('new nodes retain Harness provider defaults and explicit project providers', async () => {
  const Controller = await DirectorController()
  for (const settings of [{}, { defaultTextProvider: 'codex-plan', defaultImageProvider: 'codex-plan' }]) {
    const project = projectFixture('00000000-0000-4000-8000-000000000043')
    project.settings = settings
    const controller = new Controller(existingSessionContext(project, async () => ({ ok: true, value: { nodeDefinitions: [] } })))
    await controller.start()
    const textId = controller.addWorkflowNode('prompt-enhancer')
    const imageId = controller.addWorkflowNode('image-generation')
    const nodes = controller.getSnapshot().project.graph.nodes
    assert.equal(nodes.find(node => node.id === textId).data.providerId, settings.defaultTextProvider ?? 'ollama')
    assert.equal(nodes.find(node => node.id === imageId).data.providerId, settings.defaultImageProvider ?? 'openai')
    controller.dispose()
  }
})

function existingSessionContext(project, handler, projectGet = async () => ({ ok: true, value: { project } })) {
  const submittedRuns = new Map()
  const drafts = new Map()
  const list = {
    current: project.sessionId,
    byId: { [project.sessionId]: { id: project.sessionId, title: project.name } },
  }
  const binding = {
    session: {
      getSnapshot: () => ({}),
      rename: async title => ({ ok: true, value: { title, seq: 1 } }),
    },
  }
  return {
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: async () => { throw new Error('existing Session must not be recreated') },
      binding: id => id === project.sessionId ? binding : undefined,
      open: id => { list.current = id },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [project] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'projects/get') {
            const response = await projectGet(payload)
            return response.ok && drafts.has(payload.projectId)
              ? { ok: true, value: { project: { ...response.value.project, draft: drafts.get(payload.projectId) } } } : response
          }
          if (endpoint === 'projects/draft') {
            if (payload.draft === null) drafts.delete(payload.projectId)
            else drafts.set(payload.projectId, structuredClone(payload.draft))
            return { ok: true, value: {} }
          }
          if (endpoint === 'projects/discard') {
            drafts.delete(payload.projectId)
            const response = await projectGet(payload)
            return { ok: true, value: { project: response.value.project, projects: [response.value.project] } }
          }
          if (endpoint === 'vd-runs/save') {
            const run = { ...payload.run, snapshot: submittedRuns.get(payload.run.id)?.snapshot ?? structuredClone(payload.snapshot) }
            submittedRuns.set(run.id, run)
            return { ok: true, value: { run } }
          }
          if (endpoint === 'vd-runs/get') return { ok: true, value: { run: submittedRuns.get(payload.runId) } }
          if (endpoint === 'vd-runs/list') return { ok: true, value: { runs: [...submittedRuns.values()] } }
          return handler(endpoint, payload)
        },
      },
    },
  }
}

test('Codex discovery refreshes metadata while an existing node keeps its unavailable model', async t => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000096')
  project.graph.nodes = [{ id: 'text', type: 'director', position: { x: 0, y: 0 }, data: {
    kind: 'prompt-enhancer', title: 'Saved model', providerId: 'codex-plan', modelId: 'retired-model', prompt: 'Test', status: 'idle',
  } }]
  let requestedModel
  let refreshes = 0
  const catalog = { model: 'future-model', models: ['future-model'], workflowModels: [],
    codexModels: [{ id: 'future-model', displayName: 'Future Model', defaultReasoningEffort: 'ultra', inputModalities: ['text', 'image'], isDefault: true }],
    codexCatalog: { source: 'live', fetchedAt: 1234, error: null },
  }
  const ctx = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'providers/models' || endpoint === 'providers/check') { refreshes++; return { ok: true, value: { ok: true, latencyMs: 1, ...catalog } } }
    if (endpoint === 'jobs/start') { requestedModel = payload.snapshot.request.model; return { ok: true, value: { job: { id: 'job-model', status: 'queued', phase: 'queued' } } } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const call = ctx.connection.rpc.call
  ctx.connection.rpc.call = (channel, endpoint, payload) => endpoint === 'providers/list'
    ? Promise.resolve({ ok: true, value: { providers: [{ id: 'codex-plan', kind: 'codex-plan', configured: true, availableModels: [] }] } })
    : call(channel, endpoint, payload)
  const controller = new Controller(ctx)
  t.after(() => controller.dispose())
  await controller.start()
  assert.equal(refreshes, 1, 'Codex models refresh at startup')
  assert.equal(controller.getSnapshot().providers[0].model, 'future-model')
  assert.equal(controller.getSnapshot().providers[0].codexModels[0].defaultReasoningEffort, 'ultra')
  await controller.checkProvider('codex-plan')
  assert.equal(refreshes, 2)
  await controller.runNode('text')
  assert.equal(requestedModel, 'retired-model', 'Backend must validate the saved model, never silently select the default')
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.modelId, 'retired-model')
})

test('project export omits generated Preview artifacts while preserving source assets', async () => {
  const Controller = await DirectorController()
  const sessionId = '00000000-0000-4000-8000-000000000051'
  const inputAsset = {
    id: '00000000-0000-4000-8000-000000000052', projectId: '00000000-0000-4000-8000-000000000041',
    kind: 'image', name: 'input.png', mimeType: 'image/png', size: 10, sha256: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z', url: '/assets/input.png',
  }
  const generatedAsset = {
    id: '00000000-0000-4000-8000-000000000053', projectId: '00000000-0000-4000-8000-000000000041',
    kind: 'image', name: 'generated.png', mimeType: 'image/png', size: 1_000_000, sha256: 'b'.repeat(64),
    createdAt: '2026-09-01T00:01:00.000Z', url: '/assets/generated.png',
  }
  const generatedResult = { kind: 'assets', assets: [generatedAsset] }
  const project = {
    ...projectFixture(sessionId),
    graph: {
      nodes: [
        { id: 'input', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'Input', asset: inputAsset, status: 'idle' } },
        { id: 'generate', type: 'director', position: { x: 300, y: 0 }, data: { kind: 'image-generation', title: 'Generate', asset: generatedAsset, assets: [generatedAsset], result: generatedResult, mediaKind: 'image', status: 'completed', phase: 'completed', progress: 1 } },
        { id: 'preview', type: 'director', position: { x: 600, y: 0 }, data: { kind: 'preview', title: 'Preview', asset: generatedAsset, assets: [generatedAsset], result: generatedResult, mediaKind: 'image', derivedFrom: 'generate', status: 'completed', phase: 'completed', progress: 1 } },
      ],
      edges: [{ id: 'generate-preview', source: 'generate', target: 'preview' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  const fetched = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    fetched.push(String(url))
    return new Response(Buffer.from('input-bytes'), { status: 200, headers: { 'Content-Type': 'image/png' } })
  }
  try {
    await controller.start()
    const archive = JSON.parse((await controller.exportProject()).text)

    assert.deepEqual(fetched, [inputAsset.url])
    assert.deepEqual(archive.assets.map(asset => asset.sourceId), [inputAsset.id])
    assert.equal(archive.project.graph.nodes[0].data.asset.id, inputAsset.id)
    for (const nodeId of ['generate', 'preview']) {
      const data = archive.project.graph.nodes.find(node => node.id === nodeId).data
      assert.equal(data.status, 'idle')
      for (const key of ['asset', 'assets', 'result', 'mediaKind', 'derivedFrom', 'phase', 'progress']) {
        assert.equal(key in data, false, `${nodeId} should omit ${key}`)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('import clears unavailable generated and Preview artifacts instead of rejecting the project', async () => {
  const Controller = await DirectorController()
  const sourceSessionId = '00000000-0000-4000-8000-000000000054'
  const importedSessionId = '00000000-0000-4000-8000-000000000055'
  const importedProjectId = '00000000-0000-4000-8000-000000000056'
  const missingAsset = {
    id: '00000000-0000-4000-8000-000000000057', projectId: '00000000-0000-4000-8000-000000000041',
    kind: 'image', name: 'missing.png', mimeType: 'image/png', size: 10, sha256: 'c'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z', url: '/assets/missing.png',
  }
  const missingResult = { kind: 'assets', assets: [missingAsset] }
  const archive = {
    format: 'deepseek-harness-video-director-project', version: 1, exportedAt: '2026-09-01T00:00:00.000Z',
    project: {
      name: 'Portable project', settings: {},
      graph: {
        nodes: [
          { id: 'generate', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'image-generation', title: 'Generate', asset: missingAsset, assets: [missingAsset], result: missingResult, mediaKind: 'image', status: 'completed' } },
          { id: 'preview', type: 'director', position: { x: 300, y: 0 }, data: { kind: 'preview', title: 'Preview', asset: missingAsset, assets: [missingAsset], result: missingResult, mediaKind: 'image', derivedFrom: 'generate', status: 'completed' } },
        ],
        edges: [{ id: 'generate-preview', source: 'generate', target: 'preview' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
    assets: [],
  }
  const source = projectFixture(sourceSessionId)
  const list = { current: sourceSessionId, byId: { [sourceSessionId]: { id: sourceSessionId, title: source.name } } }
  const bindings = new Map([[sourceSessionId, { session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) } }]])
  let savedGraph
  const ctx = {
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: async () => {
        list.byId[importedSessionId] = { id: importedSessionId }
        bindings.set(importedSessionId, { session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: {} }) } })
        return importedSessionId
      },
      binding: id => bindings.get(id),
      open: id => { list.current = id },
    },
    connection: { rpc: { async call(_channel, endpoint, payload) {
      if (endpoint === 'projects/list') return { ok: true, value: { projects: [source] } }
      if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
      if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
      if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
      if (endpoint === 'projects/get') return { ok: true, value: { project: source } }
      if (endpoint === 'projects/create') return { ok: true, value: { project: { ...projectFixture(payload.sessionId), id: importedProjectId, name: payload.name } } }
      if (endpoint === 'projects/draft') {
        savedGraph = payload.draft.graph
        return { ok: true, value: {} }
      }
      if (endpoint === 'projects/save') {
        savedGraph = payload.project.graph
        return { ok: true, value: { project: { ...payload.project, revision: 2 } } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    } } },
  }
  const controller = new Controller(ctx)
  await controller.start()

  await controller.importProject(JSON.stringify(archive))

  assert.equal(savedGraph.edges.length, 1)
  for (const node of savedGraph.nodes) {
    assert.equal(node.data.status, 'idle')
    assert.equal('asset' in node.data, false)
    assert.equal('assets' in node.data, false)
    assert.equal('result' in node.data, false)
  }
})

test('clearPreviews empties every Preview without allowing stale upstream results to refill it', async () => {
  const Controller = await DirectorController()
  const asset = {
    id: '00000000-0000-4000-8000-000000000058', projectId: '00000000-0000-4000-8000-000000000041',
    kind: 'image', name: 'result.png', mimeType: 'image/png', size: 10, sha256: 'd'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z', url: '/assets/result.png',
  }
  const result = { kind: 'assets', assets: [asset] }
  const project = {
    ...projectFixture('00000000-0000-4000-8000-000000000059'),
    graph: {
      nodes: [
        { id: 'source', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'image-generation', title: 'Source', asset, assets: [asset], result, mediaKind: 'image', status: 'completed' } },
        { id: 'image-preview', type: 'director', position: { x: 300, y: 0 }, data: { kind: 'preview', title: 'Image Preview', asset, assets: [asset], result, mediaKind: 'image', derivedFrom: 'source', status: 'completed' } },
        { id: 'text-preview', type: 'director', position: { x: 300, y: 200 }, data: { kind: 'preview', title: 'Text Preview', text: 'old output', mediaKind: 'text', derivedFrom: 'source', status: 'completed' } },
      ],
      edges: [
        { id: 'source-image', source: 'source', target: 'image-preview' },
        { id: 'source-text', source: 'source', target: 'text-preview' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.clearPreviews()
  controller.updateNode('source', { title: 'Renamed source' })

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.dirty, true)
  assert.deepEqual(snapshot.project.graph.edges, project.graph.edges)
  assert.equal(snapshot.project.graph.nodes.find(node => node.id === 'source').data.asset.id, asset.id)
  for (const node of snapshot.project.graph.nodes.filter(node => node.data.kind === 'preview')) {
    assert.equal(node.data.status, 'idle')
    for (const key of ['asset', 'assets', 'result', 'text', 'mediaKind', 'derivedFrom', 'phase', 'progress']) {
      assert.equal(key in node.data, false, `${node.id} should omit ${key}`)
    }
  }

  const nextAsset = { ...asset, id: '00000000-0000-4000-8000-000000000060', name: 'next-result.png' }
  controller.applyJobResult('source', { kind: 'assets', assets: [nextAsset] })
  const refreshedPreview = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'image-preview')
  assert.equal(refreshedPreview.data.asset.id, nextAsset.id)
  assert.equal(refreshedPreview.data.status, 'completed')
  assert.equal(refreshedPreview.data.previewCleared, undefined)
})

test('project edits stay local until the explicit save action', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000044')
  const saves = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
    saves.push(payload)
    return {
      ok: true,
      value: { project: { ...payload.project, revision: payload.expectedRevision + 1 } },
    }
  }))
  await controller.start()

  controller.renameProject('Manual cut')
  assert.equal(controller.getSnapshot().project.name, 'Manual cut')
  assert.equal(controller.getSnapshot().projects.find(row => row.id === project.id)?.name, 'Manual cut')
  await new Promise(resolve => setTimeout(resolve, 725))
  assert.equal(saves.length, 0)
  assert.equal(controller.getSnapshot().dirty, true)

  await controller.saveProject()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].project.name, 'Manual cut')
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().project.revision, 2)
})

test('starting a new chat Session persists the binding without changing unsaved canvas state', async () => {
  const Controller = await DirectorController()
  const oldSessionId = '00000000-0000-4000-8000-000000000045'
  const newSessionId = '00000000-0000-4000-8000-000000000046'
  const project = {
    ...projectFixture(oldSessionId),
    graph: { nodes: [], edges: [], viewport: { x: 91, y: -37, zoom: 1.4 } },
  }
  const list = {
    current: oldSessionId,
    byId: { [oldSessionId]: { id: oldSessionId, title: project.name } },
  }
  const renameCalls = []
  const openCalls = []
  const sessionCalls = []
  const bindings = new Map([[oldSessionId, {
    session: { getSnapshot: () => ({}), rename: async () => ({ ok: true, value: { title: project.name, seq: 1 } }) },
  }]])
  const ctx = {
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      async create() {
        list.byId[newSessionId] = { id: newSessionId }
        bindings.set(newSessionId, {
          session: {
            getSnapshot: () => ({}),
            rename: async title => {
              renameCalls.push(title)
              return { ok: true, value: { title, seq: 1 } }
            },
          },
        })
        return newSessionId
      },
      binding: id => bindings.get(id),
      open(id) {
        list.current = id
        openCalls.push(id)
      },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [project] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'projects/get') return { ok: true, value: { project } }
          if (endpoint === 'projects/session') {
            sessionCalls.push(payload)
            return { ok: true, value: { project: { ...project, sessionId: newSessionId, revision: 2 } } }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  }
  const controller = new Controller(ctx)
  await controller.start()
  controller.renameProject('Unsaved local title')
  const canvasBefore = structuredClone(controller.getSnapshot().project.graph)

  await controller.startNewChatSession()

  const snapshot = controller.getSnapshot()
  assert.deepEqual(sessionCalls, [{ projectId: project.id, sessionId: newSessionId }])
  assert.deepEqual(renameCalls, ['Unsaved local title'])
  assert.deepEqual(openCalls, [newSessionId])
  assert.equal(snapshot.project.sessionId, newSessionId)
  assert.equal(snapshot.project.name, 'Unsaved local title')
  assert.deepEqual(snapshot.project.graph, canvasBefore)
  assert.equal(snapshot.dirty, true)
})

test('provider model discovery starts automatically, clears stale choices on an empty success, and is last-request-wins', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000089')
  let releaseFirst
  const firstResult = new Promise(resolve => { releaseFirst = resolve })
  let discoveries = 0
  const provider = {
    id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'old:latest',
    requiresApiKey: false, apiKeySet: false, capabilities: ['text', 'vision'], configured: true,
    minimaxH3Unlocked: false, availableModels: ['stale:latest'],
  }
  const context = existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'providers/check') {
      return { ok: true, value: { ok: true, latencyMs: 4, models: ['checked:latest'], workflowModels: [] } }
    }
    if (endpoint === 'providers/models') {
      discoveries += 1
      if (discoveries === 1) return firstResult
      if (discoveries === 2) return { ok: true, value: { models: [], workflowModels: [] } }
      throw new Error('Ollama is offline')
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers: [provider] } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)

  await controller.start()
  assert.equal(discoveries, 1)
  assert.equal(controller.getSnapshot().providers[0].modelDiscovery.state, 'loading')
  assert.deepEqual(controller.getSnapshot().providerChecks, {})

  await controller.refreshProviderModels('ollama')
  assert.equal(discoveries, 2)
  assert.deepEqual(controller.getSnapshot().providers[0].availableModels, [])
  assert.equal(controller.getSnapshot().providers[0].modelDiscovery.state, 'ready')

  releaseFirst({ ok: true, value: { models: ['older:latest'], workflowModels: [] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(controller.getSnapshot().providers[0].availableModels, [])

  await controller.refreshProviderModels('ollama')
  assert.deepEqual(controller.getSnapshot().providers[0].availableModels, [])
  assert.equal(controller.getSnapshot().providers[0].modelDiscovery.state, 'error')
  assert.match(controller.getSnapshot().providers[0].modelDiscovery.message, /offline/i)
  assert.deepEqual(controller.getSnapshot().providerChecks, {})

  await controller.checkProvider('ollama')
  assert.equal(controller.getSnapshot().providerChecks.ollama.state, 'ok')
  assert.equal(discoveries, 3)
  assert.deepEqual(controller.getSnapshot().providers[0].availableModels, ['checked:latest'])
  assert.equal(controller.getSnapshot().providers[0].modelDiscovery.state, 'ready')
})

test('legacy Text Workflow nodes without a provider load with Ollama selected', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000097')
  project.graph.nodes = [{
    id: 'prompt', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'prompt-enhancer', title: 'Prompt Enhancer', prompt: '', status: 'idle' },
  }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))

  await controller.start()

  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.providerId, 'ollama')
  assert.equal(controller.getSnapshot().dirty, false)
})

test('unloading an Ollama model disables its loaded state without removing it from the model list', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000098')
  const provider = {
    id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    requiresApiKey: false, apiKeySet: false, capabilities: ['text'], configured: true, minimaxH3Unlocked: false,
  }
  const context = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'providers/models') {
      return { ok: true, value: { models: ['qwen3:latest'], loadedModels: ['qwen3:latest'], workflowModels: [] } }
    }
    if (endpoint === 'providers/unload-model') {
      assert.deepEqual(payload, { providerId: 'ollama', model: 'qwen3:latest' })
      return { ok: true, value: { model: 'qwen3:latest', loaded: false } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers: [provider] } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)

  await controller.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(controller.getSnapshot().providers[0].loadedModels, ['qwen3:latest'])

  await controller.unloadProviderModel('ollama', 'qwen3:latest')

  assert.deepEqual(controller.getSnapshot().providers[0].availableModels, ['qwen3:latest'])
  assert.deepEqual(controller.getSnapshot().providers[0].loadedModels, [])
  assert.equal(controller.getSnapshot().providers[0].modelDiscovery.state, 'ready')
})

test('VRAM trigger nodes require a connection and surface completion or failure on the node', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000099')
  const definition = {
    type: 'core.vram-trigger', version: '1.0.0', digest: 'builtin:core.vram-trigger@1.0.0',
    title: 'VRAM Trigger', description: '', category: 'utility', builtIn: true,
    behavior: 'trigger', execution: 'system.trigger', triggerAction: 'vram-trigger',
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }], fields: [], parameterInputs: [],
  }
  project.graph.nodes = [{
    id: 'eject', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'vram-trigger', title: definition.title, status: 'idle', nodeType: definition.type,
      nodeVersion: definition.version, nodeDigest: definition.digest, vramAction: 'ollama-eject',
      vramReleaseWaitSeconds: 10, vramActionInitialized: true,
    },
  }]
  const triggerCalls = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    if (endpoint === 'triggers/run') {
      triggerCalls.push(payload)
      return { ok: true, value: { action: payload.action } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await assert.rejects(controller.runNode('eject'), /at least one connected end/i)
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.status, 'failed')
  assert.equal(triggerCalls.length, 0)

  const connected = controller.getSnapshot().project.graph
  controller.updateGraph([
    ...connected.nodes,
    { id: 'upstream', type: 'director', position: { x: -300, y: 0 }, data: { kind: 'load-text', title: 'Upstream', text: 'ready' } },
  ], [{ id: 'upstream-eject', source: 'upstream', target: 'eject', sourceHandle: 'out', targetHandle: 'in' }], connected.viewport)
  await controller.runNode('eject')

  assert.deepEqual(triggerCalls, [{ action: 'ollama-eject', releaseWaitSeconds: 10 }])
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.status, 'completed')
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.phase, 'completed')

  const workflowRunId = await controller.runVdWorkflow({ mode: 'all' })
  const workflowRun = controller.getSnapshot().workflowRuns.find(run => run.id === workflowRunId)
  assert.equal(workflowRun.status, 'completed')
  assert.equal(workflowRun.completedJobs, 1)
  assert.deepEqual(triggerCalls, [
    { action: 'ollama-eject', releaseWaitSeconds: 10 },
    { action: 'ollama-eject', releaseWaitSeconds: 10 },
  ])
})

test('VRAM trigger auto-detects its first upstream provider without overriding later manual selection', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000098')
  const definition = {
    type: 'core.vram-trigger', version: '1.0.0', digest: 'builtin:core.vram-trigger@1.0.0',
    title: 'VRAM Trigger', description: '', category: 'utility', builtIn: true,
    behavior: 'trigger', execution: 'system.trigger', triggerAction: 'vram-trigger',
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }], fields: [], parameterInputs: [],
  }
  const providers = [
    { id: 'ollama', label: 'Ollama', kind: 'ollama', configured: false },
    { id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', configured: false },
    { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', configured: false },
  ]
  const context = existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)
  await controller.start()

  const upstream = providers.map((provider, index) => ({
    id: `source-${provider.id}`, type: 'director', position: { x: 0, y: index * 100 },
    data: { kind: 'prompt-enhancer', title: provider.label, providerId: provider.id },
  }))
  const triggers = providers.map((provider, index) => ({
    id: `trigger-${provider.id}`, type: 'director', position: { x: 300, y: index * 100 },
    data: {
      kind: 'vram-trigger', title: 'VRAM Trigger', nodeType: definition.type, nodeVersion: definition.version,
      nodeDigest: definition.digest, vramAction: 'skip', vramReleaseWaitSeconds: 10, vramActionInitialized: false,
    },
  }))
  const edges = providers.map(provider => ({
    id: `edge-${provider.id}`, source: `source-${provider.id}`, target: `trigger-${provider.id}`,
    sourceHandle: 'out', targetHandle: 'in:flow-in',
  }))
  controller.updateGraph([...upstream, ...triggers], edges, project.graph.viewport)

  const action = id => controller.getSnapshot().project.graph.nodes.find(node => node.id === id).data.vramAction
  assert.equal(action('trigger-ollama'), 'ollama-eject')
  assert.equal(action('trigger-comfyui'), 'comfyui-clear')
  assert.equal(action('trigger-openai'), 'skip')

  controller.updateNode('trigger-comfyui', { vramAction: 'ollama-eject', vramActionInitialized: true })
  const graph = controller.getSnapshot().project.graph
  controller.updateGraph(graph.nodes, graph.edges.map(edge => edge.target === 'trigger-comfyui'
    ? { ...edge, source: 'source-openai' }
    : edge), graph.viewport)
  assert.equal(action('trigger-comfyui'), 'ollama-eject')
})

test('an Image Workflow created from a VRAM trigger output persists its displayed default workflow at runtime', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000097')
  project.settings.defaultImageProvider = 'comfyui'
  const triggerDefinition = {
    type: 'core.vram-trigger', version: '1.0.0', digest: 'builtin:core.vram-trigger@1.0.0',
    title: 'VRAM Trigger', description: '', category: 'utility', builtIn: true,
    behavior: 'trigger', execution: 'system.trigger', triggerAction: 'vram-trigger',
    inputs: [{ id: 'flow-in', label: 'Flow', types: ['flow'], multiple: true }],
    outputs: [{ id: 'flow-out', label: 'Flow', types: ['flow'], multiple: true }], fields: [], parameterInputs: [],
  }
  const defaultWorkflow = {
    id: 'workflow-default-image', name: 'Default image workflow', description: '', kind: 'image-generation',
    builtIn: true, parameters: [], defaults: { prompt: '', seed: 1001 },
  }
  const comfyProvider = {
    id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    requiresApiKey: false, apiKeySet: false, capabilities: ['image'], configured: false, minimaxH3Unlocked: false,
  }
  project.graph.nodes = [{
    id: 'clear', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'vram-trigger', title: 'VRAM Trigger', nodeType: triggerDefinition.type,
      nodeVersion: triggerDefinition.version, nodeDigest: triggerDefinition.digest,
      vramAction: 'skip', vramReleaseWaitSeconds: 10, vramActionInitialized: true, status: 'idle',
    },
  }]
  const jobId = '00000000-0000-4000-8000-000000000096'
  const resultAsset = {
    id: '00000000-0000-4000-8000-000000000095', projectId: project.id, kind: 'image', name: 'result.png',
    mimeType: 'image/png', size: 1, sha256: 'a'.repeat(64), createdAt: project.createdAt, url: '/result.png',
  }
  let targetId
  const context = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [triggerDefinition] } }
    if (endpoint === 'triggers/run') return { ok: true, value: { action: payload.action } }
    if (endpoint === 'jobs/start') {
      if (payload.snapshot.request.workflowId === undefined) throw new Error('workflow must be an object')
      return {
        ok: true,
        value: {
          job: {
            id: jobId, projectId: project.id, nodeId: targetId, operation: 'image-generation', providerId: 'comfyui',
            clientRunId: payload.snapshot.request.clientRunId, status: 'queued', phase: 'queued', progress: 0,
            createdAt: project.createdAt, updatedAt: project.updatedAt,
          },
        },
      }
    }
    if (endpoint === 'jobs/get') {
      return {
        ok: true,
        value: {
          job: {
            id: jobId, projectId: project.id, nodeId: targetId, operation: 'image-generation', providerId: 'comfyui',
            status: 'completed', phase: 'completed', progress: 1,
            createdAt: project.createdAt, updatedAt: project.updatedAt,
            result: { kind: 'assets', assets: [resultAsset], providerId: 'comfyui' },
          },
        },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers: [comfyProvider] } }
    if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [defaultWorkflow] } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)
  await controller.start()

  targetId = controller.addWorkflowNode('image-generation', { x: 400, y: 0 }, {
    source: 'clear', sourceHandle: 'out:flow-out', targetHandle: 'in',
  })

  await controller.runVdWorkflow({ mode: 'dependencies', selectedNodeIds: [targetId] })

  const target = controller.getSnapshot().project.graph.nodes.find(node => node.id === targetId)
  assert.equal(target.data.workflowId, defaultWorkflow.id)
  controller.dispose()
})

test('an Image Workflow reference chain resolves a displayed default workflow through the Host RPC', async (t) => {
  const Controller = await DirectorController()
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-director-controller-rpc-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new ProjectStore(root, 1024 * 1024)
  const workflows = new ComfyWorkflowStore(root)
  await Promise.all([store.init(), workflows.init()])
  const nodes = new VdNodeRegistry(workflows)
  const createdProject = await store.createProject({
    name: 'Image reference chain',
    sessionId: '00000000-0000-4000-8000-000000000094',
  })
  const project = await store.updateProject(createdProject.id, {
    settings: { defaultImageProvider: 'comfyui' },
  })
  const sourceAsset = await store.putAsset({
    projectId: project.id,
    kind: 'image',
    name: 'source.png',
    mimeType: 'image/png',
    dataBase64: Buffer.from('source-image').toString('base64'),
  })
  const provider = {
    id: 'comfyui', label: 'ComfyUI', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    requiresApiKey: false, apiKeySet: false, capabilities: ['image'], configured: false, minimaxH3Unlocked: false,
  }
  const queuedRequests = []
  const jobs = {
    async start(request) {
      record(request.workflow, 'workflow')
      queuedRequests.push(request)
      return {
        id: '00000000-0000-4000-8000-000000000093',
        projectId: request.projectId,
        nodeId: request.nodeId,
        operation: request.operation,
        providerId: request.providerId,
        clientRunId: request.clientRunId,
        status: 'queued', phase: 'queued', progress: 0,
        createdAt: project.createdAt, updatedAt: project.updatedAt,
      }
    },
  }
  const hostRpc = createDirectorRpc({
    store,
    workflows,
    nodes,
    jobs,
    providers: {
      publicCatalog: () => [provider],
      check: async () => ({ ok: true, latencyMs: 1 }),
    },
    registerAsset: async () => {},
    providerSettings: { updateProvider: async () => {} },
  })
  const sessionList = {
    current: project.sessionId,
    byId: { [project.sessionId]: { id: project.sessionId, title: project.name } },
  }
  const controller = new Controller({
    sessions: {
      list: { getSnapshot: () => sessionList, subscribe: () => () => {} },
      create: async () => { throw new Error('existing Session must not be recreated') },
      binding: id => id === project.sessionId ? {
        session: { getSnapshot: () => ({}), rename: async title => ({ ok: true, value: { title, seq: 1 } }) },
      } : undefined,
      open: id => { sessionList.current = id },
    },
    connection: { rpc: { call: async (_channel, endpoint, payload) => hostRpc(endpoint, payload) } },
  })
  t.after(() => controller.dispose())
  await controller.start()

  const sourceId = controller.addWorkflowNode('image-generation', { x: 0, y: 0 })
  controller.updateNode(sourceId, {
    workflowId: 'builtin-z-image-turbo',
    asset: sourceAsset,
    assets: [sourceAsset],
    mediaKind: 'image',
    result: { kind: 'assets', assets: [sourceAsset], providerId: 'comfyui' },
    status: 'completed',
  })
  const targetId = controller.addWorkflowNode('image-generation', { x: 400, y: 0 })
  controller.updateNode(targetId, { workflowId: undefined, workflowValues: undefined })
  controller.connect({
    id: 'source-target', source: sourceId, sourceHandle: 'out', target: targetId, targetHandle: 'in:reference',
  })
  assert.equal(
    controller.getSnapshot().project.graph.nodes.find(node => node.id === targetId).data.workflowId,
    undefined,
  )

  await controller.runNode(targetId)

  assert.equal(queuedRequests.length, 1)
  assert.equal(queuedRequests[0].workflowId, 'builtin-qwen-image-edit-consistent')
  assert.equal(queuedRequests[0].bindings[0].assetId, sourceAsset.id)
})

test('workflow imports and Custom Node installs refresh every configured Comfy model mapping', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000090')
  const providers = [
    {
      id: 'comfy-rest', label: 'Comfy REST', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      requiresApiKey: false, apiKeySet: false, capabilities: ['image'], configured: true, minimaxH3Unlocked: false,
    },
    {
      id: 'comfy-mcp', label: 'Comfy MCP', kind: 'comfyui-mcp', mcpTool: 'comfy.run',
      requiresApiKey: false, apiKeySet: false, capabilities: ['image'], configured: true, minimaxH3Unlocked: false,
    },
    {
      id: 'comfy-disabled', label: 'Comfy disabled', kind: 'comfyui', baseUrl: '',
      requiresApiKey: false, apiKeySet: false, capabilities: ['image'], configured: false, minimaxH3Unlocked: false,
    },
    {
      id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434',
      requiresApiKey: false, apiKeySet: false, capabilities: ['text'], configured: true, minimaxH3Unlocked: false,
    },
  ]
  const modelCalls = []
  const workflow = {
    id: 'imported-workflow', name: 'Imported workflow', description: '', kind: 'image-generation', builtIn: false,
    parameters: [], defaults: {},
  }
  const definition = {
    protocol: 'video-director.node/v1', type: 'example.imported', version: '1.0.0', title: 'Imported',
    category: 'image', behavior: 'workflow', inputs: [], outputs: [], fields: [],
  }
  const context = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'providers/models') {
      modelCalls.push(payload.providerId)
      return { ok: true, value: { models: [], workflowModels: [] } }
    }
    if (endpoint === 'workflows/import') {
      return { ok: true, value: { workflow, nodeDefinitions: [] } }
    }
    if (endpoint === 'nodes/install') {
      return { ok: true, value: { definition, workflows: [workflow], nodeDefinitions: [definition] } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)

  await controller.start()
  await new Promise(resolve => setImmediate(resolve))
  modelCalls.length = 0

  await controller.importWorkflow({ name: workflow.name, kind: workflow.kind, document: {} })
  assert.deepEqual(modelCalls.sort(), ['comfy-mcp', 'comfy-rest'])

  modelCalls.length = 0
  await controller.installNode({ protocol: 'video-director.node-pack/v1' })
  assert.deepEqual(modelCalls.sort(), ['comfy-mcp', 'comfy-rest'])
})

test('an edit made while an explicit save is in flight remains dirty and visible', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000045')
  let releaseSave
  const saveRelease = new Promise(resolve => { releaseSave = resolve })
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
    await saveRelease
    return {
      ok: true,
      value: { project: { ...payload.project, revision: payload.expectedRevision + 1 } },
    }
  }))
  await controller.start()

  controller.renameProject('First draft')
  const saving = controller.saveProject()
  controller.renameProject('Second draft')
  releaseSave()
  await saving

  assert.equal(controller.getSnapshot().project.name, 'Second draft')
  assert.equal(controller.getSnapshot().project.revision, 2)
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().saving, false)
})

test('a revision conflict immediately force-saves the current local project', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000046')
  const saves = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
    saves.push(payload)
    if (payload.force !== true) {
      return {
        ok: false,
        error: { code: 'video-director/revision-conflict', message: 'stale revision', details: {} },
      }
    }
    return {
      ok: true,
      value: {
        project: {
          ...payload.project,
          revision: 3,
          updatedAt: '2026-09-01T00:00:03.000Z',
        },
      },
    }
  }))
  await controller.start()
  controller.renameProject('Local conflict edit')

  await controller.saveProject()

  assert.equal(saves.length, 2)
  assert.equal(saves[0].force, undefined)
  assert.equal(saves[1].force, true)
  assert.equal(saves[1].project.name, 'Local conflict edit')
  assert.equal(controller.getSnapshot().saving, false)
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().conflict, false)
  assert.equal(controller.getSnapshot().error, null)
  assert.equal(controller.getSnapshot().project.name, 'Local conflict edit')
  assert.equal(controller.getSnapshot().project.revision, 3)
})

test('a legacy Host that ignores force still saves the current local project after a revision conflict', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000048')
  const remoteJob = { id: 'remote-job', status: 'running' }
  const latest = {
    ...project,
    revision: 4,
    name: 'Remote edit',
    status: 'running',
    jobs: [remoteJob],
    settings: { remote: true },
  }
  const saves = []
  let getCalls = 0
  const controller = new Controller(existingSessionContext(
    project,
    async (endpoint, payload) => {
      if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
      saves.push(payload)
      if (payload.expectedRevision !== latest.revision) {
        return {
          ok: false,
          error: { code: 'video-director/revision-conflict', message: 'stale revision', details: {} },
        }
      }
      return {
        ok: true,
        value: {
          project: {
            ...payload.project,
            revision: latest.revision + 1,
            updatedAt: '2026-09-01T00:00:05.000Z',
          },
        },
      }
    },
    async () => {
      getCalls += 1
      return { ok: true, value: { project: getCalls === 1 ? project : latest } }
    },
  ))
  await controller.start()
  controller.renameProject('Current local edit')

  await controller.saveProject()

  assert.equal(saves.length, 3)
  assert.deepEqual(saves.map(save => [save.expectedRevision, save.force]), [
    [1, undefined],
    [1, true],
    [4, true],
  ])
  assert.equal(saves[2].project.name, 'Current local edit')
  assert.deepEqual(saves[2].project.settings, {})
  assert.deepEqual(saves[2].project.jobs, [remoteJob])
  assert.equal(controller.getSnapshot().project.revision, 5)
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().conflict, false)
  assert.equal(controller.getSnapshot().error, null)
})

test('a failed forced save clears saving and keeps local edits retryable', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000047')
  const saves = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
    saves.push(payload)
    if (payload.force !== true) {
      return {
        ok: false, error: { code: 'video-director/revision-conflict', message: 'stale revision', details: {} },
      }
    }
    return {
      ok: false, error: { code: 'gateway/unavailable', message: 'forced save failed', details: {} },
    }
  }))
  await controller.start()
  controller.renameProject('Local retry edit')

  await assert.rejects(controller.saveProject(), /forced save failed/)
  assert.equal(saves.length, 2)
  assert.equal(saves[1].force, true)
  assert.equal(controller.getSnapshot().saving, false)
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().conflict, false)
  assert.equal(controller.getSnapshot().error, 'forced save failed')
})

test('completed media flows through explicit Preview and Save sinks without legacy output nodes', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000051')
  project.graph.nodes = [
    {
      id: 'generate', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'image-generation', title: 'Generate', providerId: 'comfyui', status: 'running' },
    },
    {
      id: 'preview', type: 'director', position: { x: 400, y: 0 },
      data: { kind: 'preview', title: 'Preview', nodeType: 'core.preview', nodeVersion: '1.0.0', status: 'idle' },
    },
    {
      id: 'save', type: 'director', position: { x: 800, y: 0 },
      data: { kind: 'save', title: 'Save Output', nodeType: 'core.save', nodeVersion: '1.0.0', status: 'idle' },
    },
  ]
  project.graph.edges = [
    { id: 'edge-preview', source: 'generate', target: 'preview' },
    { id: 'edge-save', source: 'preview', target: 'save' },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const asset = {
    id: 'asset-output', projectId: project.id, kind: 'image', name: 'shot.png', mimeType: 'image/png',
    size: 12, sha256: 'a'.repeat(64), createdAt: '2026-09-01T00:00:00.000Z', url: '/asset-output',
  }

  controller.applyJobResult('generate', { kind: 'assets', assets: [asset], providerId: 'comfyui' })

  const nodes = controller.getSnapshot().project.graph.nodes
  assert.equal(nodes.find(node => node.id === 'preview').data.asset.id, asset.id)
  assert.equal(nodes.find(node => node.id === 'save').data.asset.id, asset.id)
  assert.equal(nodes.some(node => node.data.kind.startsWith('output-')), false)
})

test('loading a project restores a persisted completed result into its source and connected sinks without saving', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000056')
  const asset = {
    id: 'asset-restored', projectId: project.id, kind: 'video', name: 'restored.mp4', mimeType: 'video/mp4',
    size: 128, sha256: 'c'.repeat(64), createdAt: project.createdAt, url: '/asset-restored',
  }
  const result = { kind: 'assets', assets: [asset], providerId: 'comfyui', seed: 42 }
  project.graph.nodes = [
    {
      id: 'generate', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'video-generation', title: 'Generate', providerId: 'comfyui', seed: 9001, status: 'running' },
    },
    {
      id: 'preview', type: 'director', position: { x: 400, y: 0 },
      data: { kind: 'preview', title: 'Preview', status: 'idle' },
    },
    {
      id: 'save', type: 'director', position: { x: 800, y: 0 },
      data: { kind: 'save', title: 'Save', status: 'idle' },
    },
  ]
  project.graph.edges = [
    { id: 'edge-preview', source: 'generate', target: 'preview' },
    { id: 'edge-save', source: 'preview', target: 'save' },
  ]
  project.jobs = [{
    id: 'job-restored', projectId: project.id, nodeId: 'generate', operation: 'video-generation',
    providerId: 'comfyui', status: 'completed', phase: 'completed', progress: 1,
    result, createdAt: project.createdAt, updatedAt: project.updatedAt, completedAt: project.updatedAt,
  }]
  let saveCalls = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'projects/save') {
      saveCalls += 1
      throw new Error('loading a completed job must not save the project')
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))

  await controller.start()
  await new Promise(resolve => setTimeout(resolve, 250))

  const snapshot = controller.getSnapshot()
  const nodes = snapshot.project.graph.nodes
  for (const nodeId of ['generate', 'preview', 'save']) {
    const data = nodes.find(node => node.id === nodeId).data
    assert.equal(data.status, 'completed')
    assert.equal(data.asset.id, asset.id)
    assert.deepEqual(data.assets, [asset])
    assert.deepEqual(data.result, result)
  }
  assert.equal(nodes.find(node => node.id === 'generate').data.seed, 9001)
  assert.equal(nodes.find(node => node.id === 'generate').data.outputSeed, 42)
  assert.equal(snapshot.dirty, false)
  assert.equal(saveCalls, 0)
})

test('loading ignores an older completed result when the same node has a newer active job', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000058')
  const staleAsset = {
    id: 'asset-stale-run', projectId: project.id, kind: 'video', name: 'old.mp4', mimeType: 'video/mp4',
    size: 8, sha256: 'e'.repeat(64), createdAt: project.createdAt, url: '/asset-stale-run',
  }
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'video-generation', title: 'Generate', providerId: 'comfyui', status: 'running' },
  }]
  project.jobs = [
    {
      id: 'job-old', projectId: project.id, nodeId: 'generate', operation: 'video-generation', providerId: 'comfyui',
      status: 'completed', phase: 'completed', progress: 1,
      result: { kind: 'assets', assets: [staleAsset], providerId: 'comfyui' },
      createdAt: project.createdAt, updatedAt: project.updatedAt, completedAt: project.updatedAt,
    },
    {
      id: 'job-new', projectId: project.id, nodeId: 'generate', operation: 'video-generation', providerId: 'comfyui',
      status: 'running', phase: 'sampling', progress: 0.5,
      createdAt: project.createdAt, updatedAt: project.updatedAt,
    },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/get') return new Promise(() => {})
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))

  await controller.start()

  const source = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(source.status, 'running')
  assert.equal(source.result, undefined)
  assert.equal(source.asset, undefined)
  controller.dispose()
})

test('active job polling reconnects after a temporary transport failure without resubmitting', { timeout: 3_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000068')
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'video-generation', title: 'Generate', providerId: 'comfyui', status: 'running' },
  }]
  project.jobs = [{
    id: 'job-reconnect', projectId: project.id, nodeId: 'generate', operation: 'video-generation', providerId: 'comfyui',
    status: 'running', phase: 'sampling', progress: 0.4, createdAt: project.createdAt, updatedAt: project.updatedAt,
  }]
  let pollCalls = 0
  let startCalls = 0
  let markFirstPoll
  const firstPoll = new Promise(resolve => { markFirstPoll = resolve })
  const result = { kind: 'text', text: 'reconnected result', providerId: 'comfyui' }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      startCalls += 1
      throw new Error('an existing job must never be resubmitted during reconnect')
    }
    if (endpoint === 'jobs/get') {
      pollCalls += 1
      if (pollCalls === 1) {
        markFirstPoll()
        throw new Error('connection lost')
      }
      return {
        ok: true,
        value: {
          job: {
            ...project.jobs[0], status: 'completed', phase: 'completed', progress: 1, result,
          },
        },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))

  await controller.start()
  await firstPoll
  await new Promise(resolve => setTimeout(resolve, 5))

  let node = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(node.status, 'running')
  assert.equal(node.phase, 'reconnecting')
  for (let attempt = 0; attempt < 300; attempt += 1) {
    node = controller.getSnapshot().project.graph.nodes[0].data
    if (node.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  assert.equal(node.status, 'completed')
  assert.equal(node.text, 'reconnected result')
  assert.equal(pollCalls, 2)
  assert.equal(startCalls, 0)
  controller.dispose()
})

test('late Preview and Save connections replay saved asset, text, and MCP results without auto-saving', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000057')
  const asset = {
    id: 'asset-late', projectId: project.id, kind: 'image', name: 'late.png', mimeType: 'image/png',
    size: 64, sha256: 'd'.repeat(64), createdAt: project.createdAt, url: '/asset-late',
  }
  const cases = [
    { id: 'assets', result: { kind: 'assets', assets: [asset], providerId: 'comfyui' }, expectedText: undefined },
    { id: 'text', result: { kind: 'text', text: 'Expanded camera prompt', providerId: 'ollama' }, expectedText: 'Expanded camera prompt' },
    { id: 'mcp', result: { kind: 'mcp-result', result: { promptId: 'remote-42', frames: 81 }, providerId: 'comfyui' }, expectedText: '{\n  "promptId": "remote-42",\n  "frames": 81\n}' },
  ]
  project.graph.nodes = cases.flatMap((entry, index) => [
    {
      id: `source-${entry.id}`, type: 'director', position: { x: 0, y: index * 240 },
      data: { kind: 'video-generation', title: `Source ${entry.id}`, status: 'completed', result: entry.result },
    },
    {
      id: `preview-${entry.id}`, type: 'director', position: { x: 400, y: index * 240 },
      data: { kind: 'preview', title: `Preview ${entry.id}`, status: 'idle' },
    },
    {
      id: `save-${entry.id}`, type: 'director', position: { x: 800, y: index * 240 },
      data: { kind: 'save', title: `Save ${entry.id}`, status: 'idle' },
    },
  ])
  let saveCalls = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'projects/save') {
      saveCalls += 1
      throw new Error('late canvas connections must stay local until Save is clicked')
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  for (const entry of cases) {
    controller.connect({ id: `edge-preview-${entry.id}`, source: `source-${entry.id}`, target: `preview-${entry.id}` })
    controller.connect({ id: `edge-save-${entry.id}`, source: `preview-${entry.id}`, target: `save-${entry.id}` })
  }
  await new Promise(resolve => setTimeout(resolve, 250))

  const snapshot = controller.getSnapshot()
  for (const entry of cases) {
    for (const prefix of ['preview', 'save']) {
      const data = snapshot.project.graph.nodes.find(node => node.id === `${prefix}-${entry.id}`).data
      assert.equal(data.status, 'completed')
      assert.deepEqual(data.result, entry.result)
      assert.equal(data.text, entry.expectedText)
      if (entry.id === 'assets') {
        assert.equal(data.asset.id, asset.id)
        assert.deepEqual(data.assets, [asset])
      }
    }
  }
  assert.equal(snapshot.dirty, true)
  assert.equal(saveCalls, 0)
})

test('a sink connected after job polling completes receives the output saved on the source node', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000059')
  const asset = {
    id: 'asset-live-late', projectId: project.id, kind: 'video', name: 'live.mp4', mimeType: 'video/mp4',
    size: 256, sha256: 'f'.repeat(64), createdAt: project.createdAt, url: '/asset-live-late',
  }
  project.graph.nodes = [
    {
      id: 'generate', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'video-generation', title: 'Generate', providerId: 'comfyui', status: 'running' },
    },
    {
      id: 'late-save', type: 'director', position: { x: 800, y: 0 },
      data: { kind: 'save', title: 'Late Save', status: 'idle' },
    },
  ]
  project.jobs = [{
    id: 'job-live', projectId: project.id, nodeId: 'generate', operation: 'video-generation', providerId: 'comfyui',
    status: 'running', phase: 'sampling', progress: 0.75, createdAt: project.createdAt, updatedAt: project.updatedAt,
  }]
  const result = { kind: 'assets', assets: [asset], providerId: 'comfyui' }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/get') {
      return {
        ok: true,
        value: { job: { ...project.jobs[0], status: 'completed', phase: 'completed', progress: 1, result } },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const source = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data
  assert.equal(source.status, 'completed')
  assert.equal(source.asset.id, asset.id)
  controller.connect({ id: 'edge-live-late', source: 'generate', target: 'late-save' })

  const sink = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'late-save').data
  assert.equal(sink.status, 'completed')
  assert.equal(sink.asset.id, asset.id)
  assert.deepEqual(sink.result, result)
  controller.dispose()
})

test('a completed poll response from a previous project cannot mutate the newly selected project', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const projectA = projectFixture('00000000-0000-4000-8000-000000000060')
  const projectB = {
    ...projectFixture('00000000-0000-4000-8000-000000000061'),
    id: '00000000-0000-4000-8000-000000000062',
    name: 'Clean project B',
  }
  projectA.graph.nodes = [{
    id: 'generate-a', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'video-generation', title: 'Generate A', providerId: 'comfyui', status: 'running' },
  }]
  projectA.jobs = [{
    id: 'job-a', projectId: projectA.id, nodeId: 'generate-a', operation: 'video-generation', providerId: 'comfyui',
    status: 'running', phase: 'sampling', progress: 0.5, createdAt: projectA.createdAt, updatedAt: projectA.updatedAt,
  }]
  const staleAsset = {
    id: 'asset-project-a', projectId: projectA.id, kind: 'video', name: 'a.mp4', mimeType: 'video/mp4',
    size: 32, sha256: '1'.repeat(64), createdAt: projectA.createdAt, url: '/asset-project-a',
  }
  let markJobRequested
  const jobRequested = new Promise(resolve => { markJobRequested = resolve })
  let releaseJob
  const jobRelease = new Promise(resolve => { releaseJob = resolve })
  const list = {
    current: projectA.sessionId,
    byId: {
      [projectA.sessionId]: { id: projectA.sessionId, title: projectA.name },
      [projectB.sessionId]: { id: projectB.sessionId, title: projectB.name },
    },
  }
  const bindings = new Map([projectA, projectB].map(project => [project.sessionId, {
    session: {
      getSnapshot: () => ({}),
      rename: async title => ({ ok: true, value: { title, seq: 1 } }),
    },
  }]))
  const controller = new Controller({
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: async () => { throw new Error('sessions already exist') },
      binding: id => bindings.get(id),
      open: id => { list.current = id },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [projectA, projectB] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
          if (endpoint === 'projects/get' && payload.projectId === projectA.id) return { ok: true, value: { project: projectA } }
          if (endpoint === 'projects/get' && payload.projectId === projectB.id) return { ok: true, value: { project: projectB } }
          if (endpoint === 'jobs/get') {
            markJobRequested()
            await jobRelease
            return {
              ok: true,
              value: {
                job: {
                  ...projectA.jobs[0], status: 'completed', phase: 'completed', progress: 1,
                  result: { kind: 'assets', assets: [staleAsset], providerId: 'comfyui' },
                },
              },
            }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  })
  await controller.start()
  await jobRequested
  await controller.selectProject(projectB.id)
  releaseJob()
  await new Promise(resolve => setTimeout(resolve, 25))

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.project.id, projectB.id)
  assert.equal(snapshot.project.graph.nodes.length, 0)
  assert.equal(snapshot.dirty, false)
  controller.dispose()
})

test('a project transition rejects overlapping saves, selections, and canvas edits', async () => {
  const Controller = await DirectorController()
  const projectA = projectFixture('00000000-0000-4000-8000-000000000048')
  const projectB = {
    ...projectFixture('00000000-0000-4000-8000-000000000049'),
    id: '00000000-0000-4000-8000-000000000050',
    name: 'Project B',
  }
  let releaseB
  const bReady = new Promise(resolve => { releaseB = resolve })
  const list = {
    current: projectA.sessionId,
    byId: {
      [projectA.sessionId]: { id: projectA.sessionId },
      [projectB.sessionId]: { id: projectB.sessionId },
    },
  }
  const bindings = new Map([projectA, projectB].map(project => [project.sessionId, {
    session: {
      getSnapshot: () => ({}),
      rename: async title => ({ ok: true, value: { title, seq: 1 } }),
    },
  }]))
  const controller = new Controller({
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: async () => { throw new Error('sessions already exist') },
      binding: id => bindings.get(id),
      open: id => { list.current = id },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [projectA, projectB] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'projects/get' && payload.projectId === projectA.id) return { ok: true, value: { project: projectA } }
          if (endpoint === 'projects/get' && payload.projectId === projectB.id) {
            await bReady
            return { ok: true, value: { project: projectB } }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  })
  await controller.start()

  const switching = controller.selectProject(projectB.id)
  assert.equal(controller.getSnapshot().phase, 'loading')
  await assert.rejects(controller.saveProject(), /transition/i)
  await assert.rejects(controller.selectProject(projectB.id), /transition/i)
  controller.renameProject('Must not leak into B')
  assert.equal(controller.getSnapshot().project.name, projectA.name)

  releaseB()
  await switching
  assert.equal(controller.getSnapshot().project.id, projectB.id)
  assert.equal(controller.getSnapshot().project.name, projectB.name)
  assert.equal(list.current, projectB.sessionId)
})

test('concurrent asset uploads append to the latest graph instead of overwriting each other', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000051')
  const releases = new Map()
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'assets/put') throw new Error(`unexpected endpoint ${endpoint}`)
    await new Promise(resolve => { releases.set(payload.name, resolve) })
    return {
      ok: true,
      value: {
        asset: {
          id: payload.name === 'a.png' ? '00000000-0000-4000-8000-000000000052' : '00000000-0000-4000-8000-000000000053',
          projectId: project.id,
          kind: 'image',
          name: payload.name,
          mimeType: 'image/png',
          size: 1,
          sha256: 'a'.repeat(64),
          createdAt: '2026-09-01T00:00:00.000Z',
          url: `/asset/${payload.name}`,
        },
      },
    }
  }))
  await controller.start()
  const file = name => ({ name, type: 'image/png', arrayBuffer: async () => Uint8Array.of(1).buffer })
  const first = controller.addFile(file('a.png'))
  const second = controller.addFile(file('b.png'))
  while (releases.size < 2) await Promise.resolve()
  releases.get('b.png')()
  await second
  releases.get('a.png')()
  await first

  assert.deepEqual(
    controller.getSnapshot().project.graph.nodes.map(node => node.data.asset.name).sort(),
    ['a.png', 'b.png'],
  )
})

test('a Sketch node retains its editable document beside the flattened PNG asset', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000150')
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'assets/put') throw new Error(`unexpected endpoint ${endpoint}`)
    return {
      ok: true,
      value: {
        asset: {
          id: '00000000-0000-4000-8000-000000000151', projectId: project.id, kind: 'sketch', name: payload.name,
          mimeType: 'image/png', size: 1, sha256: 'c'.repeat(64), createdAt: project.createdAt, url: '/asset/sketch.png',
        },
      },
    }
  }))
  await controller.start()
  const sketchDocument = {
    version: 1,
    width: 640,
    height: 480,
    background: '#ffffff',
    elements: [{
      id: 'line', type: 'line', color: '#111111', width: 8,
      start: { x: 20, y: 30 }, end: { x: 200, y: 220 },
    }],
  }

  await controller.addFile(
    { name: 'sketch.png', type: 'image/png', arrayBuffer: async () => Uint8Array.of(1).buffer },
    'sketch',
    { x: 40, y: 50 },
    sketchDocument,
  )
  sketchDocument.elements[0].end.x = 999

  const node = controller.getSnapshot().project.graph.nodes[0]
  assert.equal(node.data.kind, 'load-sketch')
  assert.equal(node.data.asset.kind, 'sketch')
  assert.equal(node.data.sketchDocument.width, 640)
  assert.equal(node.data.sketchDocument.elements[0].end.x, 200)
})

test('an upload completing after a project reload never mutates the reloaded graph', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000054')
  let releaseUpload
  const uploadReady = new Promise(resolve => { releaseUpload = resolve })
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'assets/put') throw new Error(`unexpected endpoint ${endpoint}`)
    await uploadReady
    return {
      ok: true,
      value: { asset: { id: '00000000-0000-4000-8000-000000000055', projectId: project.id, kind: 'image', name: payload.name, mimeType: 'image/png', size: 1, sha256: 'b'.repeat(64), createdAt: project.createdAt, url: '/asset/stale' } },
    }
  }))
  await controller.start()
  const upload = controller.addFile({ name: 'stale.png', type: 'image/png', arrayBuffer: async () => Uint8Array.of(1).buffer })
  await Promise.resolve()
  await controller.discardChanges()
  releaseUpload()

  await assert.rejects(upload, /project changed/i)
  assert.equal(controller.getSnapshot().project.graph.nodes.length, 0)
})

for (const kind of ['image', 'video']) {
  test(`replacing an input ${kind} preserves its graph identity and restores the original with Undo`, async t => {
    const Controller = await DirectorController()
    const project = projectFixture('00000000-0000-4000-8000-000000000054')
    const asset = {
      id: 'old', projectId: project.id, kind, name: `old.${kind === 'image' ? 'png' : 'mp4'}`,
      mimeType: `${kind}/${kind === 'image' ? 'png' : 'mp4'}`, size: 1, sha256: 'a'.repeat(64),
      createdAt: project.createdAt, url: '/old',
    }
    project.graph.nodes = [{ id: 'input', type: 'director', position: { x: 40, y: 80 }, data: {
      kind: `load-${kind}`, mediaKind: kind, title: 'My reference', asset, maskAsset: { ...asset, id: 'mask', kind: 'mask' },
      trim: { start: 4, end: 8 }, transform: { width: 640 }, result: { kind: 'assets', assets: [asset] },
    } }, { id: 'consumer', type: 'director', position: { x: 400, y: 80 }, data: { kind: 'image-generation', title: 'Consumer' } }]
    project.graph.edges = [{ id: 'edge', source: 'input', target: 'consumer', sourceHandle: 'out', targetHandle: 'in' }]
    const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
      assert.equal(endpoint, 'assets/put')
      assert.equal(payload.projectId, project.id)
      assert.equal(payload.kind, kind)
      return { ok: true, value: { asset: { ...asset, id: 'new', name: payload.name, url: '/new' } } }
    }))
    t.after(() => controller.dispose())
    await controller.start()
    const before = structuredClone(controller.getSnapshot().project.graph)
    await controller.replaceInputFile('input', new File(['media'], `new.${kind === 'image' ? 'png' : 'mp4'}`, { type: asset.mimeType }))
    const after = controller.getSnapshot().project.graph
    assert.equal(after.nodes.length, 2)
    assert.equal(after.nodes[0].id, 'input')
    assert.equal(after.nodes[0].data.title, 'My reference')
    assert.deepEqual(after.nodes[0].position, before.nodes[0].position)
    assert.deepEqual(after.nodes[0].data.transform, { width: 640 })
    assert.deepEqual(after.edges, before.edges)
    assert.equal(after.nodes[0].data.asset.id, 'new')
    assert.equal(after.nodes[0].data.maskAsset, undefined)
    assert.equal(after.nodes[0].data.result, undefined)
    assert.deepEqual(after.nodes[0].data.trim, kind === 'video' ? { start: 0 } : undefined)
    controller.undo()
    const restored = controller.getSnapshot().project.graph
    assert.deepEqual(restored.nodes[0].data.asset, asset)
    assert.deepEqual(restored.nodes[0].data.maskAsset, before.nodes[0].data.maskAsset)
    assert.deepEqual(restored.nodes[0].data.trim, before.nodes[0].data.trim)
    assert.deepEqual(restored.edges, before.edges)
    controller.redo()
    assert.equal(controller.getSnapshot().project.graph.nodes[0].data.asset.id, 'new')
  })
}

test('a single-node run resets old statuses, preserves frozen nodes, and records completion timing', async t => {
  const Controller = await DirectorController()
  const project = projectFixture('node-status-session')
  const oldTiming = { runStartedAt: '2026-09-16T00:00:00.000Z', runCompletedAt: '2026-09-16T00:00:12.000Z' }
  project.graph.nodes = ['target', 'other', 'frozen'].map(id => ({
    id, type: 'director', position: { x: 0, y: 0 }, data: {
      kind: 'prompt-enhancer', title: id, prompt: 'Hello', providerId: 'ollama',
      status: 'completed', phase: 'completed', progress: 1, ...oldTiming,
      result: { kind: 'text', text: 'Previous output', providerId: 'ollama' },
      ...(id === 'frozen' ? { frozen: true } : {}),
    },
  }))
  let complete
  const ready = new Promise(resolve => { complete = resolve })
  const job = { id: 'new-job', projectId: project.id, nodeId: 'target', status: 'running', phase: 'generating', progress: .4,
    createdAt: '2026-09-17T01:00:00.000Z', startedAt: '2026-09-17T01:00:03.000Z', updatedAt: '2026-09-17T01:00:05.000Z' }
  const controller = new Controller(existingSessionContext(project, async endpoint => {
    if (endpoint === 'jobs/start') return { ok: true, value: { job } }
    if (endpoint === 'jobs/get') {
      await ready
      return { ok: true, value: { job: { ...job, status: 'completed', phase: 'completed', progress: 1,
        completedAt: '2026-09-17T01:00:15.300Z', result: { kind: 'text', text: 'New output', providerId: 'ollama' } } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  t.after(() => { complete(); controller.dispose() })
  await controller.start()
  const frozen = structuredClone(controller.getSnapshot().project.graph.nodes[2])
  await controller.runNode('target')
  let nodes = controller.getSnapshot().project.graph.nodes
  assert.equal(nodes[0].data.status, 'running')
  assert.equal(nodes[0].data.runCompletedAt, undefined)
  assert.equal(nodes[1].data.status, 'idle')
  assert.equal(nodes[1].data.runStartedAt, undefined)
  assert.equal(nodes[1].data.runCompletedAt, undefined)
  assert.equal(nodes[1].data.result.text, 'Previous output')
  assert.deepEqual(nodes[2], frozen)
  assert.equal(controller.getSnapshot().canUndo, false)
  complete()
  for (let i = 0; i < 50 && controller.getSnapshot().project.graph.nodes[0].data.status !== 'completed'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  nodes = controller.getSnapshot().project.graph.nodes
  assert.equal(nodes[0].data.status, 'completed')
  assert.equal(nodes[0].data.runStartedAt, job.startedAt)
  assert.equal(nodes[0].data.runCompletedAt, '2026-09-17T01:00:15.300Z')
  const preview = nodes.find(node => node.data.kind === 'preview')
  assert.equal(preview.data.runCompletedAt, nodes[0].data.runCompletedAt)
  assert.equal(preview.data.runStartedAt, nodes[0].data.runStartedAt)
  const persisted = structuredClone(controller.getSnapshot().project)
  const reloaded = new Controller(existingSessionContext(persisted, async endpoint => { throw new Error(`unexpected ${endpoint}`) }))
  t.after(() => reloaded.dispose())
  await reloaded.start()
  assert.equal(reloaded.getSnapshot().project.graph.nodes[0].data.runCompletedAt, nodes[0].data.runCompletedAt)
})

test('workflow stages reset waiting nodes and retain the current run while a later workflow queues', async t => {
  const Controller = await DirectorController()
  const project = projectFixture('workflow-status-session')
  project.graph.nodes = ['first', 'second'].map(id => ({ id, type: 'director', position: { x: 0, y: 0 }, data: {
    kind: 'prompt-enhancer', title: id, prompt: 'Hello', providerId: 'ollama', status: 'completed', phase: 'completed',
    result: { kind: 'text', text: 'Previous result', providerId: 'ollama' },
  } }))
  project.graph.nodes.push({ id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview' } })
  project.graph.edges = [
    { id: 'a', source: 'first', target: 'second', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'b', source: 'second', target: 'preview', sourceHandle: 'out', targetHandle: 'in' },
  ]
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let started
  const firstStarted = new Promise(resolve => { started = resolve })
  const jobs = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'jobs/start') {
      if (payload.nodeId === 'second') assert.equal(controller.getSnapshot().project.graph.nodes[0].data.status, 'completed')
      const job = { id: `job-${jobs.length}`, projectId: project.id, nodeId: payload.nodeId,
        status: 'running', phase: 'generating', progress: .2, createdAt: project.createdAt, updatedAt: project.updatedAt }
      jobs.push(job)
      return { ok: true, value: { job } }
    }
    if (endpoint === 'jobs/get') {
      const job = jobs.find(job => job.id === payload.jobId)
      if (job === jobs[0]) { started(); await blocked }
      return { ok: true, value: { job: { ...job, status: 'completed', phase: 'completed', progress: 1,
        result: { kind: 'text', text: 'New output', providerId: 'ollama' } } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  t.after(() => { release(); controller.dispose() })
  await controller.start()
  const firstRun = controller.runVdWorkflow({ mode: 'all' })
  await firstStarted
  const states = () => controller.getSnapshot().project.graph.nodes.slice(0, 3).map(node => node.data.status)
  assert.deepEqual(states(), ['running', 'idle', 'idle'])
  const nextRun = controller.runVdWorkflow({ mode: 'all' })
  assert.deepEqual(states(), ['running', 'idle', 'idle'])
  release()
  await Promise.all([firstRun, nextRun])
  assert.deepEqual(states(), ['completed', 'completed', 'completed'])
})

test('text file import preserves Unicode and whitespace, supports empty files, and is undoable', async t => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000054')
  project.graph.nodes = [{ id: 'text', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Script', text: 'original' } }]
  const controller = new Controller(existingSessionContext(project, async endpoint => { throw new Error(`unexpected ${endpoint}`) }))
  t.after(() => controller.dispose())
  await controller.start()
  const text = '  镜头 🎬\n\nNext shot.\n'
  await controller.replaceInputFile('text', new File([text], 'script.md'))
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, text)
  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, 'original')
  controller.redo()
  await controller.replaceInputFile('text', new File([], 'empty.txt'))
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, '')
  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, text)
  await assert.rejects(controller.replaceInputFile('text', new File([Uint8Array.of(255)], 'binary.txt')))
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, text)
})

for (const change of ['reload', 'delete', 'edit']) {
  test(`a pending text import cannot overwrite an input after ${change}`, async t => {
    const Controller = await DirectorController()
    const project = projectFixture('00000000-0000-4000-8000-000000000054')
    project.graph.nodes = [{ id: 'text', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Script', text: 'original' } }]
    const controller = new Controller(existingSessionContext(project, async endpoint => { throw new Error(`unexpected ${endpoint}`) }))
    t.after(() => controller.dispose())
    await controller.start()
    let finish
    const importing = controller.replaceInputFile('text', {
      name: 'script.txt', type: 'text/plain', arrayBuffer: () => new Promise(resolve => { finish = resolve }),
    })
    if (change === 'reload') await controller.discardChanges()
    if (change === 'delete') controller.deleteNodes(['text'])
    if (change === 'edit') controller.updateNode('text', { text: 'newer edit' })
    const before = structuredClone(controller.getSnapshot().project.graph)
    finish(new TextEncoder().encode('stale').buffer)
    await assert.rejects(importing, /changed before/)
    assert.deepEqual(controller.getSnapshot().project.graph, before)
  })
}

test('invalid and failed media replacements leave the original input and Undo history intact', async t => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000054')
  project.graph.nodes = [{ id: 'input', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'Image' } }]
  let uploads = 0
  const controller = new Controller(existingSessionContext(project, async endpoint => {
    assert.equal(endpoint, 'assets/put')
    uploads++
    throw new Error('Upload failed')
  }))
  t.after(() => controller.dispose())
  await controller.start()
  const before = structuredClone(controller.getSnapshot().project.graph)
  await assert.rejects(controller.replaceInputFile('input', new File(['video'], 'clip.mp4', { type: 'video/mp4' })), /image file/)
  assert.equal(uploads, 0)
  await assert.rejects(controller.replaceInputFile('input', new File(['image'], 'image.png', { type: 'image/png' })), /Upload failed/)
  assert.equal(uploads, 1)
  assert.deepEqual(controller.getSnapshot().project.graph, before)
  assert.equal(controller.getSnapshot().canUndo, false)
})

test('typed Custom Node ports persist identity and reject incompatible or duplicate connections', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000061')
  const imageAsset = {
    id: '00000000-0000-4000-8000-000000000062', projectId: project.id, kind: 'image', name: 'source.png',
    mimeType: 'image/png', size: 1, sha256: '1'.repeat(64), createdAt: project.createdAt, url: '/source.png',
  }
  const maskAsset = { ...imageAsset, id: '00000000-0000-4000-8000-000000000063', name: 'mask.png', url: '/mask.png' }
  project.graph.nodes = [
    { id: 'image-a', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'Image A', mediaKind: 'image', asset: imageAsset, maskAsset } },
    { id: 'image-b', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-image', title: 'Image B', mediaKind: 'image', asset: imageAsset } },
    { id: 'audio', type: 'director', position: { x: 0, y: 400 }, data: { kind: 'load-audio', title: 'Audio', mediaKind: 'audio' } },
    { id: 'edit', type: 'director', position: { x: 500, y: 0 }, data: { kind: 'image-edit', title: 'Edit', nodeType: 'local.mask-edit', nodeVersion: '1.0.0' } },
  ]
  const definition = {
    type: 'local.mask-edit', version: '1.0.0', digest: 'd'.repeat(64), title: 'Mask Edit', description: '', category: 'image',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'image-edit', workflowId: 'workflow-edit', fields: [],
    inputs: [
      { id: 'source', label: 'Source image', types: ['image'], required: true },
      { id: 'mask', label: 'Mask', types: ['mask'], required: true },
    ],
    outputs: [{ id: 'result', label: 'Result', types: ['image'] }],
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.connect({ id: 'source-edge', source: 'image-a', target: 'edit', targetHandle: 'in:source' })
  controller.connect({ id: 'mask-edge', source: 'image-a', target: 'edit', targetHandle: 'in:mask' })
  assert.throws(
    () => controller.connect({ id: 'duplicate-source', source: 'image-b', target: 'edit', targetHandle: 'in:source' }),
    /only one connection/i,
  )
  assert.throws(
    () => controller.connect({ id: 'wrong-type', source: 'audio', target: 'edit', targetHandle: 'in:source' }),
    /media types do not overlap/i,
  )

  const edges = controller.getSnapshot().project.graph.edges
  assert.deepEqual(edges.map(edge => ({
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    sourcePortId: edge.data.sourcePortId,
    targetPortId: edge.data.targetPortId,
  })), [
    { sourceHandle: 'out', targetHandle: 'in:source', sourcePortId: 'output', targetPortId: 'source' },
    { sourceHandle: 'out', targetHandle: 'in:mask', sourcePortId: 'output', targetPortId: 'mask' },
  ])
})

test('field input configuration removes its edge atomically and workflow changes prune stale modes', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000092')
  const oldDefinition = {
    type: 'local.workflow.old', version: '1.0.0', digest: '1'.repeat(64), title: 'Old', description: '', category: 'video',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'video-generation', workflowId: 'workflow-old',
    fields: [{ id: 'style', label: 'Style', type: 'text', default: '', placement: 'primary' }],
    inputs: [{ id: 'reference', label: 'Reference', types: ['image'], multiple: true }],
    outputs: [{ id: 'result', label: 'Result', types: ['video'] }],
  }
  const newDefinition = {
    ...oldDefinition,
    type: 'local.workflow.new',
    digest: '2'.repeat(64),
    workflowId: 'workflow-new',
    fields: [{ id: 'caption', label: 'Caption', type: 'text', default: '', placement: 'primary' }],
  }
  project.graph.nodes = [
    { id: 'text', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Text', mediaKind: 'text', text: 'cinematic' } },
    { id: 'target', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'video-generation', title: 'Target', workflowId: 'workflow-old' } },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [oldDefinition, newDefinition] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.configureFieldInput('target', 'style', true)
  controller.connect({ id: 'style-edge', source: 'text', target: 'target', targetHandle: 'in:field:style' })
  controller.configureFieldInput('target', 'style', false)
  let snapshot = controller.getSnapshot()
  assert.equal(snapshot.project.graph.nodes[1].data.fieldInputModes, undefined)
  assert.equal(snapshot.project.graph.edges.length, 0)

  controller.undo()
  snapshot = controller.getSnapshot()
  assert.deepEqual(snapshot.project.graph.nodes[1].data.fieldInputModes, { style: { mode: 'input' } })
  assert.equal(snapshot.project.graph.edges[0].data.targetPortId, 'field:style')

  controller.updateNode('target', { workflowId: 'workflow-new', workflowValues: { caption: 'local' } })
  snapshot = controller.getSnapshot()
  assert.equal(snapshot.project.graph.nodes[1].data.fieldInputModes, undefined)
  assert.equal(snapshot.project.graph.edges.length, 0)
  controller.undo()
  snapshot = controller.getSnapshot()
  assert.equal(snapshot.project.graph.nodes[1].data.workflowId, 'workflow-old')
  assert.deepEqual(snapshot.project.graph.nodes[1].data.fieldInputModes, { style: { mode: 'input' } })
  assert.equal(snapshot.project.graph.edges.length, 1)
})

test('changing MiniMax video mode prunes excess frame reference edges atomically', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000092')
  const definition = {
    type: 'builtin.builtin-minimax-h3-video-turbo', version: '1.0.0', digest: '3'.repeat(64),
    title: 'MiniMax-H3 Text/Image to Video (Turbo)', description: '', category: 'video', builtIn: true,
    behavior: 'workflow', execution: 'comfyui.workflow', operation: 'video-generation',
    workflowId: 'builtin-minimax-h3-video-turbo', fields: [],
    inputs: [
      { id: 'reference', label: 'Reference', types: ['image'], multiple: true },
      { id: 'flow', label: 'Flow', types: ['flow'], multiple: true },
    ],
    outputs: [{ id: 'result', label: 'Result', types: ['video'] }],
  }
  project.graph.nodes = [
    { id: 'first', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'First', mediaKind: 'image' } },
    { id: 'last', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-image', title: 'Last', mediaKind: 'image' } },
    {
      id: 'video', type: 'director', position: { x: 400, y: 0 },
      data: {
        kind: 'video-generation', title: 'Video', workflowId: definition.workflowId,
        videoMode: 'first-to-last-frame',
      },
    },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.connect({ id: 'first-edge', source: 'first', target: 'video', targetHandle: 'in' })
  controller.connect({ id: 'last-edge', source: 'last', target: 'video', targetHandle: 'in' })
  assert.deepEqual(controller.getSnapshot().project.graph.edges.map(edge => edge.id), ['first-edge', 'last-edge'])

  controller.updateNode('video', { videoMode: 'last-frame-locked' })
  assert.deepEqual(controller.getSnapshot().project.graph.edges.map(edge => edge.id), ['first-edge'])

  controller.updateNode('video', { videoMode: 'text-to-video' })
  assert.deepEqual(controller.getSnapshot().project.graph.edges, [])
})

test('run snapshots apply connected text fields, retain unconnected local values, and omit field inputs from context', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000093')
  const image = {
    id: '00000000-0000-4000-8000-000000000094', projectId: project.id, kind: 'image', name: 'reference.png',
    mimeType: 'image/png', size: 1, sha256: '9'.repeat(64), createdAt: project.createdAt, url: '/reference.png',
  }
  const definition = {
    type: 'local.workflow.dynamic-text', version: '1.0.0', digest: '3'.repeat(64), title: 'Dynamic text', description: '', category: 'video',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'video-generation', workflowId: 'workflow-dynamic-text',
    fields: [
      { id: 'style', label: 'Style', type: 'text', default: '', placement: 'primary' },
      { id: 'steps', label: 'Steps', type: 'number', default: 6, placement: 'advanced' },
    ],
    inputs: [{ id: 'reference', label: 'Reference', types: ['image'], multiple: true }],
    outputs: [{ id: 'result', label: 'Result', types: ['video'] }],
  }
  project.graph.nodes = [
    { id: 'prompt', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-text', title: 'Prompt', mediaKind: 'text', text: 'connected prompt' } },
    { id: 'style', type: 'director', position: { x: 0, y: 160 }, data: { kind: 'load-text', title: 'Style', mediaKind: 'text', text: 'connected style' } },
    { id: 'image', type: 'director', position: { x: 0, y: 320 }, data: { kind: 'load-image', title: 'Image', mediaKind: 'image', asset: image } },
    {
      id: 'target', type: 'director', position: { x: 500, y: 0 },
      data: {
        kind: 'video-generation', title: 'Target', providerId: 'comfyui', workflowId: definition.workflowId,
        prompt: 'local prompt', negativePrompt: 'local negative', workflowValues: { style: 'local style', steps: 5 },
        fieldInputModes: { prompt: { mode: 'input' }, negativePrompt: { mode: 'input' }, style: { mode: 'input' } },
      },
    },
  ]
  project.graph.edges = [
    { id: 'prompt-edge', source: 'prompt', sourceHandle: 'out', target: 'target', targetHandle: 'in:field:prompt', data: { sourcePortId: 'output', targetPortId: 'field:prompt' } },
    { id: 'style-edge', source: 'style', sourceHandle: 'out', target: 'target', targetHandle: 'in:field:style', data: { sourcePortId: 'output', targetPortId: 'field:style' } },
    { id: 'image-edge', source: 'image', sourceHandle: 'out', target: 'target', targetHandle: 'in', data: { sourcePortId: 'output', targetPortId: 'reference' } },
  ]
  let captured
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    if (endpoint === 'jobs/start') {
      captured = structuredClone(payload)
      return { ok: true, value: { job: { id: 'job-dynamic-text', status: 'queued', phase: 'queued' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('target')
  controller.dispose()

  const request = captured.snapshot.request
  assert.equal(request.prompt, 'connected prompt')
  assert.equal(request.negativePrompt, 'local negative')
  assert.deepEqual(request.workflowValues, { style: 'connected style', steps: 5 })
  assert.deepEqual(request.fieldInputModes, {
    prompt: { mode: 'input' },
    negativePrompt: { mode: 'input' },
    style: { mode: 'input' },
  })
  assert.deepEqual(request.mediaInputs.map(input => input.targetPortId), ['reference', 'field:prompt', 'field:style'])
  assert.deepEqual(JSON.parse(request.context).map(input => input.targetPortId), ['reference'])
})

test('running a typed image-edit node binds each port by its own local index', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000064')
  const sourceAsset = {
    id: '00000000-0000-4000-8000-000000000065', projectId: project.id, kind: 'image', name: 'source.png',
    mimeType: 'image/png', size: 1, sha256: '2'.repeat(64), createdAt: project.createdAt, url: '/source.png',
  }
  const maskAsset = { ...sourceAsset, id: '00000000-0000-4000-8000-000000000066', name: 'mask.png', url: '/mask.png' }
  const definition = {
    type: 'local.mask-edit', version: '1.0.0', digest: 'e'.repeat(64), title: 'Mask Edit', description: '', category: 'image',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'image-edit', workflowId: 'workflow-edit', fields: [],
    inputs: [
      { id: 'source', label: 'Source image', types: ['image'], required: true },
      { id: 'mask', label: 'Mask', types: ['mask'], required: true },
    ],
    outputs: [{ id: 'result', label: 'Result', types: ['image'] }],
  }
  project.graph.nodes = [
    { id: 'source', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'Source', mediaKind: 'image', asset: sourceAsset } },
    { id: 'mask', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-image', title: 'Mask', mediaKind: 'image', asset: sourceAsset, maskAsset } },
    {
      id: 'edit', type: 'director', position: { x: 500, y: 0 },
      data: {
        kind: 'image-edit', title: 'Edit', providerId: 'comfyui', workflowId: 'workflow-edit',
        nodeType: definition.type, nodeVersion: definition.version, status: 'idle',
        bindings: [
          { nodeId: '10', input: 'image', from: 'asset', portId: 'source', portIndex: 0 },
          { nodeId: '11', input: 'mask', from: 'maskAsset', portId: 'mask', portIndex: 0 },
        ],
      },
    },
  ]
  project.graph.edges = [
    { id: 'source-edge', source: 'source', sourceHandle: 'out', target: 'edit', targetHandle: 'in:source', data: { sourcePortId: 'output', targetPortId: 'source' } },
    { id: 'mask-edge', source: 'mask', sourceHandle: 'out', target: 'edit', targetHandle: 'in:mask', data: { sourcePortId: 'output', targetPortId: 'mask' } },
  ]
  let jobRequest
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    if (endpoint === 'jobs/start') {
      jobRequest = payload
      return { ok: true, value: { job: { id: 'job-edit', status: 'queued', phase: 'queued' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('edit')
  controller.dispose()

  assert.equal(jobRequest.projectId, project.id)
  assert.equal(jobRequest.nodeId, 'edit')
  assert.equal(jobRequest.snapshot.version, 1)
  assert.equal(jobRequest.snapshot.sourceRevision, project.revision)
  assert.equal(jobRequest.snapshot.nodeType, definition.type)
  assert.equal(jobRequest.snapshot.nodeVersion, definition.version)
  const execution = jobRequest.snapshot.request
  assert.equal(execution.operation, 'image-edit')
  assert.deepEqual(execution.mediaInputs.map(input => ({ port: input.targetPortId, mediaType: input.mediaType })), [
    { port: 'source', mediaType: 'image' },
    { port: 'mask', mediaType: 'mask' },
  ])
  assert.equal(execution.bindings[0].assetId, sourceAsset.id)
  assert.equal(execution.bindings[0].mediaIndex, 0)
  assert.equal(execution.bindings[1].assetId, maskAsset.id)
  assert.equal(execution.bindings[1].mediaIndex, 1)
})

test('workflow submissions queue immutable snapshots behind an active run', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('queue-session')
  project.graph.nodes = [{ id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'prompt-enhancer', title: 'Generate', providerId: 'ollama', prompt: 'first', status: 'idle' } }]
  const starts = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      const job = { id: `queued-${starts.length}`, projectId: project.id, nodeId: payload.nodeId,
        clientRunId: payload.clientRunId, workflowRunId: payload.snapshot.request.workflowRunId,
        status: 'queued', phase: 'queued', progress: 0, createdAt: project.createdAt, updatedAt: project.updatedAt }
      starts.push({ job, prompt: payload.snapshot.request.prompt })
      return { ok: true, value: { job } }
    }
    if (endpoint === 'jobs/get') {
      const started = starts.find(row => row.job.id === payload.jobId)
      if (started === starts[0]) await blocked
      return { ok: true, value: { job: { ...started.job, status: 'completed', phase: 'completed',
        result: { kind: 'text', text: started.prompt, providerId: 'ollama' } } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const first = controller.runVdWorkflow({ mode: 'all' })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.updateNode('generate', { prompt: 'second' })
  const second = controller.runVdWorkflow({ mode: 'all' })
  // Attach rejection handling immediately so the old busy-node error is deterministic.
  const outcomes = Promise.allSettled([first, second])
  controller.updateNode('generate', { prompt: 'later edit' })
  try {
    assert.equal(controller.getSnapshot().workflowRuns.filter(run => run.status === 'queued').length, 1)
    assert.equal(starts.length, 1)
  } finally { release() }
  const results = await outcomes
  assert.ok(results.every(result => result.status === 'fulfilled'))
  assert.deepEqual(starts.map(row => row.prompt), ['first', 'second'])
  const secondId = results[1].value
  const exported = JSON.parse((await controller.exportVdWorkflow(secondId)).text)
  assert.equal(exported.project.graph.nodes[0].data.prompt, 'second')
  await controller.openVdWorkflow(secondId)
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.prompt, 'second')
  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.prompt, 'later edit')
  controller.dispose()
})

test('cancelling a queued workflow never submits it or releases later work ahead of the active run', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('cancel-queue-session')
  project.graph.nodes = [{ id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'prompt-enhancer', title: 'Generate', providerId: 'ollama', prompt: 'first', status: 'idle' } }]
  const starts = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      const job = { id: `job-${starts.length}`, projectId: project.id, nodeId: payload.nodeId,
        clientRunId: payload.clientRunId, workflowRunId: payload.snapshot.request.workflowRunId,
        status: 'queued', phase: 'queued', progress: 0, createdAt: project.createdAt, updatedAt: project.updatedAt }
      starts.push({ job, prompt: payload.snapshot.request.prompt })
      return { ok: true, value: { job } }
    }
    if (endpoint === 'jobs/get') {
      const started = starts.find(row => row.job.id === payload.jobId)
      if (started === starts[0]) {
        await blocked
        return { ok: true, value: { job: { ...started.job, status: 'failed', phase: 'failed', error: 'execution failed' } } }
      }
      return { ok: true, value: { job: { ...started.job, status: 'completed', phase: 'completed',
        result: { kind: 'text', text: started.prompt, providerId: 'ollama' } } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const first = controller.runVdWorkflow({ mode: 'all' })
  controller.updateNode('generate', { prompt: 'cancel me' })
  const second = controller.runVdWorkflow({ mode: 'all' })
  const secondId = controller.getSnapshot().workflowRuns[0].id
  controller.updateNode('generate', { prompt: 'third' })
  const third = controller.runVdWorkflow({ mode: 'all' })
  const outcomes = Promise.allSettled([first, second, third])
  await controller.cancelVdRun(secondId)
  await new Promise(resolve => setTimeout(resolve, 10))
  try {
    assert.equal(controller.getSnapshot().workflowRuns.find(run => run.id === secondId).status, 'cancelled')
    assert.equal(starts.length, 1)
  } finally { release() }
  const results = await outcomes
  controller.dispose()
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'fulfilled'])
  assert.deepEqual(starts.map(row => row.prompt), ['first', 'third'])
})

for (const remoteFailure of [false, true]) {
  test(`cancelling an active VdWorkflow waits for remote jobs and ${remoteFailure ? 'preserves cancellation errors' : 'then releases its queue'}`, { timeout: 3_000 }, async () => {
    const Controller = await DirectorController()
    const project = projectFixture('active-cancel-session')
    project.graph.nodes = [{ id: 'generate', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'prompt-enhancer', title: 'Generate', providerId: 'ollama', prompt: 'test', status: 'idle' } }]
    const starts = []
    const cancels = []
    let monitoring
    const monitored = new Promise(resolve => { monitoring = resolve })
    let stopRemote
    const remoteStopped = new Promise(resolve => { stopRemote = resolve })
    const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
      if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
      if (endpoint === 'jobs/start') {
        const job = { id: `cancel-${starts.length}`, projectId: project.id, nodeId: payload.nodeId,
          clientRunId: payload.clientRunId, workflowRunId: payload.snapshot.request.workflowRunId,
          status: 'running', phase: 'running', progress: 0, createdAt: project.createdAt, updatedAt: project.updatedAt }
        starts.push(job)
        return { ok: true, value: { job } }
      }
      if (endpoint === 'jobs/cancel') {
        cancels.push(payload.jobId)
        return { ok: true, value: { job: { ...starts[0], phase: 'cancelling' } } }
      }
      if (endpoint === 'jobs/get') {
        const job = starts.find(row => row.id === payload.jobId)
        if (job === starts[0]) {
          monitoring()
          await remoteStopped
          return { ok: true, value: { job: { ...job, status: remoteFailure ? 'failed' : 'cancelled',
            phase: remoteFailure ? 'failed' : 'cancelled', error: remoteFailure ? 'Remote cancellation denied' : 'Cancelled',
            errorCode: remoteFailure ? 'video-director/remote-cancel-failed' : undefined } } }
        }
        return { ok: true, value: { job: { ...job, status: 'completed', phase: 'completed',
          result: { kind: 'text', text: 'next', providerId: 'ollama' } } } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }))
    await controller.start()
    const first = controller.runVdWorkflow({ mode: 'all' })
    const firstId = controller.getSnapshot().workflowRuns[0].id
    const second = controller.runVdWorkflow({ mode: 'all' })
    const outcomes = Promise.allSettled([first, second])
    await monitored
    await controller.cancelVdRun(firstId)
    try {
      assert.deepEqual(cancels, [starts[0].id])
      assert.equal(starts.length, 1, 'the next submission must wait for remote cancellation')
      assert.equal(controller.getSnapshot().workflowRuns.find(run => run.id === firstId).status, 'running')
    } finally { stopRemote() }
    const results = await outcomes
    assert.deepEqual(results.map(row => row.status), ['rejected', 'fulfilled'])
    const firstRun = controller.getSnapshot().workflowRuns.find(run => run.id === firstId)
    assert.equal(firstRun.status, remoteFailure ? 'failed' : 'cancelled')
    if (remoteFailure) assert.match(firstRun.error, /Remote cancellation denied/u)
    controller.dispose()
  })
}

test('VdWorkflow cancellation includes restored jobs absent from the canvas and surfaces request failures', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('restored-cancel-session')
  project.graph.nodes = []
  project.jobs = ['ours-a', 'ours-b', 'unrelated'].map(id => ({ id, nodeId: id, projectId: project.id,
    workflowRunId: id === 'unrelated' ? 'another-run' : 'our-run', status: 'running', phase: 'running',
    createdAt: project.createdAt, updatedAt: project.updatedAt }))
  const cancellations = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/cancel') {
      cancellations.push(payload.jobId)
      if (payload.jobId === 'ours-a') throw new Error('transport unavailable')
      return { ok: true, value: { job: { ...project.jobs[1], phase: 'cancelling' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  await assert.rejects(controller.cancelVdRun('our-run'), /Could not request cancellation for every job.*transport unavailable/u)
  assert.deepEqual(cancellations.sort(), ['ours-a', 'ours-b'])
  controller.dispose()
})

test('copy and paste captures nodes and internal edges, resets running state, and undoes as one edit', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('clipboard-session')
  project.graph.nodes = [
    { id: 'text', type: 'director', position: { x: 10, y: 20 }, data: { kind: 'load-text', title: 'Source', text: 'original' } },
    { id: 'generate', type: 'director', position: { x: 200, y: 70 }, data: { kind: 'prompt-enhancer', title: 'Generate', status: 'completed', text: 'old result', jobId: 'old-job', result: { kind: 'text', text: 'old result' } } },
    { id: 'outside', type: 'director', position: { x: 400, y: 70 }, data: { kind: 'preview', title: 'Preview' } },
  ]
  project.graph.edges = [{ id: 'internal', source: 'text', target: 'generate', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'external', source: 'generate', target: 'outside' }]
  const controller = new Controller(existingSessionContext(project, async () => ({ ok: true, value: { nodeDefinitions: [] } })))
  await controller.start()
  assert.equal(controller.canPasteNodes(), false)
  controller.copyNodes(['text', 'generate'])
  controller.updateNode('text', { text: 'later edit' })
  const ids = controller.pasteNodes({ x: 500, y: 600 })
  const graph = controller.getSnapshot().project.graph
  assert.equal(ids.length, 2)
  assert.equal(new Set(graph.nodes.map(node => node.id)).size, 5)
  assert.deepEqual(graph.nodes.slice(-2).map(node => node.position), [{ x: 500, y: 600 }, { x: 690, y: 650 }])
  assert.equal(graph.nodes.at(-2).data.text, 'original')
  assert.equal(graph.nodes.at(-1).data.status, 'idle')
  assert.equal(graph.nodes.at(-1).data.jobId, undefined)
  assert.equal(graph.nodes.at(-1).data.result, undefined)
  assert.equal(graph.edges.length, 3)
  assert.equal(graph.edges.at(-1).source, ids[0])
  assert.equal(graph.edges.at(-1).target, ids[1])
  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes.length, 3)
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.text, 'later edit')
  controller.dispose()
})

test('group Freeze toggles together and is atomic when a selected node is busy', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('freeze-group-session')
  project.graph.nodes = ['a', 'b'].map((id, i) => ({ id, type: 'director', position: { x: 100 * i, y: 0 },
    data: { kind: 'load-text', title: id, frozen: i === 0, status: 'idle' } }))
  const controller = new Controller(existingSessionContext(project, async () => ({ ok: true, value: { nodeDefinitions: [] } })))
  await controller.start()
  controller.toggleNodesFrozen(['a', 'b'])
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.map(node => node.data.frozen), [true, true])
  controller.undo()
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.map(node => node.data.frozen), [true, false])
  controller.toggleNodesFrozen(['a', 'b'])
  controller.toggleNodesFrozen(['a', 'b'])
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.map(node => node.data.frozen), [false, false])
  controller.updateNode('b', { status: 'running' })
  assert.throws(() => controller.toggleNodesFrozen(['a', 'b']), /Cancel active jobs/u)
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.map(node => node.data.frozen), [false, false])
  controller.dispose()
})

test('reset VRAM uses both configured local providers and reports partial failures', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('reset-vram-session')
  const calls = []
  const ctx = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'triggers/run') {
      calls.push(payload.action)
      if (payload.action === 'comfyui-clear') throw new Error('ComfyUI rejected unload')
      return { ok: true, value: {} }
    }
    return { ok: true, value: { models: [], modelInputs: [] } }
  })
  const original = ctx.connection.rpc.call
  ctx.connection.rpc.call = async (channel, endpoint, payload) => endpoint === 'providers/list'
    ? { ok: true, value: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://ollama' }, { id: 'comfyui', kind: 'comfyui', baseUrl: 'http://comfyui' }] } }
    : original(channel, endpoint, payload)
  const controller = new Controller(ctx)
  await controller.start()
  await assert.rejects(controller.resetVram(), /ComfyUI rejected unload/u)
  assert.deepEqual(calls.sort(), ['comfyui-clear', 'ollama-eject'])
  assert.equal(controller.getSnapshot().error, 'ComfyUI rejected unload')
  controller.dispose()
})

test('a workflow run waits for upstream results and persists grouped job metadata', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000099')
  project.graph.nodes = [
    {
      id: 'enhance', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'prompt-enhancer', title: 'Enhance', providerId: 'ollama', prompt: 'first', status: 'idle' },
    },
    {
      id: 'generate', type: 'director', position: { x: 400, y: 0 },
      data: { kind: 'prompt-enhancer', title: 'Generate', providerId: 'ollama', prompt: 'second', status: 'idle' },
    },
  ]
  project.graph.edges = [{
    id: 'dependency', source: 'enhance', sourceHandle: 'out', target: 'generate', targetHandle: 'in',
    data: { sourcePortId: 'output', targetPortId: 'reference' },
  }]
  const starts = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      starts.push(structuredClone(payload))
      const number = starts.length
      return {
        ok: true,
        value: {
          job: {
            id: `workflow-job-${String(number)}`,
            projectId: project.id,
            nodeId: payload.nodeId,
            operation: 'prompt-enhancer',
            providerId: 'ollama',
            clientRunId: payload.clientRunId,
            workflowRunId: payload.snapshot.request.workflowRunId,
            workflowRunMode: payload.snapshot.request.workflowRunMode,
            batchIndex: payload.snapshot.request.batchIndex,
            batchSize: payload.snapshot.request.batchSize,
            runSequence: number,
            status: 'queued', phase: 'queued', progress: 0,
            createdAt: project.createdAt, updatedAt: project.updatedAt,
          },
        },
      }
    }
    if (endpoint === 'jobs/get') {
      const number = Number(payload.jobId.at(-1))
      const started = starts[number - 1]
      return {
        ok: true,
        value: {
          job: {
            id: payload.jobId,
            projectId: project.id,
            nodeId: started.nodeId,
            operation: 'prompt-enhancer',
            providerId: 'ollama',
            clientRunId: started.clientRunId,
            workflowRunId: started.snapshot.request.workflowRunId,
            workflowRunMode: started.snapshot.request.workflowRunMode,
            batchIndex: 0,
            batchSize: 1,
            runSequence: number,
            status: 'completed', phase: 'completed', progress: 1,
            createdAt: project.createdAt, updatedAt: project.updatedAt,
            result: { kind: 'text', text: number === 1 ? 'enhanced first' : 'finished', providerId: 'ollama' },
          },
        },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  const workflowRunId = await controller.runVdWorkflow({ mode: 'all', batchSize: 1 })

  assert.equal(starts.length, 2)
  assert.equal(starts[0].snapshot.request.workflowRunId, workflowRunId)
  assert.equal(starts[1].snapshot.request.workflowRunId, workflowRunId)
  assert.equal(starts[0].snapshot.request.workflowRunMode, 'all')
  assert.equal(starts[0].snapshot.request.batchIndex, 0)
  assert.equal(starts[0].snapshot.request.batchSize, 1)
  assert.equal(JSON.parse(starts[1].snapshot.request.context)[0].text, 'enhanced first')
  assert.equal(controller.getSnapshot().workflowRuns[0].status, 'completed')
  assert.equal(controller.getSnapshot().workflowRuns[0].completedJobs, 2)
  assert.equal(controller.getSnapshot().project.jobs.length, 2)
  assert.ok(controller.getSnapshot().project.jobs.every(job => job.workflowRunId === workflowRunId))
  controller.dispose()
})

test('Preview Run Node reuses a frozen dependency result without starting a job', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-00000000019a')
  project.graph.nodes = [
    {
      id: 'cached', type: 'director', position: { x: 0, y: 0 },
      data: {
        kind: 'prompt-enhancer', title: 'Cached prompt', providerId: 'ollama', prompt: 'old input',
        frozen: true, status: 'completed', result: { kind: 'text', text: 'cached output', providerId: 'ollama' },
        text: 'cached output', mediaKind: 'text',
      },
    },
    { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview', status: 'completed', text: 'cached output' } },
  ]
  project.graph.edges = [{ id: 'cached-preview', source: 'cached', target: 'preview' }]
  let starts = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') starts += 1
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  const runId = await controller.runDependencies('preview')

  assert.equal(starts, 0)
  assert.equal(controller.getSnapshot().workflowRuns.find(run => run.id === runId).status, 'completed')
  assert.equal(controller.getSnapshot().workflowRuns.find(run => run.id === runId).totalJobs, 0)
  controller.dispose()
})

test('a frozen dependency without a previous result fails visibly until it is unfrozen', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-00000000019b')
  project.graph.nodes = [
    {
      id: 'empty-cache', type: 'director', position: { x: 0, y: 0 },
      data: { kind: 'prompt-enhancer', title: 'Empty cache', providerId: 'ollama', prompt: 'input', frozen: true, status: 'idle' },
    },
    { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview', status: 'idle' } },
  ]
  project.graph.edges = [{ id: 'empty-preview', source: 'empty-cache', target: 'preview' }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await assert.rejects(controller.runDependencies('preview'), /Frozen node has no reusable result: Empty cache/)

  let data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'empty-cache').data
  assert.equal(data.frozen, true)
  assert.equal(data.status, 'failed')
  assert.equal(data.phase, 'frozen-missing-result')
  assert.match(data.error, /no previous result/)

  controller.setNodeFrozen('empty-cache', false)
  data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'empty-cache').data
  assert.equal(data.frozen, false)
  assert.equal(data.status, 'idle')
  assert.equal(data.error, undefined)
  controller.dispose()
})

test('a local run validation failure is rendered on the node instead of being silently swallowed', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000079')
  const definition = {
    type: 'local.required-image', version: '1.0.0', digest: 'a'.repeat(64), title: 'Required image', description: '', category: 'image',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'image-edit', workflowId: 'workflow-required-image', fields: [],
    inputs: [{ id: 'image', label: 'Source image', types: ['image'], required: true }],
    outputs: [{ id: 'result', label: 'Result', types: ['image'] }],
  }
  project.graph.nodes = [{
    id: 'edit', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'image-edit', title: 'Edit', providerId: 'comfyui', status: 'idle',
      nodeType: definition.type, nodeVersion: definition.version, nodeDigest: definition.digest,
    },
  }]
  let starts = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [definition] } }
    if (endpoint === 'jobs/start') {
      starts += 1
      throw new Error('invalid local input must never reach the Host')
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await assert.rejects(controller.runNode('edit'), /Source image is required/)

  const data = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(starts, 0)
  assert.equal(data.status, 'failed')
  assert.equal(data.phase, 'validation-failed')
  assert.equal(data.progress, 0)
  assert.equal(data.error, 'Source image is required.')
})

test('an empty prompt stays quiet on load and reports validation only after Run', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000095')
  project.graph.nodes = [{
    id: 'prompt', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'prompt-enhancer', title: 'Prompt Enhancer', providerId: 'ollama', prompt: '', status: 'failed', phase: 'failed',
      error: 'prompt length must be between 1 and 100000', jobId: 'old-job',
    },
  }]
  let starts = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      starts += 1
      throw new Error('empty prompt must not reach the Host')
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  const loaded = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(loaded.status, 'idle')
  assert.equal(loaded.error, undefined)

  await assert.rejects(controller.runNode('prompt'), /Enter a prompt before running/)
  const attempted = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(starts, 0)
  assert.equal(attempted.status, 'failed')
  assert.equal(attempted.phase, 'validation-failed')
  assert.equal(attempted.error, 'Enter a prompt before running this node.')

  controller.updateNode('prompt', { prompt: 'A usable prompt' })
  const edited = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(edited.status, 'idle')
  assert.equal(edited.error, undefined)
})

test('Ollama runs use a real discovered model and pass supported advanced controls', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000096')
  project.graph.nodes = [{
    id: 'prompt', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'prompt-enhancer', title: 'Prompt Enhancer', providerId: 'ollama', prompt: 'A cinematic harbor', status: 'idle',
      systemPrompt: 'Keep the result concise.', contextLength: 32_768, thinking: true,
    },
  }]
  const provider = {
    id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'missing-default',
    requiresApiKey: false, apiKeySet: false, capabilities: ['text', 'vision'], configured: true, minimaxH3Unlocked: false,
  }
  const discovery = {
    models: ['qwen3-vl:latest'], workflowModels: [],
    modelDetails: [{ id: 'qwen3-vl:latest', capabilities: ['thinking', 'vision'], contextLength: 131_072 }],
  }
  let captured
  const context = existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'providers/models') return { ok: true, value: discovery }
    if (endpoint === 'jobs/start') {
      captured = structuredClone(payload.snapshot.request)
      return { ok: true, value: { job: { id: 'job-advanced', status: 'queued', phase: 'queued' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const originalCall = context.connection.rpc.call
  context.connection.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'providers/list') return { ok: true, value: { providers: [provider] } }
    return originalCall(channel, endpoint, payload)
  }
  const controller = new Controller(context)
  await controller.start()
  await new Promise(resolve => setImmediate(resolve))

  await controller.runNode('prompt')
  controller.dispose()

  assert.equal(captured.model, 'qwen3-vl:latest')
  assert.equal(captured.systemPrompt, 'Keep the result concise.')
  assert.equal(captured.contextLength, 32_768)
  assert.equal(captured.thinking, true)
})

test('an unsaved node runs from an immutable canvas snapshot without saving or reverting later edits', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000075')
  let captured
  let startReceived
  const received = new Promise(resolve => { startReceived = resolve })
  let releaseStart
  const startRelease = new Promise(resolve => { releaseStart = resolve })
  let saves = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'projects/save') {
      saves += 1
      throw new Error('Run must not save the project')
    }
    if (endpoint === 'jobs/start') {
      captured = structuredClone(payload)
      startReceived()
      await startRelease
      return { ok: true, value: { job: { id: 'job-snapshot', status: 'queued', phase: 'queued' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const nodeId = controller.addWorkflowNode('prompt-enhancer')
  controller.updateNode(nodeId, { prompt: 'prompt at click time', systemPrompt: undefined })

  const running = controller.runNode(nodeId)
  await received
  controller.updateNode(nodeId, { prompt: 'newer unsaved prompt' })
  releaseStart()
  await running
  controller.dispose()

  assert.equal(captured.nodeId, nodeId)
  assert.equal(captured.snapshot.version, 1)
  assert.equal(captured.snapshot.request.prompt, 'prompt at click time')
  assert.match(captured.snapshot.request.systemPrompt, /^You are a prompt compiler for MiniMax H3 video generation\./)
  assert.match(captured.snapshot.request.systemPrompt, /Then output exactly one finished MiniMax H3 prompt and nothing else\.$/)
  assert.equal(Buffer.byteLength(captured.snapshot.request.systemPrompt), 12_977)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === nodeId).data.prompt, 'newer unsaved prompt')
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(saves, 0)
})

test('only Codex Plan image mode prefixes the submitted prompt without mutating the editor value', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000036')
  project.graph.nodes = [{
    id: 'image', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'image-generation', title: 'Generate Image', providerId: 'codex-plan', modelId: 'gpt-5.6-sol',
      imageMode: 'generate', prompt: 'A glass observatory above the clouds.', status: 'idle',
    },
  }]
  const requests = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      requests.push(structuredClone(payload.snapshot.request))
      return { ok: true, value: { job: { id: `job-image-${String(requests.length)}`, status: 'queued', phase: 'queued' } } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('image')
  controller.updateNode('image', { imageMode: 'edit' })
  await controller.runNode('image')
  controller.updateNode('image', { providerId: 'comfyui', imageMode: 'generate' })
  await controller.runNode('image')
  controller.dispose()

  assert.equal(requests[0].prompt, '$Create Image$\nA glass observatory above the clouds.')
  assert.equal(requests[1].prompt, '$Edit Image$\nA glass observatory above the clouds.')
  assert.equal(requests[2].prompt, 'A glass observatory above the clouds.')
  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.prompt, 'A glass observatory above the clouds.')
})

test('ComfyUI seed control applies randomize, increment, fixed, and decrement after completion', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000092')
  project.graph.nodes = [{
    id: 'qwen', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'image-generation', title: 'Qwen-Image-Edit (Consistent)', providerId: 'comfyui', prompt: 'Keep the subject consistent.',
      seed: 7, seedControlAfterGenerate: 'randomize', status: 'idle',
    },
  }]
  const starts = []
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      starts.push(structuredClone(payload.snapshot.request))
      return { ok: true, value: { job: { id: `seed-job-${String(starts.length)}`, status: 'queued', phase: 'queued' } } }
    }
    if (endpoint === 'jobs/get') {
      const seed = payload.jobId === 'seed-job-1' ? 123 : 7
      return {
        ok: true,
        value: {
          job: {
            id: payload.jobId, projectId: project.id, nodeId: 'qwen', operation: 'image-generation', providerId: 'comfyui',
            status: 'completed', phase: 'completed', progress: 1, createdAt: project.createdAt, updatedAt: project.updatedAt,
            result: { kind: 'text', text: 'done', providerId: 'comfyui', seed },
          },
        },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('qwen')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(starts[0].seed, undefined)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data.outputSeed, 123)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data.seed, 123)

  controller.updateNode('qwen', { seed: 7, seedControlAfterGenerate: 'increment' })
  await controller.runNode('qwen')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data
    if (data.status === 'completed' && data.outputSeed === 7) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data
  assert.equal(starts[1].seed, 7)
  assert.equal(data.seed, 8)
  assert.equal(data.outputSeed, 7)

  controller.updateNode('qwen', { seed: 7, seedControlAfterGenerate: 'fixed' })
  await controller.runNode('qwen')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data
    if (starts.length === 3 && current.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(starts[2].seed, 7)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data.seed, 7)

  controller.updateNode('qwen', { seed: 7, seedControlAfterGenerate: 'decrement' })
  await controller.runNode('qwen')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data
    if (starts.length === 4 && current.status === 'completed' && current.seed === 6) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(starts[3].seed, 7)
  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'qwen').data.seed, 6)
  controller.dispose()
})

test('a delayed result records its actual seed without overwriting a newer editable seed', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000090')
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: {
      kind: 'video-generation', title: 'Generate', providerId: 'comfyui', seed: 7,
      seedControlAfterGenerate: 'randomize', status: 'idle',
    },
  }]
  const asset = {
    id: '00000000-0000-4000-8000-000000000091', projectId: project.id, kind: 'video', name: 'delayed.mp4',
    mimeType: 'video/mp4', size: 8, sha256: 'a'.repeat(64), createdAt: project.createdAt, url: '/delayed.mp4',
  }
  let captured
  let jobRequested
  const requested = new Promise(resolve => { jobRequested = resolve })
  let releaseJob
  const jobRelease = new Promise(resolve => { releaseJob = resolve })
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      captured = structuredClone(payload)
      return { ok: true, value: { job: { id: 'job-delayed-seed', status: 'queued', phase: 'queued' } } }
    }
    if (endpoint === 'jobs/get') {
      jobRequested()
      await jobRelease
      return {
        ok: true,
        value: {
          job: {
            id: payload.jobId, projectId: project.id, nodeId: 'generate', operation: 'video-generation', providerId: 'comfyui',
            status: 'completed', phase: 'completed', progress: 1, createdAt: project.createdAt, updatedAt: project.updatedAt,
            result: { kind: 'assets', assets: [asset], providerId: 'comfyui', seed: 123 },
          },
        },
      }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('generate')
  await requested
  controller.updateNode('generate', { seed: 99 })
  releaseJob()
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data
  assert.equal(captured.snapshot.request.seed, undefined)
  assert.equal(data.seed, 99)
  assert.equal(data.outputSeed, 123)
  assert.equal(data.result.seed, 123)
  controller.dispose()
})

test('a superseded run cannot overwrite the newer run result on the same node', { timeout: 2_000 }, async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000076')
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'prompt-enhancer', title: 'Generate', providerId: 'ollama', prompt: 'first', status: 'idle' },
  }]
  let starts = 0
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      starts += 1
      return { ok: true, value: { job: { id: `job-${String(starts)}`, status: 'queued', phase: 'queued' } } }
    }
    if (endpoint === 'jobs/get' && payload.jobId === 'job-2') {
      return {
        ok: true,
        value: {
          job: {
            id: 'job-2', projectId: project.id, nodeId: 'generate', operation: 'prompt-enhancer', providerId: 'ollama',
            status: 'completed', phase: 'completed', progress: 1, createdAt: project.createdAt, updatedAt: project.updatedAt,
            result: { kind: 'text', text: 'new result', providerId: 'ollama' },
          },
        },
      }
    }
    if (endpoint === 'jobs/get') throw new Error('superseded job must not be polled')
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await controller.runNode('generate')
  controller.updateNode('generate', { prompt: 'second' })
  await controller.runNode('generate')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.text === 'new result') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const data = controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data
  assert.equal(data.jobId, 'job-2')
  assert.equal(data.prompt, 'second')
  assert.equal(data.text, 'new result')
  assert.equal(data.status, 'completed')
  controller.dispose()
})

test('context-menu node operations duplicate clean state and delete nodes with incident edges as one Undo step', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000077')
  const asset = {
    id: '00000000-0000-4000-8000-000000000078', projectId: project.id, kind: 'audio', name: 'clip.wav',
    mimeType: 'audio/wav', size: 4, sha256: '8'.repeat(64), createdAt: project.createdAt, url: '/clip.wav',
  }
  project.graph.nodes = [
    {
      id: 'workflow', type: 'director', position: { x: 0, y: 0 },
      data: {
        kind: 'prompt-enhancer', title: 'Workflow', providerId: 'ollama', prompt: 'keep me', status: 'completed',
        jobId: 'old-job', text: 'stale output', result: { kind: 'text', text: 'stale output', providerId: 'ollama' },
      },
    },
    { id: 'audio', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-audio', title: 'Audio', mediaKind: 'audio', asset, trim: { start: 1, end: 2 }, status: 'idle' } },
    { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview', text: 'stale output', derivedFrom: 'workflow', status: 'completed' } },
  ]
  project.graph.edges = [{ id: 'workflow-preview', source: 'workflow', target: 'preview' }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.duplicateNode('workflow')
  controller.duplicateNode('audio')
  controller.duplicateNode('preview')
  const duplicated = controller.getSnapshot().project.graph.nodes.filter(node => !['workflow', 'audio', 'preview'].includes(node.id))
  const workflowCopy = duplicated.find(node => node.data.kind === 'prompt-enhancer')
  const audioCopy = duplicated.find(node => node.data.kind === 'load-audio')
  const previewCopy = duplicated.find(node => node.data.kind === 'preview')
  assert.equal(workflowCopy.data.status, 'idle')
  assert.equal(workflowCopy.data.prompt, 'keep me')
  assert.equal(workflowCopy.data.jobId, undefined)
  assert.equal(workflowCopy.data.result, undefined)
  assert.equal(workflowCopy.data.text, undefined)
  assert.equal(audioCopy.data.asset.id, asset.id)
  assert.deepEqual(audioCopy.data.trim, { start: 1, end: 2 })
  assert.equal(previewCopy.data.status, 'idle')
  assert.equal(previewCopy.data.text, undefined)
  assert.equal(previewCopy.data.derivedFrom, undefined)

  controller.deleteNodes(['workflow'])
  assert.equal(controller.getSnapshot().project.graph.nodes.some(node => node.id === 'workflow'), false)
  assert.equal(controller.getSnapshot().project.graph.edges.some(edge => edge.id === 'workflow-preview'), false)
  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes.some(node => node.id === 'workflow'), true)
  assert.equal(controller.getSnapshot().project.graph.edges.some(edge => edge.id === 'workflow-preview'), true)
})

test('automatic Preview chooses the typed output port matching the completed media', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000067')
  const asset = {
    id: '00000000-0000-4000-8000-000000000068', projectId: project.id, kind: 'image', name: 'result.png',
    mimeType: 'image/png', size: 1, sha256: '3'.repeat(64), createdAt: project.createdAt, url: '/result.png',
  }
  project.graph.nodes = [{
    id: 'custom-generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'image-generation', title: 'Generate', nodeType: 'local.multi-output', nodeVersion: '1.0.0', status: 'running' },
  }]
  const custom = {
    type: 'local.multi-output', version: '1.0.0', digest: 'f'.repeat(64), title: 'Multi output', description: '', category: 'image',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'image-generation', workflowId: 'workflow-image', fields: [],
    inputs: [],
    outputs: [
      { id: 'metadata', label: 'Metadata', types: ['text'] },
      { id: 'image', label: 'Image', types: ['image'] },
    ],
  }
  const preview = {
    type: 'core.preview', version: '1.0.0', digest: 'builtin:core.preview@1.0.0', title: 'Preview', description: '', category: 'output',
    builtIn: true, behavior: 'preview', fields: [],
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], multiple: true }],
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [custom, preview] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.applyJobResult('custom-generate', { kind: 'assets', assets: [asset], providerId: 'comfyui' })

  const snapshot = controller.getSnapshot()
  const createdPreview = snapshot.project.graph.nodes.find(node => node.data.kind === 'preview')
  const edge = snapshot.project.graph.edges.find(candidate => candidate.target === createdPreview.id)
  assert.equal(edge.sourceHandle, 'out:image')
  assert.equal(edge.targetHandle, 'in')
  assert.equal(edge.data.sourcePortId, 'image')
  assert.equal(edge.data.targetPortId, 'media')
  assert.equal(createdPreview.data.asset.id, asset.id)
})

test('Preview and Save multiple ports aggregate distinct upstream outputs instead of overwriting them', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000069')
  const first = {
    id: '00000000-0000-4000-8000-000000000070', projectId: project.id, kind: 'image', name: 'first.png',
    mimeType: 'image/png', size: 1, sha256: '4'.repeat(64), createdAt: project.createdAt, url: '/first.png',
  }
  const second = { ...first, id: '00000000-0000-4000-8000-000000000071', name: 'second.png', url: '/second.png' }
  project.graph.nodes = [
    { id: 'first', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'load-image', title: 'First', mediaKind: 'image', asset: first, result: { kind: 'assets', assets: [first], providerId: 'comfyui' } } },
    { id: 'second', type: 'director', position: { x: 0, y: 200 }, data: { kind: 'load-image', title: 'Second', mediaKind: 'image', asset: second, result: { kind: 'assets', assets: [second], providerId: 'comfyui' } } },
    { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview', status: 'idle' } },
    { id: 'save', type: 'director', position: { x: 800, y: 0 }, data: { kind: 'save', title: 'Save', status: 'idle' } },
  ]
  project.graph.edges = [{ id: 'preview-save', source: 'preview', target: 'save' }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.connect({ id: 'first-preview', source: 'first', target: 'preview' })
  controller.connect({ id: 'second-preview', source: 'second', target: 'preview' })

  const nodes = controller.getSnapshot().project.graph.nodes
  assert.deepEqual(nodes.find(node => node.id === 'preview').data.assets.map(asset => asset.id), [first.id, second.id])
  assert.deepEqual(nodes.find(node => node.id === 'save').data.assets.map(asset => asset.id), [first.id, second.id])
})

test('a rejected job submission leaves the node failed instead of permanently queued', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000072')
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'image-generation', title: 'Generate', providerId: 'comfyui', status: 'idle' },
  }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    if (endpoint === 'jobs/start') {
      return { ok: false, error: { code: 'video-director/workflow-kind-mismatch', message: 'Wrong workflow kind.' } }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  await assert.rejects(controller.runNode('generate'), /Wrong workflow kind/)

  const data = controller.getSnapshot().project.graph.nodes[0].data
  assert.equal(data.status, 'failed')
  assert.equal(data.phase, 'submission-failed')
  assert.equal(data.progress, 0)
  assert.equal(data.error, 'Wrong workflow kind.')
})

test('removing a Preview input clears that Preview and every downstream Save sink', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000073')
  const asset = {
    id: '00000000-0000-4000-8000-000000000074', projectId: project.id, kind: 'video', name: 'stale.mp4',
    mimeType: 'video/mp4', size: 1, sha256: '5'.repeat(64), createdAt: project.createdAt, url: '/stale.mp4',
  }
  project.graph.nodes = [
    { id: 'source', type: 'director', position: { x: 0, y: 0 }, data: { kind: 'video-generation', title: 'Source', status: 'completed', result: { kind: 'assets', assets: [asset], providerId: 'comfyui' } } },
    { id: 'preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Preview', status: 'idle' } },
    { id: 'save', type: 'director', position: { x: 800, y: 0 }, data: { kind: 'save', title: 'Save', status: 'idle' } },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  controller.connect({ id: 'source-preview', source: 'source', target: 'preview' })
  controller.connect({ id: 'preview-save', source: 'preview', target: 'save' })

  const connected = controller.getSnapshot().project
  controller.updateGraph(connected.graph.nodes, connected.graph.edges.filter(edge => edge.id !== 'source-preview'))

  for (const id of ['preview', 'save']) {
    const data = controller.getSnapshot().project.graph.nodes.find(node => node.id === id).data
    assert.equal(data.status, 'idle')
    assert.equal(data.asset, undefined)
    assert.equal(data.assets, undefined)
    assert.equal(data.result, undefined)
  }
})

test('typed multi-output edges deliver only the media declared by their source port', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000075')
  const image = {
    id: '00000000-0000-4000-8000-000000000076', projectId: project.id, kind: 'image', name: 'frame.png',
    mimeType: 'image/png', size: 1, sha256: '6'.repeat(64), createdAt: project.createdAt, url: '/frame.png',
  }
  const audio = {
    id: '00000000-0000-4000-8000-000000000077', projectId: project.id, kind: 'audio', name: 'sound.wav',
    mimeType: 'audio/wav', size: 1, sha256: '7'.repeat(64), createdAt: project.createdAt, url: '/sound.wav',
  }
  const sourceDefinition = {
    type: 'local.mixed-output', version: '1.0.0', digest: '8'.repeat(64), title: 'Mixed output', description: '', category: 'video',
    builtIn: false, behavior: 'workflow', execution: 'comfyui.workflow', operation: 'video-generation', workflowId: 'workflow-mixed', fields: [], inputs: [],
    outputs: [
      { id: 'image', label: 'Image', types: ['image'] },
      { id: 'audio', label: 'Audio', types: ['audio'] },
    ],
  }
  const previewDefinition = {
    type: 'core.preview', version: '1.0.0', digest: 'builtin:core.preview@1.0.0', title: 'Preview', description: '', category: 'output',
    builtIn: true, behavior: 'preview', fields: [],
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], multiple: true }],
  }
  project.graph.nodes = [
    {
      id: 'source', type: 'director', position: { x: 0, y: 0 },
      data: {
        kind: 'video-generation', title: 'Source', nodeType: sourceDefinition.type, nodeVersion: sourceDefinition.version,
        status: 'completed', result: { kind: 'assets', assets: [image, audio], providerId: 'comfyui' },
      },
    },
    { id: 'image-preview', type: 'director', position: { x: 400, y: 0 }, data: { kind: 'preview', title: 'Image Preview', nodeType: 'core.preview', nodeVersion: '1.0.0', status: 'idle' } },
    { id: 'audio-preview', type: 'director', position: { x: 400, y: 240 }, data: { kind: 'preview', title: 'Audio Preview', nodeType: 'core.preview', nodeVersion: '1.0.0', status: 'idle' } },
  ]
  project.graph.edges = [
    { id: 'image-edge', source: 'source', sourceHandle: 'out:image', target: 'image-preview', targetHandle: 'in' },
    { id: 'audio-edge', source: 'source', sourceHandle: 'out:audio', target: 'audio-preview', targetHandle: 'in' },
  ]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [sourceDefinition, previewDefinition] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const loaded = controller.getSnapshot().project
  controller.updateGraph(loaded.graph.nodes, loaded.graph.edges)

  const nodes = controller.getSnapshot().project.graph.nodes
  assert.deepEqual(nodes.find(node => node.id === 'image-preview').data.assets.map(asset => asset.id), [image.id])
  assert.deepEqual(nodes.find(node => node.id === 'audio-preview').data.assets.map(asset => asset.id), [audio.id])
})

test('Undo and Redo remain available across Save and derive dirty from the saved editable state', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000081')
  const controller = new Controller(existingSessionContext(project, async (endpoint, payload) => {
    if (endpoint !== 'projects/save') throw new Error(`unexpected endpoint ${endpoint}`)
    return {
      ok: true,
      value: { project: { ...payload.project, revision: payload.expectedRevision + 1 } },
    }
  }))
  await controller.start()

  assert.equal(controller.getSnapshot().canUndo, false)
  assert.equal(controller.getSnapshot().canRedo, false)
  controller.renameProject('First name')
  controller.renameProject('Saved name')
  assert.equal(controller.getSnapshot().canUndo, true)

  await controller.saveProject()
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().canUndo, true)

  controller.undo()
  assert.equal(controller.getSnapshot().project.name, 'First name')
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().canRedo, true)

  controller.redo()
  assert.equal(controller.getSnapshot().project.name, 'Saved name')
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(controller.getSnapshot().canRedo, false)
})

test('viewport updates skip history and a drag transaction coalesces many graph updates into one Undo step', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000082')
  project.graph.nodes = [{
    id: 'movable', type: 'director', position: { x: 10, y: 20 },
    data: { kind: 'load-text', title: 'Text', mediaKind: 'text', text: 'shot' },
  }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.updateViewport({ x: 40, y: 50, zoom: 1.25 })
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().canUndo, false)

  controller.beginHistoryTransaction()
  for (const x of [100, 200, 300]) {
    const current = controller.getSnapshot().project
    const nodes = current.graph.nodes.map(node => ({ ...node, position: { x, y: 20 } }))
    controller.updateGraph(nodes, current.graph.edges, current.graph.viewport)
  }
  controller.endHistoryTransaction()
  assert.equal(controller.getSnapshot().canUndo, true)
  assert.equal(controller.getSnapshot().project.graph.nodes[0].position.x, 300)

  controller.undo()
  assert.equal(controller.getSnapshot().project.graph.nodes[0].position.x, 10)
  assert.deepEqual(controller.getSnapshot().project.graph.viewport, { x: 40, y: 50, zoom: 1.25 })
  assert.equal(controller.getSnapshot().canUndo, false)
})

test('a terminal job result is saveable without becoming a user Undo entry', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000083')
  project.graph.nodes = [{
    id: 'generate', type: 'director', position: { x: 0, y: 0 },
    data: { kind: 'image-generation', title: 'Generate', providerId: 'comfyui', status: 'running' },
  }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()
  const asset = {
    id: '00000000-0000-4000-8000-000000000084', projectId: project.id, kind: 'image', name: 'result.png',
    mimeType: 'image/png', size: 1, sha256: '9'.repeat(64), createdAt: project.createdAt, url: '/result.png',
  }

  controller.applyJobResult('generate', { kind: 'assets', assets: [asset], providerId: 'comfyui' })

  assert.equal(controller.getSnapshot().project.graph.nodes.find(node => node.id === 'generate').data.status, 'completed')
  assert.equal(controller.getSnapshot().canUndo, false)
  assert.equal(controller.getSnapshot().dirty, true)
})

test('double-click creation APIs place blank Text, workflow, and Custom Nodes at the requested canvas point', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000085')
  const preview = {
    type: 'core.preview', version: '1.0.0', digest: 'builtin:core.preview@1.0.0', title: 'Preview', description: '', category: 'output',
    builtIn: true, behavior: 'preview', fields: [],
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], multiple: true }],
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [preview] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  controller.addTextNode({ x: 101, y: 202 })
  controller.addWorkflowNode('prompt-enhancer', { x: 303, y: 404 })
  controller.addNodeDefinition('core.preview', '1.0.0', { x: 505, y: 606 })

  const nodes = controller.getSnapshot().project.graph.nodes
  assert.deepEqual(nodes.map(node => node.position), [
    { x: 101, y: 202 },
    { x: 303, y: 404 },
    { x: 505, y: 606 },
  ])
  assert.equal(nodes[0].data.kind, 'load-text')
  assert.equal(nodes[0].data.text, '')
  assert.match(nodes[1].data.systemPrompt, /^You are a prompt compiler for MiniMax H3 video generation\./)
  assert.equal(Buffer.byteLength(nodes[1].data.systemPrompt), 12_977)
  assert.equal(nodes[1].data.contextLength, 32_000)
  assert.equal(nodes[1].data.thinking, true)
})

test('a newly created Image Workflow is titled Image Processing', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000095')
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  const nodeId = controller.addWorkflowNode('image-generation', { x: 100, y: 200 })
  const node = controller.getSnapshot().project.graph.nodes.find(candidate => candidate.id === nodeId)

  assert.equal(node.data.title, 'Image Processing')
  controller.dispose()
})

test('the legacy default Generate Image title migrates to Image Processing', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000096')
  project.graph.nodes = [{
    id: 'legacy-image', type: 'director', position: { x: 100, y: 200 },
    data: { kind: 'image-generation', title: 'Generate Image', providerId: 'comfyui', status: 'idle' },
  }]
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  assert.equal(controller.getSnapshot().project.graph.nodes[0].data.title, 'Image Processing')
  controller.dispose()
})

test('quick-add creates a compatible target and its typed edge as one Undo entry', async () => {
  const Controller = await DirectorController()
  const project = projectFixture('00000000-0000-4000-8000-000000000089')
  project.graph.nodes = [{
    id: 'image-source', type: 'director', position: { x: 20, y: 30 },
    data: { kind: 'load-image', mediaKind: 'image', title: 'Image', status: 'idle' },
  }]
  const preview = {
    type: 'core.preview', version: '1.0.0', digest: 'builtin:core.preview@1.0.0', title: 'Preview', description: '', category: 'output',
    builtIn: true, behavior: 'preview', fields: [],
    inputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], required: true, multiple: true }],
    outputs: [{ id: 'media', label: 'Media', types: ['text', 'image', 'audio', 'video'], multiple: true }],
  }
  const controller = new Controller(existingSessionContext(project, async (endpoint) => {
    if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [preview] } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }))
  await controller.start()

  const targetId = controller.addNodeDefinition('core.preview', '1.0.0', { x: 500, y: 240 }, {
    source: 'image-source', sourceHandle: 'out', targetHandle: 'in',
  })

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.project.graph.nodes.length, 2)
  assert.equal(snapshot.project.graph.nodes[1].id, targetId)
  assert.deepEqual(snapshot.project.graph.nodes[1].position, { x: 500, y: 240 })
  assert.deepEqual(snapshot.project.graph.edges.map(edge => ({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    sourcePortId: edge.data.sourcePortId,
    targetPortId: edge.data.targetPortId,
  })), [{
    source: 'image-source', target: targetId, sourceHandle: 'out', targetHandle: 'in',
    sourcePortId: 'output', targetPortId: 'media',
  }])
  assert.equal(snapshot.canUndo, true)

  controller.undo()
  assert.deepEqual(controller.getSnapshot().project.graph.nodes.map(node => node.id), ['image-source'])
  assert.equal(controller.getSnapshot().project.graph.edges.length, 0)
  assert.equal(controller.getSnapshot().canUndo, false)
})

test('deleting the current project clears its history and loads the next remaining project', async () => {
  const Controller = await DirectorController()
  const projectA = projectFixture('00000000-0000-4000-8000-000000000086')
  const projectB = {
    ...projectFixture('00000000-0000-4000-8000-000000000087'),
    id: '00000000-0000-4000-8000-000000000088',
    name: 'Remaining project',
  }
  const list = {
    current: projectA.sessionId,
    byId: {
      [projectA.sessionId]: { id: projectA.sessionId, title: projectA.name },
      [projectB.sessionId]: { id: projectB.sessionId, title: projectB.name },
    },
  }
  const bindings = new Map([projectA, projectB].map(project => [project.sessionId, {
    session: {
      getSnapshot: () => ({}),
      rename: async title => ({ ok: true, value: { title, seq: 1 } }),
    },
  }]))
  const deletes = []
  const controller = new Controller({
    sessions: {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: async () => { throw new Error('sessions already exist') },
      binding: id => bindings.get(id),
      open: id => { list.current = id },
    },
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          if (endpoint === 'projects/list') return { ok: true, value: { projects: [projectA, projectB] } }
          if (endpoint === 'providers/list') return { ok: true, value: { providers: [] } }
          if (endpoint === 'workflows/list') return { ok: true, value: { workflows: [] } }
          if (endpoint === 'nodes/list') return { ok: true, value: { nodeDefinitions: [] } }
          if (endpoint === 'projects/get' && payload.projectId === projectA.id) return { ok: true, value: { project: projectA } }
          if (endpoint === 'projects/get' && payload.projectId === projectB.id) return { ok: true, value: { project: projectB } }
          if (endpoint === 'projects/draft') return { ok: true, value: {} }
          if (endpoint === 'projects/delete') {
            deletes.push(payload)
            return { ok: true, value: { projects: [{ ...projectB, nodeCount: 0 }] } }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    },
  })
  await controller.start()
  controller.renameProject('Unsaved deletion')
  assert.equal(controller.getSnapshot().canUndo, true)

  await controller.deleteProject(projectA.id)

  assert.deepEqual(deletes, [{ projectId: projectA.id }])
  assert.equal(controller.getSnapshot().project.id, projectB.id)
  assert.equal(controller.getSnapshot().canUndo, false)
  assert.equal(controller.getSnapshot().canRedo, false)
  assert.equal(controller.getSnapshot().dirty, false)
  assert.equal(list.current, projectB.sessionId)
})
