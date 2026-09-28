import { compareJobHistory } from '../job-history.js'
import type { DirectorJob, JobHistoryCursor, JobHistoryGroup, JobHistoryPage, JobHistoryState, VdRun } from './types'

interface PageRequest { projectId?: string; before?: JobHistoryCursor; limit: number }
const emptyPage = (): JobHistoryState => ({ groups: [], nextCursor: null, initialized: false, loading: false, error: null })

/** Tab-local memory. Closing the drawer releases observation, not loaded pages. */
export class JobHistoryCache {
  private pages: Record<string, JobHistoryState> = {}
  private pending = new Map<string, Promise<void>>()
  private watchers = new Map<string, number>()
  private disposed = false

  constructor(private fetchPage: (request: PageRequest) => Promise<JobHistoryPage>,
    private onChange: (pages: Record<string, JobHistoryState>) => void) {}

  private update(filter: string, changes: Partial<JobHistoryState>): void {
    if (this.disposed) return
    this.pages = { ...this.pages, [filter]: { ...(this.pages[filter] ?? emptyPage()), ...changes } }
    this.onChange(this.pages)
  }

  private merge(filter: string, groups: JobHistoryGroup[]): JobHistoryGroup[] {
    const previous = this.pages[filter]?.groups ?? []
    const rows = new Map(previous.map(group => [group.id, group]))
    for (const group of groups) {
      const old = rows.get(group.id)
      rows.set(group.id, old && JSON.stringify(old) === JSON.stringify(group) ? old : group)
    }
    const merged = [...rows.values()].sort(compareJobHistory)
    return merged.length === previous.length && merged.every((group, i) => group === previous[i]) ? previous : merged
  }

  watch(filter: string): () => void {
    if (this.disposed) return () => {}
    this.watchers.set(filter, (this.watchers.get(filter) ?? 0) + 1)
    if (!this.pages[filter]?.initialized) void this.loadMore(filter).catch(() => {})
    return () => {
      const count = (this.watchers.get(filter) ?? 1) - 1
      if (count) this.watchers.set(filter, count)
      else this.watchers.delete(filter)
    }
  }

  loadMore(filter = ''): Promise<void> {
    const pending = this.pending.get(filter)
    if (pending) return pending
    const state = this.pages[filter]
    if (this.disposed) return Promise.resolve()
    if (state?.initialized && !state.nextCursor) return state.error ? this.refresh(filter) : Promise.resolve()
    this.update(filter, { loading: true, error: null })
    const request = this.fetchPage({ ...(filter ? { projectId: filter } : {}), limit: 10,
      ...(state?.nextCursor ? { before: state.nextCursor } : {}) }).then(page => {
      this.update(filter, { groups: this.merge(filter, page.groups), nextCursor: page.nextCursor, initialized: true })
    }).catch(error => {
      this.update(filter, { error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { this.pending.delete(filter); this.update(filter, { loading: false }) })
    this.pending.set(filter, request)
    return request
  }

  async refreshWatched(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map(filter => this.refresh(filter)))
  }

  private refresh(filter: string): Promise<void> {
    const pending = this.pending.get(filter)
    if (pending) return pending
    const state = this.pages[filter]
    if (!state?.initialized) return this.loadMore(filter)
    const newest = state.groups[0]
    const request = (async () => {
      let before: JobHistoryCursor | undefined
      const added: JobHistoryGroup[] = []
      do {
        const page = await this.fetchPage({ ...(filter ? { projectId: filter } : {}), limit: 10, before })
        if (this.disposed) return
        added.push(...page.groups)
        // Recheck the head to catch new records with tied timestamps too. Follow
        // pages only while filling a gap above the previous head, keeping the
        // separate older-history cursor and every previously loaded record.
        if (!newest) {
          if (JSON.stringify(page.nextCursor) !== JSON.stringify(this.pages[filter]?.nextCursor)) this.update(filter, { nextCursor: page.nextCursor })
          break
        }
        const last = page.groups.at(-1)
        if (!last || compareJobHistory(last, newest) >= 0) break
        before = page.nextCursor ?? undefined
      } while (before)
      const groups = this.merge(filter, added)
      if (groups !== this.pages[filter]?.groups || this.pages[filter]?.error) this.update(filter, { groups, error: null })
    })().catch(error => {
      this.update(filter, { error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { this.pending.delete(filter) })
    this.pending.set(filter, request)
    return request
  }

  groups(): JobHistoryGroup[] {
    return [...new Map(Object.values(this.pages).flatMap(page => page.groups).map(group => [group.id, group])).values()]
  }

  findRun(id: string): VdRun | undefined { return this.groups().find(group => group.id === id)?.run }
  findJob(id: string): DirectorJob | undefined { return this.groups().flatMap(group => group.jobs).find(job => job.id === id) }

  updateJob(job: DirectorJob): void {
    for (const [filter, page] of Object.entries(this.pages)) {
      if (page.groups.some(group => group.jobs.some(row => row.id === job.id))) this.update(filter, {
        groups: page.groups.map(group => group.jobs.some(row => row.id === job.id)
          ? { ...group, jobs: group.jobs.map(row => row.id === job.id ? job : row) } : group),
      })
    }
  }

  /** Refresh known cards from the shared observer; never admits unrequested history. */
  synchronize(runs: VdRun[], jobs: DirectorJob[], projects: Set<string>, observedRuns: Set<string>, observedJobs: Set<string>): void {
    const byRun = new Map(runs.map(run => [run.id, run])), byJob = new Map(jobs.map(job => [job.id, job]))
    const parents = new Set(runs.map(run => run.batchRunId).filter(Boolean))
    for (const [filter, page] of Object.entries(this.pages)) {
      const groups = page.groups.flatMap(group => {
        if (!projects.has(group.projectId)) return []
        const run = byRun.get(group.id) ?? (observedRuns.has(group.id) ? undefined : group.run)
        if (group.run && (!run || run.hidden || (run.kind === 'batch' && parents.has(run.id)))) return []
        const nextJobs = group.jobs.flatMap(job => byJob.get(job.id) ?? (observedJobs.has(job.id) ? [] : [job]))
        if (!run && !nextJobs.length) return []
        const next = { ...group, ...(run ? { run } : {}), jobs: nextJobs }
        return [JSON.stringify(next) === JSON.stringify(group) ? group : next]
      })
      if (groups.length !== page.groups.length || groups.some((group, i) => group !== page.groups[i])) this.update(filter, { groups })
    }
  }

  remove(id: string): void {
    for (const [filter, page] of Object.entries(this.pages)) {
      const groups = page.groups.filter(group => group.id !== id && !group.jobs.some(job => job.id === id))
      if (groups.length !== page.groups.length) this.update(filter, { groups })
    }
  }

  dispose(): void { this.disposed = true; this.watchers.clear(); this.pages = {}; this.pending.clear() }
}
