import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectStore } from '../src/project-store.js'
import { EXAMPLES_FOLDER_ID } from '../src/project-folders.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vd-folders-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, 1024 * 1024)
  await store.init()
  const change = input => store.organizeProjects({ expectedRevision: store.folders.snapshot().revision, ...input })
  const folder = async (name, parentId = null) => {
    const result = await change({ action: 'create', name, parentId })
    return result.projectFolders.folders.find(row => row.name === name && row.parentId === parentId).id
  }
  const project = name => store.createProject({ name, sessionId: `session-${name}` })
  const move = (id, parentId, kind = 'project', beforeId = null) => change({ action: 'move', kind, id, parentId, beforeId })
  return { root, store, change, folder, project, move }
}

test('virtual folders and nested workflow moves persist without creating directories or rewriting workflow/assets', async t => {
  const { root, store, change, folder, project, move } = await fixture(t)
  const p = await project('Draft workflow')
  const media = await store.putAsset({ projectId: p.id, kind: 'audio', name: 'test.wav', mimeType: 'audio/wav', dataBase64: Buffer.from('synthetic-audio-bytes').toString('base64') })
  const path = join(root, 'projects', p.id, 'project.json')
  const filesBefore = { project: await readFile(path, 'utf8'), index: await readFile(store.assetsIndexPath, 'utf8'), directories: await readdir(root) }
  const parent = await folder('Scenes')
  const child = await folder('Scene 1', parent)
  await move(p.id, child)
  await change({ action: 'rename', id: parent, name: 'Film' })
  await move(child, EXAMPLES_FOLDER_ID, 'folder')
  assert.equal(await readFile(path, 'utf8'), filesBefore.project)
  assert.equal(await readFile(store.assetsIndexPath, 'utf8'), filesBefore.index)
  assert.deepEqual(await readdir(root), filesBefore.directories)
  assert.equal(await readFile(join(store.assetsDir, media.filename), 'utf8'), 'synthetic-audio-bytes')
  const reopened = new ProjectStore(root, 1024 * 1024)
  await reopened.init()
  assert.deepEqual(reopened.folders.snapshot(), store.folders.snapshot())
  assert.equal(reopened.folders.snapshot().projectParents[p.id], child)
  assert.equal(reopened.folders.snapshot().folders.find(row => row.id === child).parentId, EXAMPLES_FOLDER_ID)
})

test('legacy workflow order is adopted and folder/workflow sibling reordering is stable after restart', async t => {
  const { root, store, change, folder, project, move } = await fixture(t)
  const a = await project('A'); const b = await project('B'); const c = await project('C')
  await rm(store.folders.path)
  await writeFile(join(root, 'project-order.json'), JSON.stringify([b.id, a.id, c.id]))
  await store.folders.init()
  assert.deepEqual((await store.listProjects()).map(p => p.id), [b.id, a.id, c.id])
  const one = await folder('One'); const two = await folder('Two')
  await move(two, null, 'folder', one)
  assert.deepEqual(store.folders.snapshot().folders.map(f => f.id), [EXAMPLES_FOLDER_ID, two, one])
  await move(a.id, one); await move(b.id, one); await move(c.id, one, 'project', b.id)
  assert.deepEqual((await store.listProjects()).map(p => p.id), [a.id, c.id, b.id])
  await change({ action: 'move', kind: 'project', id: b.id, parentId: null })
  await store.folders.init()
  assert.deepEqual((await store.listProjects()).map(p => p.id), [a.id, c.id, b.id])
  assert.equal(store.folders.snapshot().projectParents[b.id], null)
})

test('cycles, invalid names, sibling collisions and stale multi-tab edits leave folder metadata unchanged', async t => {
  const { store, change, folder, move } = await fixture(t)
  const a = await folder('Parent'); const b = await folder('Child', a)
  const before = store.folders.snapshot()
  for (const input of [
    { action: 'create', name: '../outside', parentId: null },
    { action: 'create', name: 'PARENT', parentId: null },
    { action: 'move', kind: 'folder', id: a, parentId: b },
    { action: 'move', kind: 'folder', id: a, parentId: a },
  ]) await assert.rejects(change(input))
  assert.deepEqual(store.folders.snapshot(), before)
  const revision = before.revision
  const results = await Promise.allSettled([
    change({ action: 'rename', id: a, name: 'First tab', expectedRevision: revision }),
    change({ action: 'rename', id: a, name: 'Second tab', expectedRevision: revision }),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'video-director/folder-conflict')
  const sameName = await folder('Child')
  await assert.rejects(move(sameName, a, 'folder'), /already exists/)
})

test('delete folder with keep-workflows flattens all descendants, including active workflows, and preserves templates', async t => {
  const { root, store, change, folder, project, move } = await fixture(t)
  const child = await folder('Nested', EXAMPLES_FOLDER_ID)
  const a = await project('Active'); const b = await project('Child')
  await store.updateProject(a.id, { status: 'running', jobs: [{ id: 'job', status: 'running' }] })
  await move(a.id, EXAMPLES_FOLDER_ID); await move(b.id, child)
  const paths = [a, b].map(p => join(root, 'projects', p.id, 'project.json'))
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const result = await change({ action: 'delete', id: EXAMPLES_FOLDER_ID, mode: 'keep-workflows' })
  assert.deepEqual(result.deletedProjectIds, [])
  assert.deepEqual(result.projectFolders.folders, [])
  assert.deepEqual(result.projectFolders.projectParents, {})
  assert.equal(result.projectFolders.examplesParentId, null)
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before)
})

test('delete child workflows removes descendants and only their final asset references', async t => {
  const { store, change, folder, project, move } = await fixture(t)
  const parent = await folder('Delete'); const child = await folder('Nested', parent)
  const a = await project('Inside'); const b = await project('Nested'); const outside = await project('Outside')
  await move(a.id, parent); await move(b.id, child)
  const asset = await store.putAsset({ projectId: a.id, kind: 'image', name: 'shared.png', mimeType: 'image/png', dataBase64: Buffer.from('synthetic-shared').toString('base64') })
  const linked = await store.linkAsset(outside.id, asset.id)
  const unique = await store.putAsset({ projectId: b.id, kind: 'audio', name: 'unique.wav', mimeType: 'audio/wav', dataBase64: Buffer.from('synthetic-unique').toString('base64') })
  const result = await change({ action: 'delete', id: parent, mode: 'delete-workflows' })
  assert.deepEqual(new Set(result.deletedProjectIds), new Set([a.id, b.id]))
  assert.deepEqual(result.projects.map(p => p.id), [outside.id])
  assert.deepEqual(store.listAssets().map(a => a.id), [linked.id])
  assert.equal(await readFile(join(store.assetsDir, linked.filename), 'utf8'), 'synthetic-shared')
  await assert.rejects(readFile(join(store.assetsDir, unique.filename)), { code: 'ENOENT' })
  assert.deepEqual((await readdir(store.projectsDir)), [outside.id])
})

test('delete child workflows checks the entire subtree before deleting anything and rejects stale confirmations', async t => {
  const { store, change, folder, project, move } = await fixture(t)
  const parent = await folder('Keep safe')
  const a = await project('Idle'); const b = await project('Running')
  await move(a.id, parent); await move(b.id, parent)
  await store.updateProject(b.id, { status: 'running', jobs: [{ id: 'job', status: 'queued' }] })
  const before = store.folders.snapshot()
  await assert.rejects(change({ action: 'delete', id: parent, mode: 'delete-workflows' }), { code: 'video-director/project-busy' })
  assert.deepEqual(store.folders.snapshot(), before)
  assert.equal((await store.listProjects()).length, 2)
  await store.updateProject(b.id, { status: 'ready', jobs: [] })
  await move(b.id, null)
  await assert.rejects(change({ action: 'delete', id: parent, mode: 'delete-workflows', expectedRevision: before.revision }), { code: 'video-director/folder-conflict' })
  assert.equal((await store.listProjects()).length, 2)
})

test('failed folder commit restores deleted workflow directories and asset ownership', async t => {
  const { store, change, folder, project, move } = await fixture(t)
  const parent = await folder('Rollback'); const p = await project('Survives')
  await move(p.id, parent)
  const asset = await store.putAsset({ projectId: p.id, kind: 'image', name: 'test.png', mimeType: 'image/png', dataBase64: Buffer.from('synthetic-safe').toString('base64') })
  const before = store.folders.snapshot(); const index = await readFile(store.assetsIndexPath, 'utf8')
  const write = store.folders.write
  store.folders.write = async () => { throw new Error('simulated folder write failure') }
  await assert.rejects(change({ action: 'delete', id: parent, mode: 'delete-workflows' }), { code: 'video-director/project-delete-failed' })
  store.folders.write = write
  assert.deepEqual(store.folders.snapshot(), before)
  assert.equal((await store.getProject(p.id)).name, 'Survives')
  assert.equal(await readFile(store.assetsIndexPath, 'utf8'), index)
  assert.equal(await readFile(join(store.assetsDir, asset.filename), 'utf8'), 'synthetic-safe')
  assert.deepEqual(await readdir(store.projectsDir), [p.id])
})

test('new workflow creation commits directly into its virtual folder and rolls back stale or failed placement', async t => {
  const { root, store, folder } = await fixture(t)
  const parentId = await folder('Scenes')
  const revision = store.folders.snapshot().revision
  const created = await store.createProject({ name: 'New take', sessionId: 'new-take', unsaved: true, parentId, expectedFolderRevision: revision })
  assert.equal(store.folders.snapshot().projectParents[created.id], parentId)
  assert.equal(created.hasSavedVersion, false)
  assert.deepEqual(await readdir(store.projectsDir), [created.id])
  await assert.rejects(store.createProject({ name: 'Stale', sessionId: 'stale', parentId, expectedFolderRevision: revision }), { code: 'video-director/folder-conflict' })
  assert.deepEqual(await readdir(store.projectsDir), [created.id])
  const before = store.folders.snapshot()
  const write = store.folders.write
  store.folders.write = async () => { throw new Error('simulated folder commit failure') }
  await assert.rejects(store.createProject({ name: 'Rollback', sessionId: 'rollback', parentId, expectedFolderRevision: before.revision }), /simulated/)
  store.folders.write = write
  assert.deepEqual(store.folders.snapshot(), before)
  assert.deepEqual(await readdir(store.projectsDir), [created.id])
  const reopened = new ProjectStore(root, 1024 * 1024); await reopened.init()
  assert.equal(reopened.folders.snapshot().projectParents[created.id], parentId)
})

test('batch moves preserve selected descendants inside their ancestor and move loose workflows together', async t => {
  const { store, change, folder, project, move } = await fixture(t)
  const parent = await folder('Scenes'); const child = await folder('Drafts', parent); const destination = await folder('Archive')
  const nested = await project('Inside'); const loose = await project('Outside')
  await move(nested.id, child)
  await store.updateProject(nested.id, { status: 'running', jobs: [{ id: 'busy', status: 'running' }] })
  const result = await change({ action: 'batch-move', parentId: destination, items: [
    { kind: 'folder', id: parent }, { kind: 'folder', id: child }, { kind: 'project', id: nested.id }, { kind: 'project', id: loose.id },
  ] })
  assert.equal(result.projectFolders.folders.find(f => f.id === parent).parentId, destination)
  assert.equal(result.projectFolders.folders.find(f => f.id === child).parentId, parent)
  assert.equal(result.projectFolders.projectParents[nested.id], child)
  assert.equal(result.projectFolders.projectParents[loose.id], destination)
  assert.equal((await store.getProject(nested.id)).jobs[0].status, 'running')
})

test('a batch move rejects cycles, duplicate sibling names, and stale selections atomically', async t => {
  const { store, change, folder, project } = await fixture(t)
  const a = await folder('A'); const b = await folder('B'); const one = await folder('Shots', a); const two = await folder('Shots', b)
  const p = await project('Loose')
  const before = store.folders.snapshot()
  await assert.rejects(change({ action: 'batch-move', parentId: null, items: [{ kind: 'folder', id: one }, { kind: 'folder', id: two }, { kind: 'project', id: p.id }] }), /already exists/)
  await assert.rejects(change({ action: 'batch-move', parentId: one, items: [{ kind: 'folder', id: a }, { kind: 'project', id: p.id }] }), /itself/)
  await store.deleteProject(p.id)
  await assert.rejects(change({ action: 'batch-move', parentId: a, items: [{ kind: 'folder', id: b }, { kind: 'project', id: p.id }] }), /selection changed/)
  assert.deepEqual(store.folders.snapshot(), before)
})

for (const mode of ['keep-workflows', 'delete-workflows']) {
  test(`mixed batch deletion deletes explicit workflows and handles folder children with ${mode}`, async t => {
    const { store, change, folder, project, move } = await fixture(t)
    const parent = await folder('Scenes'); const child = await folder('Drafts', parent)
    const selected = await project('Selected child'); const inside = await project('Other child'); const outside = await project('Selected outside'); const keep = await project('Unselected')
    await move(selected.id, parent); await move(inside.id, child)
    const shared = await store.putAsset({ projectId: selected.id, kind: 'image', name: 'shared.png', mimeType: 'image/png', dataBase64: Buffer.from('synthetic-shared').toString('base64') })
    await store.linkAsset(keep.id, shared.id)
    const result = await change({ action: 'batch-delete', folderIds: [parent, child], projectIds: [selected.id, outside.id], mode })
    assert.deepEqual(new Set(result.deletedProjectIds), new Set([selected.id, outside.id, ...(mode === 'delete-workflows' ? [inside.id] : [])]))
    assert.equal(result.projectFolders.folders.length, 1)
    assert.deepEqual(result.projectFolders.projectParents, {})
    if (mode === 'keep-workflows') assert.equal((await store.getProject(inside.id)).name, 'Other child')
    assert.equal(await readFile(join(store.assetsDir, shared.filename), 'utf8'), 'synthetic-shared')
    assert.equal((await store.getProject(keep.id)).name, 'Unselected')
  })
}

test('mixed deletion checks all explicitly deleted workflows but permits keeping active folder children', async t => {
  const { store, change, folder, project, move } = await fixture(t)
  const parent = await folder('Scenes'); const running = await project('Running'); const idle = await project('Idle')
  await move(running.id, parent)
  await store.updateProject(running.id, { status: 'running', jobs: [{ id: 'busy', status: 'queued' }] })
  const before = store.folders.snapshot()
  await assert.rejects(change({ action: 'batch-delete', folderIds: [parent], projectIds: [idle.id], mode: 'delete-workflows' }), { code: 'video-director/project-busy' })
  assert.deepEqual(store.folders.snapshot(), before)
  assert.equal((await store.listProjects()).length, 2)
  await assert.rejects(change({ action: 'batch-delete', folderIds: [], projectIds: [idle.id, running.id], mode: 'keep-workflows' }), { code: 'video-director/project-busy' })
  const result = await change({ action: 'batch-delete', folderIds: [parent], projectIds: [idle.id], mode: 'keep-workflows' })
  assert.deepEqual(result.deletedProjectIds, [idle.id])
  assert.equal((await store.getProject(running.id)).status, 'running')
  assert.equal(result.projectFolders.projectParents[running.id], undefined)
})
