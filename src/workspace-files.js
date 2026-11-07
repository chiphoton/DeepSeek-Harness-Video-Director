import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function fault(code, message) { return Object.assign(new Error(message), { code: `video-director/${code}` }) }
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await rename(temp, path)
}
export class SerialWrites {
  tail = Promise.resolve()
  run(operation) {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }
}
