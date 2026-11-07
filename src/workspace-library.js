import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { atomicJson, readJson, digest, fault, SerialWrites } from './workspace-files.js'
import { record, string, uuid, jsonValue } from './validation.js'
import { parseDocument, stringify as yamlStringify } from 'yaml'

const INVOCATION_BYTES = 16384
const summary = row => ({ id: row.id, name: row.name, description: row.description, revision: row.revision,
  digest: row.digest, projectId: row.projectId, shared: row.shared, archived: row.archived, updatedAt: row.updatedAt,
  ...(row.builtIn ? { builtIn: true } : {}) })
const instructions = (version, value) => ({ ...version, content: value.content,
  resources: Object.keys(value.resources), resourceTool: 'vd_library resource with id, revision, path' })
function bundle(input) {
  let frontmatter = record(jsonValue(input.frontmatter ?? {}, 'skill frontmatter', 4096), 'skill frontmatter')
  if (input.markdown !== undefined) {
    const markdown = string(input.markdown, 'SKILL.md', { max: 20000, trim: false }).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown)
    if (!match) throw fault('invalid-skill', 'SKILL.md requires YAML frontmatter with name and description.')
    const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true, stringKeys: true })
    if (document.errors.length || document.warnings.length) throw fault('invalid-skill', 'SKILL.md frontmatter is invalid or uses unsupported YAML tags.')
    frontmatter = record(jsonValue(document.toJS({ maxAliasCount: 10 }), 'skill frontmatter', 4096), 'skill frontmatter')
    input = { ...input, name: frontmatter.name, description: frontmatter.description, content: markdown.slice(match[0].length).trim() }
  }
  const name = string(input.name, 'skill name', { min: 1, max: 64 })
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw fault('invalid-skill', 'Use a lowercase hyphenated skill name.')
  const description = string(input.description, 'description', { min: 1, max: 240 })
  const content = string(input.content, 'instructions', { min: 1, max: 16384, trim: false })
  if (Buffer.byteLength(content) > 12288) throw fault('skill-too-large', 'Keep instructions under 12 KiB; move supporting material into resources.')
  const resources = record(jsonValue(input.resources ?? {}, 'resources', 512 * 1024), 'resources')
  if (Object.keys(resources).length > 20) throw fault('invalid-skill', 'Use at most 20 resources per skill.')
  for (const [path, text] of Object.entries(resources)) {
    if (!/^(references|assets|scripts)\/[a-zA-Z0-9_.\/-]+$/.test(path) || path.length > 120 || path.split('/').some(part => !part || part === '.' || part === '..')) throw fault('invalid-resource', 'Resources must be relative files beneath references/, assets/, or scripts/.')
    string(text, 'resource text', { max: 65536, trim: false })
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) if (frontmatter[key] !== undefined && typeof frontmatter[key] !== 'boolean') throw fault('invalid-skill', `${key} must be a boolean.`)
  const value = { name, description, content, resources, frontmatter: { ...frontmatter, name, description } }
  const invocation = { name, description, content, resources: Object.keys(resources) }
  if (Buffer.byteLength(JSON.stringify(invocation)) > INVOCATION_BYTES - 1024) throw fault('skill-too-large', 'The encoded skill exceeds the loading budget; split its instructions into resources.')
  return value
}

function builtinSkill(id, directory, paths = []) {
  const root = new URL(`../skills/${directory}/`, import.meta.url)
  const value = bundle({ markdown: readFileSync(new URL('SKILL.md', root), 'utf8'),
    resources: Object.fromEntries(paths.map(path => [path, readFileSync(new URL(path, root), 'utf8')])) })
  return [id, { value, row: { id, name: value.name, description: value.description,
    revision: 1, digest: digest(value), builtIn: true, shared: true, archived: false } }]
}
const builtins = new Map([
  builtinSkill('f38e3f8b-87e8-45c1-a137-aeeb84080e47', 'canvas-builder', ['references/few-shot.md', 'references/sketch-to-video-review.md']),
  builtinSkill('77a299a8-19c6-4ad8-843f-d1f82798f502', 'layout-optimizer'),
  builtinSkill('8fe04de4-ad98-4cf9-83b7-5cd2d4918f32', 'sketch-to-h3'),
])

/** Project ownership, immutable versions, and selected-session bindings live behind one interface. */
export class WorkspaceLibrary {
  writes = new SerialWrites()
  constructor(store) { this.store = store }
  get root() { return join(this.store.root, 'library', 'skills') }
  async rows() {
    await mkdir(this.root, { recursive: true })
    const dirs = await readdir(this.root, { withFileTypes: true })
    const rows = await Promise.all(dirs.filter(dir => dir.isDirectory() && /^[0-9a-f-]{36}$/.test(dir.name)).map(dir => readJson(join(this.root, dir.name, 'index.json'), null)))
    return rows.filter(Boolean)
  }
  async entry(projectId, id, write = false) {
    uuid(id, 'skillId')
    const builtin = builtins.get(id)
    if (builtin) {
      if (write) throw fault('skill-read-only', 'Duplicate this built-in skill to edit your own version.')
      return builtin.row
    }
    const row = await readJson(join(this.root, id, 'index.json'), null)
    if (!row || (row.projectId !== projectId && (!row.shared || write))) throw fault('skill-not-found', 'Skill is not available in this workflow. Import a copy to edit a shared skill.')
    return row
  }
  async bindings(project) {
    const saved = await readJson(join(this.store.projectsDir, project.id, 'library-bindings.json'), { revision: 0, sessionId: project.sessionId, items: [] })
    return saved.sessionId === project.sessionId ? saved : { revision: saved.revision, sessionId: project.sessionId, items: [] }
  }
  async call(project, action, args = {}, source = 'agent') {
    if (['create', 'save', 'bind', 'unload', 'archive', 'publish', 'load'].includes(action)) return this.writes.run(() => this.execute(project, action, args, source))
    return this.execute(project, action, args, source)
  }
  async execute(project, action, args, source) {
    if (action === 'invoke') {
      const skill = [...builtins.values()].find(skill => skill.row.name === args.name)
      if (!skill || skill.value.frontmatter['disable-model-invocation'] === true) {
        throw fault('skill-not-automatic', 'Choose an available built-in skill. Select other skills in chat before loading them.')
      }
      return instructions(summary(skill.row), skill.value)
    }
    if (action === 'list') {
      const items = [...[...builtins.values()].map(skill => skill.row), ...await this.rows()].filter(row => (row.projectId === project.id || row.shared) && (args.archived || !row.archived)
        && (args.name === undefined || row.name === args.name)
        && (!args.query || `${row.name} ${row.description}`.toLowerCase().includes(String(args.query).toLowerCase()))).map(summary).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0)
      const limit = Math.max(1, Math.min(50, Number.isSafeInteger(args.limit) ? args.limit : 20))
      return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null }
    }
    if (action === 'active') return this.bindings(project)
    if (action === 'create' || action === 'save') {
      const previous = action === 'save' ? await this.entry(project.id, args.id, true) : null
      if (previous && args.expectedRevision !== previous.revision) throw fault('skill-conflict', 'Skill changed. Reload before saving a new version.')
      const value = bundle(args)
      const row = { id: previous?.id ?? randomUUID(), projectId: project.id, shared: previous?.shared ?? false,
        archived: false, revision: (previous?.revision ?? 0) + 1, digest: digest(value), name: value.name, description: value.description, updatedAt: new Date().toISOString() }
      const directory = join(this.root, row.id, 'versions', String(row.revision))
      const staging = `${directory}.${randomUUID()}.tmp`
      await mkdir(staging, { recursive: true })
      await atomicJson(join(staging, 'bundle.json'), value)
      const markdown = `---\n${yamlStringify(value.frontmatter)}---\n\n${value.content}\n`
      await writeFile(join(staging, 'SKILL.md'), markdown, { mode: 0o600 })
      for (const [path, text] of Object.entries(value.resources)) {
        await mkdir(dirname(join(staging, path)), { recursive: true })
        await writeFile(join(staging, path), text, { mode: 0o600 })
      }
      // A prepared version is inert until its index pointer is atomically published.
      // A crash may leave this unpublished next version behind. The serialized
      // writer has verified that the published index still precedes it.
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
      await atomicJson(join(this.root, row.id, 'index.json'), row)
      return summary(row)
    }
    if (action === 'unload') {
      const bindings = await this.bindings(project)
      bindings.items = bindings.items.filter(row => row.id !== args.id)
      bindings.revision++
      await atomicJson(join(this.store.projectsDir, project.id, 'library-bindings.json'), bindings)
      return bindings
    }
    const row = await this.entry(project.id, args.id, ['archive', 'publish'].includes(action))
    if (action === 'archive' || action === 'publish') {
      if (args.expectedRevision !== row.revision) throw fault('skill-conflict', 'Reload the current skill before changing its availability.')
      row[action === 'archive' ? 'archived' : 'shared'] = args.enabled !== false
      await atomicJson(join(this.root, row.id, 'index.json'), row)
      return summary(row)
    }
    const bindings = await this.bindings(project)
    const pinned = bindings.items.find(item => item.id === row.id)
    const revision = args.revision ?? (action === 'load' || action === 'resource' ? pinned?.revision : row.revision)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > row.revision) throw fault('invalid-skill', 'Choose an existing skill version.')
    const value = row.builtIn ? builtins.get(row.id).value : await readJson(join(this.root, row.id, 'versions', String(revision), 'bundle.json'), null)
    if (!value) throw fault('skill-not-found', 'Skill version is unavailable.')
    const version = { ...summary(row), name: value.name, description: value.description, revision, digest: digest(value) }
    if (action === 'get') return { ...version, ...value }
    if (action === 'resource') {
      const path = string(args.path, 'path', { min: 1, max: 120 })
      if (!Object.hasOwn(value.resources, path)) throw fault('resource-not-found', 'Unknown skill resource.')
      const text = value.resources[path]
      const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0)
      const excerpt = text.slice(offset, offset + 2000)
      return { id: row.id, revision, path, digest: digest(text), text: excerpt, nextOffset: offset + excerpt.length < text.length ? offset + excerpt.length : null }
    }
    if (action === 'bind' || action === 'load') {
      if (row.archived && !pinned) throw fault('skill-archived', 'Restore the skill before selecting it.')
      if (action === 'load' && (!pinned || pinned.revision !== revision)) throw fault('skill-not-selected', 'Select this skill version for the linked chat before loading it.')
      if (action === 'bind' && (source === 'human' ? value.frontmatter?.['user-invocable'] === false : value.frontmatter?.['disable-model-invocation'] === true)) throw fault('skill-invocation-disabled', 'This skill does not permit that invocation source.')
      if (action === 'load' && value.frontmatter?.['disable-model-invocation'] === true && pinned?.selectedBy !== 'human') throw fault('skill-invocation-disabled', 'This skill requires explicit human selection.')
      if (!pinned && bindings.items.length >= 8) throw fault('skill-budget', 'Select at most eight skills per chat.')
      const item = { id: row.id, name: value.name, revision, digest: version.digest, selectedBy: action === 'bind' ? source : pinned.selectedBy, ...(action === 'load' ? { loadedAt: new Date().toISOString() } : {}) }
      bindings.items = [...bindings.items.filter(item => item.id !== row.id), item]
      bindings.revision++
      await atomicJson(join(this.store.projectsDir, project.id, 'library-bindings.json'), bindings)
      return action === 'bind' ? bindings : instructions(version, value)
    }
    throw fault('invalid-operation', 'Unknown library operation.')
  }
}
