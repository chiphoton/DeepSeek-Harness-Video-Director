import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testHost } from './fixtures/director-host.js'

const compiled = await build({ entryPoints: ['src/client/chat-skills.ts'], bundle: true, format: 'esm', write: false })
const { skillNames, skillAtCaret, bindPromptSkills } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('$ mentions respect code, escaping, currency and caret placement', () => {
  assert.deepEqual(skillNames('Use $story-board then ($check). $story-board `use $literal` \\$escaped $12 a$word $bad_name ```\n$code\n```'), ['story-board', 'check'])
  assert.deepEqual(skillAtCaret('Use $story-board next', 8), { start: 4, end: 16, query: 'sto' })
  assert.deepEqual(skillAtCaret('$', 1), { start: 0, end: 1, query: '' })
  assert.equal(skillAtCaret('`$hidden', 8), null)
  assert.equal(skillAtCaret('Use $skill ', 11), null)
})

test('typed skills bind exact metadata, preserve pinned versions, and reject ambiguity before sending', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-chat-skills-synthetic-'))
  const host = await testHost(directory)
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }) })
  const project = await host.store.createProject({ name: 'Synthetic skill chat', sessionId: 'skills-test' })
  const calls = []
  const library = async (command, args = {}) => {
    calls.push(command)
    const result = await host.rpc('library/command', { projectId: project.id, sessionId: project.sessionId, command, args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const skill = await library('create', { name: 'story', description: 'Synthetic instructions', content: 'First synthetic version.' })
  await library('create', { name: 'story-board', description: 'Similar name', content: 'A different skill.' })
  calls.length = 0
  await bindPromptSkills('Use $story', library)
  assert.deepEqual(calls, ['active', 'list', 'bind'])
  await library('save', { id: skill.id, expectedRevision: 1, name: 'story', description: 'New synthetic version', content: 'Second version.' })
  calls.length = 0
  await bindPromptSkills('$story again', library)
  assert.deepEqual(calls, ['active'])
  assert.equal((await library('active')).items[0].revision, 1)
  await library('unload', { id: skill.id })
  await assert.rejects(bindPromptSkills('$story $unknown', library), /not found/)
  assert.equal((await library('active')).items.length, 0)
  await library('create', { name: 'story', description: 'Duplicate', content: 'Another story.' })
  await assert.rejects(bindPromptSkills('$story', library), /Several skills/)
  await library('bind', { id: skill.id, revision: 1 })
  await bindPromptSkills('$story', library)
  assert.equal((await library('active')).items[0].id, skill.id)
})
