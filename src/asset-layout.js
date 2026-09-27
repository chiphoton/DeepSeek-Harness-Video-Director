import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const LEGACY_FILE = new RegExp(`^${UUID}\\.[a-z0-9]+$`, 'iu')
const OUTPUT_FILE = new RegExp(`^outputs/\\d{8}-${UUID}\\.[a-z0-9]+$`, 'iu')
const DERIVED_FILE = /^inputs\/(mask|sketch)\/\1-\d{8}-[0-9a-f]{8}\.[a-z0-9]+$/u
const key = filename => filename.normalize('NFC').toLowerCase()
const dateStamp = createdAt => new Date(createdAt).toISOString().slice(0, 10).replaceAll('-', '')

export function isLegacyAsset(filename) { return LEGACY_FILE.test(filename) }

export function validAssetFilename(filename, kind, origin) {
  if (typeof filename !== 'string' || /[\\\x00-\x1f\x7f:]/u.test(filename)) return false
  if (origin === 'output') return !['mask', 'sketch'].includes(kind) && OUTPUT_FILE.test(filename)
  if (origin !== 'input') return false
  if (kind === 'mask' || kind === 'sketch') return DERIVED_FILE.test(filename) && filename.startsWith(`inputs/${kind}/`)
  const parts = filename.split('/')
  return parts.length === 2 && parts[0] === 'inputs' && !!parts[1]
    && !['.', '..', 'mask', 'sketch'].includes(parts[1].toLowerCase())
    && !/[. ]$/u.test(parts[1]) && Buffer.byteLength(parts[1]) <= 255
}

function originalFilename(name, extension) {
  const leaf = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f:]/gu, '_').replace(/[. ]+$/u, '')
  const suffix = extname(leaf) || `.${extension}`
  let stem = (extname(leaf) ? leaf.slice(0, -suffix.length) : leaf) || 'input'
  // Leave room for a collision suffix, including on filesystems that limit bytes.
  while (Buffer.byteLength(stem + suffix) > 240 && stem.length) stem = Array.from(stem).slice(0, -1).join('')
  if (!stem || Buffer.byteLength(suffix) > 100) return `input.${extension}`
  return stem + suffix
}

export async function ensureAssetDirectories(assetsDir) {
  for (const relative of ['', 'inputs', 'inputs/mask', 'inputs/sketch', 'outputs']) {
    const path = join(assetsDir, relative)
    await mkdir(path, { recursive: true })
    if (!(await lstat(path)).isDirectory()) throw new Error('Asset folders must be real directories, not symbolic links.')
  }
}

/** Hash opaque bytes locally; never decode or inspect media contents. */
export async function hashAssetFile(path) {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('Asset storage contains a non-file or symbolic link.')
  const hash = createHash('sha256')
  const stream = createReadStream(path, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
  for await (const chunk of stream) hash.update(chunk)
  return { sha256: hash.digest('hex'), size: info.size }
}

async function existingFile(path) {
  try { return await hashAssetFile(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** Called under the store's asset write lock, or while preparing a migration. */
export async function allocateAssetFile(assetsDir, asset, extension, assets, { planning = false } = {}) {
  const used = new Map(assets.map(row => [key(row.filename), row]))
  const inspect = async filename => {
    const indexed = used.get(key(filename))
    if (indexed) {
      if (indexed.sha256 !== asset.sha256 || indexed.size !== asset.size) return { occupied: true }
      if (!planning) {
        const actual = await hashAssetFile(join(assetsDir, indexed.filename))
        if (actual.sha256 !== indexed.sha256 || actual.size !== indexed.size) throw new Error('Stored asset hash does not match its index. Restore the file before reusing it.')
      }
      return { filename: indexed.filename, blobId: indexed.blobId ?? indexed.id, created: false }
    }
    const actual = await existingFile(join(assetsDir, filename))
    if (!actual) return { filename, created: true }
    return actual.sha256 === asset.sha256 && actual.size === asset.size
      ? { filename, created: false } : { occupied: true }
  }
  if (asset.origin === 'output' || asset.kind === 'mask' || asset.kind === 'sketch') {
    let token = asset.id
    for (;;) {
      const filename = asset.origin === 'output'
        ? `outputs/${dateStamp(asset.createdAt)}-${token}.${extension}`
        : `inputs/${asset.kind}/${asset.kind}-${dateStamp(asset.createdAt)}-${token.slice(0, 8)}.${extension}`
      const slot = await inspect(filename)
      if (!slot.occupied) return slot
      token = randomUUID()
    }
  }
  const name = originalFilename(asset.name, extension)
  const suffix = extname(name)
  const stem = name.slice(0, -suffix.length)
  for (let index = 0; ; index++) {
    const filename = `inputs/${index ? `${stem}-${String(index).padStart(4, '0')}${suffix}` : name}`
    const slot = await inspect(filename)
    if (!slot.occupied) return slot
  }
}

// Only JSON records are examined for provenance. Unknown legacy files remain
// inputs; generated assets remain outputs even when later used by an INPUT node.
async function legacyProvenance(projectsDir) {
  const outputs = new Set()
  const inputs = new Set()
  const collect = (value, target = outputs) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.id === 'string' && typeof value.sha256 === 'string' && typeof value.mimeType === 'string') {
      target.add(value.id); return
    }
    for (const item of Object.values(value)) collect(item, target)
  }
  const inspect = value => {
    if (!value || typeof value !== 'object') return
    // Job results, generated node results, and editor replacements are outputs.
    if (value.result && typeof value.nodeId === 'string' && (typeof value.providerId === 'string' || typeof value.operation === 'string')) collect(value.result)
    if (value.mediaEditId) outputs.add(value.mediaEditId)
    if (/^load-(image|audio|video|sketch)$/u.test(value.kind)) collect(value.asset, inputs)
    if (value.kind === 'batch-input') collect(value.batch?.items, inputs)
    if (/^(image-generation|image-edit|audio-generation|video-generation|video-trim|video-crop|video-extract-frame)$/u.test(value.kind)) {
      collect(value.asset); collect(value.assets); collect(value.result)
    }
    for (const item of Object.values(value)) inspect(item)
  }
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.json')) inspect(JSON.parse(await readFile(path, 'utf8')))
    }
  }
  await visit(projectsDir)
  return { outputs, inputs }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

const JOURNAL = 'asset-layout-v2.json'

async function finishMigration(root, assetsDir, rows) {
  const path = join(root, 'migrations', JOURNAL)
  let journal
  try { journal = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (journal.version !== 2 || journal.completedAt || !Array.isArray(journal.moves)) return
  const current = new Map(rows.map(row => [row.id, row]))
  // The index is the commit point. A partial preparation never removes sources.
  if (!journal.assets.every(row => current.get(row.id)?.filename === row.filename)) return
  for (const move of journal.moves) {
    if (!isLegacyAsset(move.from) || !validAssetFilename(move.to, move.kind, move.origin)) throw new Error('Invalid asset migration recovery record.')
    const target = await hashAssetFile(join(assetsDir, move.to))
    if (target.sha256 !== move.sha256 || target.size !== move.size) throw new Error('Migrated asset verification failed; original files were retained.')
  }
  for (const move of journal.moves) {
    if (rows.some(row => row.filename === move.from)) continue
    const source = await existingFile(join(assetsDir, move.from))
    if (source && (source.sha256 !== move.sha256 || source.size !== move.size)) throw new Error('Legacy asset changed; migration cleanup stopped.')
    await rm(join(assetsDir, move.from), { force: true })
  }
  await atomicJson(path, { ...journal, completedAt: new Date().toISOString() })
}

/** An atomic, resumable flat-layout migration. IDs and all workflow links survive. */
export async function migrateAssetLayout(root, rows, extensions, { dryRun = false, commitIndex, originalIndex = rows } = {}) {
  const assetsDir = join(root, 'assets')
  const legacy = rows.filter(row => isLegacyAsset(row.filename))
  if (!legacy.length) {
    if (!dryRun) await finishMigration(root, assetsDir, rows)
    return { assets: rows, report: { migrated: 0 } }
  }
  const provenance = await legacyProvenance(join(root, 'projects'))
  const groups = new Map()
  for (const asset of legacy) groups.set(asset.filename, [...(groups.get(asset.filename) ?? []), asset])
  // Verify every source before writing anything, including the recovery record.
  for (const [filename, group] of groups) {
    const actual = await hashAssetFile(join(assetsDir, filename))
    if (group.some(row => row.sha256 !== actual.sha256 || row.size !== actual.size)) {
      throw new Error(`Asset ${group[0].id} failed hash verification. Migration has not changed the index or original files.`)
    }
  }
  const planned = rows.filter(row => !isLegacyAsset(row.filename))
  const replacements = new Map()
  const moves = []
  let unclassifiedInputs = 0
  for (const [from, group] of groups) {
    const representative = group.find(row => row.id === (row.blobId ?? row.id)) ?? group[0]
    const origin = ['mask', 'sketch'].includes(representative.kind) ? 'input'
      : group.some(row => row.origin === 'output' || provenance.outputs.has(row.id)) ? 'output' : 'input'
    if (origin === 'input' && !['mask', 'sketch'].includes(representative.kind)
      && !group.some(row => row.origin === 'input' || provenance.inputs.has(row.id))) unclassifiedInputs++
    const metadata = { ...representative, origin }
    const slot = await allocateAssetFile(assetsDir, metadata, extensions.get(metadata.mimeType), planned, { planning: true })
    for (const row of group) {
      const next = { ...row, origin, filename: slot.filename, blobId: slot.blobId ?? representative.blobId ?? representative.id }
      replacements.set(row.id, next)
      planned.push(next)
    }
    moves.push({ from, to: slot.filename, kind: metadata.kind, origin, sha256: metadata.sha256, size: metadata.size })
  }
  const assets = rows.map(row => replacements.get(row.id) ?? row)
  const uniqueTargets = new Set(moves.map(move => move.to))
  const report = { migrated: legacy.length, previousFiles: groups.size, files: uniqueTargets.size,
    sharedFilesRemoved: groups.size - uniqueTargets.size, unclassifiedInputs,
    inputs: moves.filter(move => move.origin === 'input').length, outputs: moves.filter(move => move.origin === 'output').length }
  if (dryRun) return { assets, report }
  await ensureAssetDirectories(assetsDir)
  const directory = join(root, 'migrations')
  await mkdir(directory, { recursive: true })
  await atomicJson(join(directory, JOURNAL), { version: 2, startedAt: new Date().toISOString(), originalIndex, assets, moves, report })
  for (const move of moves) {
    const target = join(assetsDir, move.to)
    if (!await existingFile(target)) {
      // Hard linking stages bytes without doubling storage; the old path stays
      // valid until the new index is committed. Copy only across filesystems.
      try { await link(join(assetsDir, move.from), target) }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error
        await copyFile(join(assetsDir, move.from), target, constants.COPYFILE_EXCL)
      }
    }
    const actual = await hashAssetFile(target)
    if (actual.sha256 !== move.sha256 || actual.size !== move.size) throw new Error('Asset migration target verification failed. Original files were retained.')
  }
  await (commitIndex ?? (values => atomicJson(join(assetsDir, 'index.json'), values)))(assets)
  await finishMigration(root, assetsDir, assets)
  return { assets, report }
}
