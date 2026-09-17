import type { ProjectDraft } from './types'

const PREFIX = 'video-director:draft:v1:'
type Entry = { draft: ProjectDraft | null }

/** Immediate browser recovery plus serialized, coalesced writes to the Host. */
export class ProjectDraftCache {
  private pending = new Map<string, Entry>()
  private writes = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private paused = new Set<string>()

  constructor(
    private write: (id: string, draft: ProjectDraft | null) => Promise<unknown>,
    private onError: (error: unknown) => void,
  ) {}

  recover(id: string): Entry | undefined {
    if (this.pending.has(id)) return this.pending.get(id)
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + id)
      if (!raw) return undefined
      const entry = JSON.parse(raw) as Entry
      if (entry.draft !== null && (!entry.draft || typeof entry.draft.name !== 'string'
        || !Array.isArray(entry.draft.graph?.nodes) || !Array.isArray(entry.draft.graph?.edges))) return undefined
      this.pending.set(id, entry)
      return entry
    } catch { return undefined }
  }

  stage(id: string, draft: ProjectDraft | null): void {
    const entry = { draft: structuredClone(draft) }
    this.pending.set(id, entry)
    try { globalThis.localStorage?.setItem(PREFIX + id, JSON.stringify(entry)) }
    catch (error) { this.onError(error) }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(this.onError) }, 200)
  }

  async flush(id?: string): Promise<void> {
    if (id === undefined) {
      await Promise.all([...new Set([...this.pending.keys(), ...this.writes.keys()])].map(key => this.flush(key)))
      return
    }
    const previous = this.writes.get(id)
    if (previous) { await previous; return this.flush(id) }
    if (this.paused.has(id)) return
    const entry = this.pending.get(id)
    if (!entry) return
    const writing = this.write(id, entry.draft).then(() => {
      if (this.pending.get(id) === entry) this.forget(id)
    })
    this.writes.set(id, writing)
    try { await writing }
    finally { if (this.writes.get(id) === writing) this.writes.delete(id) }
    if (this.pending.has(id)) await this.flush(id)
  }

  pause(id: string): void { this.paused.add(id) }
  resume(id: string): void { this.paused.delete(id) }
  async settled(id: string): Promise<void> { await this.writes.get(id) }

  forget(id: string): void {
    this.pending.delete(id)
    try { globalThis.localStorage?.removeItem(PREFIX + id) } catch { /* Host has acknowledged the draft. */ }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    void this.flush().catch(() => { /* Pending edits remain in browser recovery storage. */ })
  }
}
