import { DirectorInputError } from './validation.js'

/** Host-wide FIFO. Workflows retain their slot between dependency stages and cases. */
export class RunQueue {
  constructor() {
    this.entries = new Map()
    this.cancelled = new Set()
    this.onChange = () => {}
  }

  register(run) {
    if (run.batchRunId) return
    if (run.status === 'queued' || run.status === 'running') {
      this.entries.set(run.id, { projectId: run.projectId, done: false, standalone: false })
    } else {
      const entry = this.entries.get(run.id)
      if (entry) entry.done = true
    }
    this.onChange()
  }

  addJob(job) {
    const id = job.batchRunId ?? job.workflowRunId ?? job.id
    if (this.cancelled.has(id)) throw new DirectorInputError('This workflow has been cancelled.')
    if (!this.entries.has(id)) this.entries.set(id, {
      projectId: job.projectId, done: true, standalone: !job.workflowRunId && !job.batchRunId,
    })
  }

  head(jobs) {
    for (const [id, entry] of this.entries) {
      const pending = [...jobs.values()].some(job => (job.batchRunId ?? job.workflowRunId ?? job.id) === id
        && (job.status === 'queued' || job.status === 'running'))
      if (entry.done && !pending) { this.entries.delete(id); continue }
      return id
    }
  }

  allows(job, jobs) {
    const head = this.head(jobs)
    const id = job.batchRunId ?? job.workflowRunId ?? job.id
    if (head === id) return true
    // Consecutive individual node jobs in one workflow can use provider
    // concurrency, but cannot overtake another workflow's reservation.
    for (const [entryId, entry] of this.entries) {
      if (!entry.standalone || entry.projectId !== job.projectId) return false
      if (entryId === id) return true
    }
    return false
  }
}
