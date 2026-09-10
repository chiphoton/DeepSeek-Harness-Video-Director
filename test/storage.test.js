import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { testHost } from './fixtures/director-host.js'
import { chooseDataFolder, openDataFolder } from '../src/storage.js'

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-director-storage-test-')))
  const source = join(root, 'source')
  const settings = { providerOverrides: {} }
  const app = await testHost(source, options, settings)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const rpc = async (endpoint, payload = {}) => {
    const result = await app.rpc(endpoint, payload)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  return { root, source, app, rpc, settings }
}

async function seed(rpc) {
  const sessionId = `harness-session-${randomUUID()}`
  const { project } = await rpc('projects/create', { name: 'Storage migration', sessionId })
  project.graph.nodes.push({ id: randomUUID(), type: 'director', position: { x: 10, y: 20 }, data: {
    kind: 'prompt-enhancer', title: 'Saved prompt', providerId: 'codex-plan', prompt: 'A bridge at dusk', status: 'idle',
  } })
  await rpc('projects/save', { projectId: project.id, project, expectedRevision: project.revision })
  const { asset } = await rpc('assets/put', {
    projectId: project.id, kind: 'image', name: 'saved.png', mimeType: 'image/png', dataBase64: Buffer.from('saved image bytes').toString('base64'),
  })
  await rpc('providers/update', { providerId: 'openai', patch: { apiKey: 'storage-test-secret' } })
  await rpc('providers/update', { providerId: 'codex-plan', patch: { fastMode: true } })
  return { project, sessionId, asset }
}

test('Storage copies projects, assets and run history, preserves Harness settings and sessions, and follows the folder after restart', async t => {
  const opened = []
  const { root, source, app, rpc, settings } = await fixture(t, { openFolder: async path => { opened.push(path) } })
  const { project, sessionId, asset } = await seed(rpc)
  const runId = randomUUID()
  await app.store.saveVdRun(project.id, {
    id: runId, projectId: project.id, status: 'completed', mode: 'all', batchSize: 1, completedJobs: 1, totalJobs: 1,
    nodeIds: [project.graph.nodes[0].id], startedAt: new Date().toISOString(),
  }, project)
  const relativeProject = join('projects', project.id, 'project.json')
  const originalProject = await readFile(join(source, relativeProject), 'utf8')
  await rpc('storage/open')
  assert.deepEqual(opened, [source])
  const destination = join(root, 'Video Director Data')
  const changed = await rpc('storage/change', { dataDir: destination, expectedDataDir: source })
  assert.equal(changed.dataDir, destination)
  assert.equal(changed.previousDataDir, source)
  assert.equal(await readFile(join(destination, relativeProject), 'utf8'), originalProject)
  assert.equal(await readFile(join(source, relativeProject), 'utf8'), originalProject)
  assert.equal((await app.store.getVdRun(project.id, runId)).snapshot.graph.nodes[0].data.prompt, 'A bridge at dusk')
  assert.equal((await app.store.getProject(project.id)).sessionId, sessionId)
  assert.equal((await app.store.assetBytes(asset.id)).data.toString(), 'saved image bytes')
  assert.equal(app.providerSettings.resolved().providers[0].apiKey, 'storage-test-secret')
  assert.equal(app.providers.publicCatalog().find(provider => provider.id === 'codex-plan').fastMode, true)
  await assert.rejects(stat(join(destination, 'provider-settings.json')), { code: 'ENOENT' })
  assert.equal(JSON.stringify(changed).includes('storage-test-secret'), false)
  await rpc('storage/open')
  assert.deepEqual(opened, [source, destination])
  const { project: extra } = await rpc('projects/create', { name: 'New location only', sessionId })
  await assert.rejects(stat(join(source, 'projects', extra.id)), { code: 'ENOENT' })
  const second = join(root, 'Second Data Folder')
  await mkdir(second)
  await rpc('storage/change', { dataDir: second, expectedDataDir: destination })
  await assert.rejects(stat(join(second, '.video-director-storage.json')), { code: 'ENOENT' })
  await app.close()
  const restarted = await testHost(source, {}, settings)
  try {
    assert.equal(restarted.store.root, second)
    assert.equal((await restarted.store.getProject(extra.id)).name, 'New location only')
    assert.equal((await restarted.store.assetBytes(asset.id)).data.toString(), 'saved image bytes')
    assert.equal(restarted.providers.publicCatalog().find(provider => provider.id === 'codex-plan').fastMode, true)
  } finally { await restarted.close() }
  await rename(second, `${second}-offline`)
  await assert.rejects(testHost(source), /saved Video Director data folder is unavailable/u)
})

test('Storage rejects nonempty, overlapping, relative, symlinked and stale destinations without overwriting files', async t => {
  const { root, source, app, rpc } = await fixture(t)
  await seed(rpc)
  const occupied = join(root, 'occupied')
  await mkdir(occupied)
  await writeFile(join(occupied, 'keep.txt'), 'Do not overwrite')
  const alias = join(root, 'source-alias')
  await symlink(source, alias, 'junction')
  for (const dataDir of ['relative/path', source, join(source, 'nested'), root, occupied, alias]) {
    const result = await app.rpc('storage/change', { dataDir, expectedDataDir: source })
    assert.equal(result.ok, false, dataDir)
    assert.equal((await rpc('storage/info')).dataDir, source)
  }
  const stale = await app.rpc('storage/change', { dataDir: join(root, 'new'), expectedDataDir: occupied })
  assert.equal(stale.ok, false)
  assert.match(stale.error.message, /changed in another window/u)
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'Do not overwrite')
})

test('Storage keeps the original active if its persistent location cannot be committed', async t => {
  const { root, source, app, rpc } = await fixture(t)
  const { project } = await seed(rpc)
  await mkdir(join(source, '.video-director-storage.json'))
  const destination = join(root, 'copy')
  const result = await app.rpc('storage/change', { dataDir: destination, expectedDataDir: source })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /original folder is still in use/u)
  assert.equal(app.store.root, source)
  assert.equal((await rpc('projects/get', { projectId: project.id })).project.name, 'Storage migration')
  assert.ok(await stat(join(destination, 'projects', project.id, 'project.json')))
})

test('Storage refuses relocation during a running job or queued workflow', async t => {
  const { root, source, app, rpc } = await fixture(t)
  const { project } = await seed(rpc)
  app.jobs.running = 1
  try {
    const blocked = await app.rpc('storage/change', { dataDir: join(root, 'new'), expectedDataDir: source })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error.message, /generation jobs/u)
    assert.equal((await rpc('storage/info')).canChange, false)
  } finally { app.jobs.running = 0 }
  await app.store.saveVdRun(project.id, {
    id: randomUUID(), projectId: project.id, status: 'queued', mode: 'all', batchSize: 1, completedJobs: 0, totalJobs: 1,
    nodeIds: [project.graph.nodes[0].id], startedAt: new Date().toISOString(),
  }, project)
  const blocked = await app.rpc('storage/change', { dataDir: join(root, 'new'), expectedDataDir: source })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error.message, /canvas workflows/u)
  await assert.rejects(stat(join(root, 'new')), { code: 'ENOENT' })
})

test('Storage drains accepted saves and rejects new writes during a move', async t => {
  const { root, source, app, rpc } = await fixture(t)
  const { project } = await seed(rpc)
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const save = app.store.saveProject.bind(app.store)
  app.store.saveProject = async (...args) => { entered.resolve(); await gate.promise; return save(...args) }
  const current = await app.store.getProject(project.id)
  current.name = 'Saved before copying'
  const saving = app.rpc('projects/save', { projectId: project.id, project: current, expectedRevision: current.revision })
  await entered.promise
  const moving = app.rpc('storage/change', { dataDir: join(root, 'new'), expectedDataDir: source })
  try {
    const blocked = await app.rpc('projects/create', { name: 'Too late', sessionId: 'session' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error.message, /data is being copied/u)
  } finally { gate.resolve() }
  assert.equal((await saving).ok, true)
  assert.equal((await moving).ok, true)
  assert.equal((await app.store.getProject(project.id)).name, 'Saved before copying')
})

test('Reset brings the latest data back to the default and retains both old folders as backups', async t => {
  const { root, source, app, rpc } = await fixture(t)
  const { project, sessionId, asset } = await seed(rpc)
  assert.equal((await rpc('storage/info')).isDefault, true)
  const destination = join(root, 'Selected folder')
  await rpc('storage/change', { dataDir: destination, expectedDataDir: source })
  const current = await app.store.getProject(project.id)
  current.name = 'Latest canvas edits'
  await rpc('projects/save', { projectId: project.id, project: current, expectedRevision: current.revision })
  await writeFile(join(source, 'keep.txt'), 'Original default folder contents')
  const reset = await rpc('storage/reset', { expectedDataDir: destination, dataDir: '/ignored-client-path' })
  assert.equal(reset.dataDir, source)
  assert.equal(reset.isDefault, true)
  assert.equal(await readFile(join(reset.backupDataDir, 'keep.txt'), 'utf8'), 'Original default folder contents')
  assert.equal(JSON.parse(await readFile(join(reset.backupDataDir, 'projects', project.id, 'project.json'), 'utf8')).name, 'Storage migration')
  assert.equal(JSON.parse(await readFile(join(destination, 'projects', project.id, 'project.json'), 'utf8')).name, 'Latest canvas edits')
  assert.equal((await app.store.getProject(project.id)).name, 'Latest canvas edits')
  assert.equal((await app.store.getProject(project.id)).sessionId, sessionId)
  assert.equal((await app.store.assetBytes(asset.id)).data.toString(), 'saved image bytes')
  assert.equal((await rpc('storage/reset', { expectedDataDir: source })).backupDataDir, null)
  await app.close()
  const restarted = await testHost(source)
  try {
    assert.equal(restarted.store.root, source)
    assert.equal((await restarted.store.getProject(project.id)).name, 'Latest canvas edits')
    const movedAgain = join(root, 'Moved again')
    assert.equal((await restarted.rpc('storage/change', { dataDir: movedAgain, expectedDataDir: source })).ok, true)
    assert.equal(restarted.store.root, movedAgain)
  } finally { await restarted.close() }
})

test('Folder selection cancels without moving data and allows only one native dialog', async t => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const choices = []
  const { source, rpc, app } = await fixture(t, { chooseFolder: async (path, options) => {
    choices.push({ path, language: options.language })
    entered.resolve()
    return gate.promise
  } })
  const selection = rpc('storage/choose', { language: 'zh' })
  await entered.promise
  try {
    assert.equal((await app.rpc('storage/choose')).ok, false)
    assert.equal((await rpc('storage/info')).dataDir, source)
  } finally { gate.resolve(null) }
  assert.deepEqual(await selection, { dataDir: null })
  assert.deepEqual(choices, [{ path: source, language: 'zh' }])
  await assert.rejects(stat(join(source, '.video-director-storage.json')), { code: 'ENOENT' })
})

test('Native folder opening uses platform commands with a literal path argument', async () => {
  for (const [platform, command] of [['darwin', 'open'], ['win32', 'explorer.exe'], ['linux', 'xdg-open']]) {
    const calls = []
    const path = platform === 'win32' ? 'C:\\Canvas Data\\$(literal)' : '/tmp/Canvas Data/$(literal)'
    await openDataFolder(path, { platform, launch: async (...args) => { calls.push(args) } })
    assert.equal(calls[0][0], command)
    assert.deepEqual(calls[0][1], [path])
    assert.equal(calls[0][2].shell, false)
  }
})


test('Native folder choosers keep paths out of executable scripts and handle cancellation and Linux fallback', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const path = platform === 'win32' ? "C:\\Canvas Data\\'$(literal)" : "/tmp/Canvas Data/'$(literal)"
    const calls = []
    const selected = await chooseDataFolder(path, { platform, language: 'zh', launch: async (...args) => {
      calls.push(args)
      return { stdout: '/tmp/chosen folder/\n' }
    } })
    assert.equal(selected, '/tmp/chosen folder')
    const [command, args, options] = calls[0]
    assert.equal(options.shell, false)
    if (platform === 'darwin') {
      assert.equal(command, 'osascript')
      assert.equal(args[1].includes(path), false)
      assert.equal(args[2], path)
    } else if (platform === 'win32') {
      assert.equal(command, 'powershell.exe')
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le').includes(path), false)
      assert.equal(options.env.CANVAS_FOLDER_PICKER_PATH, path)
    } else assert.ok(args.includes(`--filename=${path}/`))
    assert.equal(await chooseDataFolder(path, { platform, launch: async () => ({ stdout: '' }) }), null)
  }
  const calls = []
  assert.equal(await chooseDataFolder('/tmp', { platform: 'linux', launch: async command => {
    calls.push(command)
    throw Object.assign(new Error('fixture'), { code: command === 'zenity' ? 'ENOENT' : 1 })
  } }), null)
  assert.deepEqual(calls, ['zenity', 'kdialog'])
  await assert.rejects(chooseDataFolder('/tmp', { platform: 'linux', launch: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }), /Install Zenity or KDialog/u)
})
