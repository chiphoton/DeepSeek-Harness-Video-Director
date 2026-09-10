import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DirectorInputError } from './validation.js'

const SUFFIX = '.video-director.json'
const DEFAULT_ROOT = fileURLToPath(new URL('../examples/', import.meta.url))

/** Bundled templates are read-only; opening one uses the normal project importer. */
export class ExampleProjects {
  constructor(root = DEFAULT_ROOT) { this.root = root }

  async list() {
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return entries.filter(entry => entry.isFile() && entry.name.endsWith(SUFFIX))
      .map(entry => ({ id: entry.name, name: entry.name.slice(0, -SUFFIX.length) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async read(id) {
    // Only accept an exact listed filename, never a caller-supplied path or symlink.
    if (!(await this.list()).some(example => example.id === id)) throw new DirectorInputError('Example project not found. Reopen the project picker to refresh examples.')
    return readFile(join(this.root, id), 'utf8')
  }
}
