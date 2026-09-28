/** @typedef {import('./client/types').JobHistoryGroup} JobHistoryGroup */
/** @typedef {import('./client/types').JobHistoryCursor} JobHistoryCursor */

/** A deterministic key keeps pages stable when timestamps tie or new runs arrive. */
export function compareJobHistory(left, right) {
  return right.submitted.localeCompare(left.submitted) || right.id.localeCompare(left.id)
}

/** @param {JobHistoryCursor} group @returns {JobHistoryCursor} */
export function jobHistoryCursor(group) {
  return { submitted: group.submitted, id: group.id }
}

/**
 * Group before paging: a run and its child jobs occupy one card, hidden runs
 * stay hidden, and batch cases replace their parent card once they exist.
 * @param {import('./client/types').VdRun[]} runs
 * @param {import('./client/types').DirectorJob[]} jobs
 * @returns {JobHistoryGroup[]}
 */
export function groupJobHistory(runs, jobs) {
  const groups = new Map()
  const parents = new Set(runs.map(run => run.batchRunId).filter(Boolean))
  const hidden = new Set(runs.filter(run => run.hidden || (run.kind === 'batch' && parents.has(run.id))).map(run => run.id))
  for (const run of runs) if (!hidden.has(run.id)) groups.set(run.id, {
    id: run.id, projectId: run.projectId, run, jobs: [], submitted: run.queuedAt ?? run.startedAt,
  })
  for (const job of jobs) {
    if (job.workflowRunId && hidden.has(job.workflowRunId)) continue
    const id = job.workflowRunId ?? `job:${job.id}`
    const group = groups.get(id) ?? { id, projectId: job.projectId, jobs: [], submitted: job.createdAt }
    group.jobs.push(job)
    groups.set(id, group)
  }
  return [...groups.values()].sort(compareJobHistory)
}

/**
 * Keyset pagination is independent of insertions/deletions on earlier pages.
 * @param {JobHistoryGroup[]} groups
 * @param {{before?: JobHistoryCursor, limit?: number}} options
 */
export function pageJobHistory(groups, { before, limit = 10 } = {}) {
  const eligible = groups.filter(group => !before || compareJobHistory(group, before) > 0)
  const page = eligible.slice(0, limit)
  return { groups: page, nextCursor: eligible.length > limit ? jobHistoryCursor(page[page.length - 1]) : null }
}
