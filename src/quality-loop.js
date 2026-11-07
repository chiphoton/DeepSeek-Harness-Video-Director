import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { atomicJson, readJson, digest, fault, SerialWrites } from './workspace-files.js'
import { draftOf } from './canvas-history.js'
import { string, uuid, jsonValue } from './validation.js'
import { planVdRun, vdNodeResultPayload } from '../lib/workflow-execution.js'

const terminal = row => ['accepted', 'stopped'].includes(row.state)
const running = run => ['queued', 'running'].includes(run.status)
const integer = (value, fallback, max) => {
  value ??= fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fault('invalid-budget', `Choose an integer between 1 and ${max}.`)
  return value
}
const publicPlan = row => { const { initialGraphDigest, ...rest } = row; return rest }
const modelSelections = catalog => catalog.providers.map(provider => ({ id: provider.id, kind: provider.kind,
  model: provider.model ?? null, imageModel: provider.imageModel ?? null, fastMode: provider.fastMode ?? false }))
const skillSelections = items => items.map(({ id, revision, digest }) => ({ id, revision, digest })).sort((a, b) => a.id.localeCompare(b.id))

/** The Host records/checks iterations. The owning DSH agent supplies revisions and perceptual evidence. */
export class QualityLoop {
  writes = new SerialWrites()
  watched = new Map()
  constructor({ store, library, call }) { Object.assign(this, { store, library, call }) }
  path(projectId, id) { return join(this.store.projectsDir, uuid(projectId, 'projectId'), 'quality', `${uuid(id, 'planId')}.json`) }
  async save(row) { await atomicJson(this.path(row.projectId, row.id), row); if (terminal(row)) this.watched.delete(row.id); else this.watched.set(row.id, row.projectId); return publicPlan(row) }
  async get(projectId, id) {
    const row = await readJson(this.path(projectId, id), null)
    if (!row) throw fault('plan-not-found', 'Quality plan is not in this workflow.')
    return row
  }
  async list(projectId) {
    let files
    try { files = await readdir(join(this.store.projectsDir, projectId, 'quality')) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const rows = await Promise.all(files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => this.get(projectId, file.slice(0, -5))))
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async recover() {
    for (const project of await this.store.listProjects()) for (const row of await this.list(project.id)) if (!terminal(row)) {
      this.watched.set(row.id, row.projectId)
      if (row.state === 'submitting') {
        const run = await this.store.getVdRun(row.projectId, row.currentRunId).catch(() => null)
        row.state = run ? 'running' : 'stopped'; row.reason = run ? undefined : 'Submission interrupted. Inspect run history before creating a new plan.'
        await this.save(row)
      }
    }
    this.timer = setInterval(() => { void this.writes.run(async () => {
      for (const [id, projectId] of this.watched) {
        try {
          const row = await this.get(projectId, id)
          const project = await this.store.getProject(projectId)
          if (row.cancelRequested || Date.now() >= row.deadline || project.draftRevision !== row.draftRevision || project.sessionId !== row.sessionId) await this.stop(row, row.cancelRequested ? row.reason : Date.now() >= row.deadline ? 'Time budget exhausted.' : 'Canvas or linked chat changed outside this plan.')
        } catch (error) { if (error.code === 'video-director/project-not-found') this.watched.delete(id) }
      }
    }) }, 1000)
    this.timer.unref?.()
  }
  async close() { clearInterval(this.timer); await this.writes.tail }
  async stop(row, reason) {
    if (row.currentRunId && ['submitting', 'running', 'stopping'].includes(row.state)) {
      row.cancelRequested = true; row.reason = reason; await this.save(row)
      try {
        await this.call('vd-runs/cancel', { projectId: row.projectId, runId: row.currentRunId })
        if (running(await this.store.getVdRun(row.projectId, row.currentRunId))) { row.state = 'stopping'; return this.save(row) }
      } catch {
        row.state = 'stopping'
        row.reason = reason.includes('Cancellation needs reconciliation.') ? reason : `${reason} Cancellation needs reconciliation.`
        return this.save(row)
      }
    }
    row.state = 'stopped'; row.reason = reason
    return this.save(row)
  }
  async command(project, command, args, source = 'agent', signal) {
    const execute = () => { signal?.throwIfAborted(); return this.execute(project, command, args, source) }
    let result = await this.writes.run(execute)
    const until = Date.now() + Math.max(0, Math.min(30000, Number.isSafeInteger(args.waitMs) ? args.waitMs : 0))
    // Wait outside the write queue so deadline/cancel commands remain responsive.
    while (command === 'step' && result.state === 'running' && Date.now() < until) {
      await delay(Math.min(250, until - Date.now()), undefined, { signal })
      result = await this.writes.run(execute)
    }
    return result
  }
  async execute(project, command, args, source) {
    if (command === 'list') {
      const rows = await this.list(project.id)
      const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0)
      const limit = Math.max(1, Math.min(50, Number.isSafeInteger(args.limit) ? args.limit : 20))
      return { items: rows.slice(offset, offset + limit).map(publicPlan), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null }
    }
    if (command === 'create') {
      if ((await this.list(project.id)).some(row => !terminal(row))) throw fault('plan-active', 'Finish or stop the current quality plan first.')
      if (project.jobs.some(job => running(job)) || (await this.store.listVdRuns(project.id)).some(running)) throw fault('workflow-busy', 'Finish or cancel existing execution before creating a quality plan.')
      const criteria = jsonValue(args.criteria ?? [{ id: 'valid', type: 'graph-valid' }, { id: 'completed', type: 'run-completed' }], 'criteria', 16384)
      if (!Array.isArray(criteria) || !criteria.length || criteria.length > 20) throw fault('invalid-criteria', 'Choose 1–20 quality checks.')
      const ids = new Set()
      for (const check of criteria) {
        string(check.id, 'criterion id', { min: 1, max: 64 })
        if (ids.has(check.id) || check.id.startsWith('$')) throw fault('invalid-criteria', 'Criterion IDs must be unique and cannot start with $.')
        ids.add(check.id)
        if (!['graph-valid', 'run-completed', 'node-count', 'artifact-count', 'text-includes', 'perceptual'].includes(check.type)) throw fault('invalid-criteria', 'Unknown quality check type.')
        if (['node-count', 'artifact-count'].includes(check.type)) {
          if (!Number.isSafeInteger(check.min) || check.min < 0 || check.min > 5000) throw fault('invalid-criteria', 'Count checks require a minimum from 0 to 5000.')
        }
        if (check.type === 'text-includes') { string(check.nodeId, 'nodeId', { min: 1, max: 128 }); string(check.text, 'expected text', { min: 1, max: 1000 }) }
        if (check.type === 'perceptual') string(check.description, 'criterion description', { min: 1, max: 1000 })
      }
      const row = { id: args.id ? uuid(args.id, 'planId') : randomUUID(), projectId: project.id, sessionId: project.sessionId,
        brief: string(args.brief, 'brief', { min: 1, max: 2000 }), criteria, state: 'planned', draftRevision: project.draftRevision,
        createdAt: new Date().toISOString(), deadline: Date.now() + integer(args.maxMinutes, 10, 60) * 60000,
        maxIterations: integer(args.maxIterations, 3, 10), maxJobs: integer(args.maxJobs, 20, 100), iterations: 0, reservedJobs: 0,
        skills: (await this.library.bindings(project)).items, models: modelSelections(await this.call('providers/list', {})),
        minimumConfidence: args.minimumConfidence ?? .7, reports: [], best: null, initialGraphDigest: digest(draftOf(project).graph) }
      if (typeof row.minimumConfidence !== 'number' || !Number.isFinite(row.minimumConfidence) || row.minimumConfidence < 0 || row.minimumConfidence > 1) throw fault('invalid-criteria', 'minimumConfidence must be between 0 and 1.')
      if (await readJson(this.path(project.id, row.id), null)) throw fault('idempotency-conflict', 'Plan ID already exists.')
      return this.save(row)
    }
    const row = await this.get(project.id, args.id)
    if (row.sessionId !== project.sessionId) throw fault('plan-session-changed', 'This plan belongs to the previous conversation.')
    if (command === 'get') return publicPlan(row)
    if (command === 'stop') return this.stop(row, 'Stopped by the user or owning agent.')
    if (terminal(row)) throw fault('plan-finished', 'This plan has finished. Inspect its reports or create a new plan.')
    if (row.cancelRequested) return this.stop(row, row.reason)
    project = await this.store.getProject(project.id)
    if (row.sessionId !== project.sessionId) return this.stop(row, 'The linked conversation changed.')
    if (Date.now() >= row.deadline) return this.stop(row, 'Time budget exhausted.')
    if (project.draftRevision !== row.draftRevision) return this.stop(row, 'Canvas changed outside this plan; existing edits were preserved.')
    if (digest(skillSelections((await this.library.bindings(project)).items)) !== digest(skillSelections(row.skills))) return this.stop(row, 'Selected skill versions changed; create a new plan with the intended skills.')
    if (command === 'revise') {
      if (row.state !== 'needs-revision') throw fault('invalid-plan-state', 'Wait for a failed quality check before revising this plan.')
      if (row.iterations >= row.maxIterations) return this.stop(row, 'Iteration budget exhausted.')
      const result = await this.call('canvas/command', { projectId: project.id, sessionId: project.sessionId, command: 'edit', args: {
        expectedDraftRevision: row.draftRevision, edits: args.edits, idempotencyKey: args.idempotencyKey ?? randomUUID(),
      } })
      row.draftRevision = result.draftRevision; row.state = 'planned'
      const changes = result.operation.changes
      row.affected = [...new Set([...changes.added, ...changes.updated])]
      if (changes.edgesAdded.length || changes.edgesRemoved.length || changes.edgesUpdated.length || changes.removed.length || changes.fields.length) row.affected = null
      row.lastOperationId = result.operation.id
      return this.save(row)
    }
    if (command === 'evaluate') {
      if (row.state !== 'inspecting') throw fault('invalid-plan-state', 'Wait for outputs before recording perceptual checks.')
      const criterion = row.criteria.find(check => check.id === args.criterionId && check.type === 'perceptual')
      if (!criterion) throw fault('invalid-criteria', 'Choose a perceptual criterion from this plan.')
      if (!['pass', 'fail', 'unknown', 'needs-human'].includes(args.verdict)) throw fault('invalid-verdict', 'Choose pass, fail, unknown, or needs-human.')
      if (typeof args.confidence !== 'number' || !Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1) throw fault('invalid-verdict', 'Provide confidence between 0 and 1.')
      const evidence = jsonValue(args.evidence ?? [], 'evidence', 8192)
      if (!Array.isArray(evidence) || evidence.length > 12 || (['pass', 'fail'].includes(args.verdict) && !evidence.length)) throw fault('missing-evidence', 'Pass/fail requires evidence from this iteration.')
      const jobs = await this.store.listVdRunJobs(project.id, row.currentRunId)
      for (const reused of row.reusedOutputs ?? []) {
        const output = (await this.store.listVdRunJobs(project.id, reused.runId)).find(job => job.id === reused.jobId)
        if (output) jobs.push(output)
      }
      for (const ref of evidence) {
        const job = jobs.find(job => job.id === ref.jobId)
        if (!job?.result) throw fault('missing-evidence', 'Evidence must identify an output job from this iteration.')
        if (ref.assetId && !job.result.assets?.some(asset => asset.id === ref.assetId)) throw fault('missing-evidence', 'Asset evidence is not an output of the identified job.')
        if (ref.atSeconds !== undefined && (typeof ref.atSeconds !== 'number' || !Number.isFinite(ref.atSeconds) || ref.atSeconds < 0)) throw fault('missing-evidence', 'Evidence timestamps must be non-negative seconds.')
      }
      const report = row.reports.at(-1)
      report.checks = [...report.checks.filter(check => check.id !== criterion.id), { id: criterion.id, verdict: args.confidence < row.minimumConfidence && ['pass', 'fail'].includes(args.verdict) ? 'needs-human' : args.verdict,
        reason: string(args.reason, 'reason', { min: 1, max: 1000 }), confidence: args.confidence, evidence, source }]
      return this.decide(row)
    }
    if (command !== 'step') throw fault('invalid-operation', 'Unknown quality operation.')
    if (row.state === 'needs-revision' || row.state === 'inspecting') return publicPlan(row)
    if (row.state === 'planned') {
      if (digest(modelSelections(await this.call('providers/list', {}))) !== digest(row.models)) return this.stop(row, 'Provider model selections changed; create a new plan with the intended models.')
      if (row.iterations >= row.maxIterations) return this.stop(row, 'Iteration budget exhausted.')
      const snapshot = draftOf(project)
      // Reuse unchanged outputs in the execution snapshot, leaving the editable canvas untouched.
      if (row.currentRunId && row.affected?.length) {
        const affected = new Set(row.affected)
        let size
        do { size = affected.size; for (const edge of snapshot.graph.edges) if (affected.has(edge.source)) affected.add(edge.target) } while (size !== affected.size)
        const jobs = await this.store.listVdRunJobs(project.id, row.currentRunId)
        const previous = await this.store.getVdRun(project.id, row.currentRunId)
        const reusedOutputs = []
        snapshot.graph.nodes = snapshot.graph.nodes.map(node => {
          const job = jobs.find(job => job.nodeId === node.id && job.status === 'completed' && job.result)
          const inherited = (row.reusedOutputs ?? []).find(output => output.nodeId === node.id)
          const result = job?.result ?? (inherited ? previous.snapshot.graph.nodes.find(candidate => candidate.id === node.id)?.data.result : undefined)
          if (affected.has(node.id) || !result) return node
          reusedOutputs.push(job ? { nodeId: node.id, jobId: job.id, runId: row.currentRunId } : inherited)
          return { ...node, data: { ...node.data, ...vdNodeResultPayload(result), result, frozen: true } }
        })
        row.reusedOutputs = reusedOutputs
      } else row.reusedOutputs = []
      let plan
      try {
        if (snapshot.graph.nodes.some(node => node.data.kind === 'batch-input' && !node.data.frozen)) throw new Error('Quality iterations currently require a single workflow execution. Run case batches with the canvas batch controls.')
        plan = planVdRun(snapshot.graph, { mode: 'all' })
      }
      catch (error) { row.state = 'needs-revision'; row.reason = `Validation failed: ${String(error.message).slice(0, 300)}`; return this.save(row) }
      if (row.reservedJobs + plan.nodeIds.length > row.maxJobs) return this.stop(row, 'Provider-job budget exhausted before scheduling work.')
      row.iterations++; row.reservedJobs += plan.nodeIds.length; row.currentRunId = randomUUID(); row.state = 'submitting'
      await this.save(row)
      try {
        await this.call('vd-runs/submit', { projectId: project.id, qualityPlanId: row.id, expectedDraftRevision: row.draftRevision, runIds: [row.currentRunId], snapshot,
          options: { mode: 'all', batchSize: 1 } })
        row.state = 'running'
      } catch (error) {
        // An error response can arrive after the scheduler durably accepted a
        // run. Retain its watcher and reconcile that ID instead of resubmitting.
        const submitted = await this.store.getVdRun(project.id, row.currentRunId).catch(() => null)
        row.state = submitted ? 'running' : 'stopped'; row.reason = `Submission response: ${String(error.message).slice(0, 300)}`
      }
      return this.save(row)
    }
    const run = await this.store.getVdRun(project.id, row.currentRunId)
    if (running(run)) return publicPlan(row)
    const jobs = await this.store.listVdRunJobs(project.id, row.currentRunId)
    const graph = run.snapshot.graph
    const checks = row.criteria.map(check => {
      if (check.type === 'perceptual') return { id: check.id, verdict: 'unknown', reason: 'Explicit sampled evidence is required.' }
      let passed
      if (check.type === 'graph-valid') { try { planVdRun(graph, { mode: 'all' }); passed = true } catch { passed = false } }
      if (check.type === 'run-completed') passed = run.status === 'completed'
      if (check.type === 'node-count') passed = graph.nodes.length >= check.min
      if (check.type === 'artifact-count') {
        const reused = graph.nodes.filter(node => node.data.frozen && node.data.result).reduce((count, node) => count + (node.data.result.kind === 'assets' ? node.data.result.assets.length : 1), 0)
        passed = (run.artifactCount ?? 0) + reused >= check.min
      }
      if (check.type === 'text-includes') {
        const job = jobs.find(job => job.nodeId === check.nodeId)
        const text = job?.result?.text ?? graph.nodes.find(node => node.id === check.nodeId)?.data.text
        passed = typeof text === 'string' && text.includes(check.text)
      }
      return { id: check.id, verdict: passed ? 'pass' : 'fail', source: 'deterministic', evidence: [{ runId: run.id }], reason: `${check.type}: ${passed ? 'satisfied' : 'not satisfied'}` }
    })
    // Failed execution is never accepted merely because an unrelated check passed.
    checks.push({ id: '$execution', verdict: run.status === 'completed' ? 'pass' : 'fail', source: 'deterministic', reason: `Run ${run.status}`, evidence: [{ runId: run.id }] })
    row.reports.push({ iteration: row.iterations, runId: run.id, draftRevision: row.draftRevision, createdAt: new Date().toISOString(), checks, reusedOutputs: row.reusedOutputs ?? [] })
    return this.decide(row)
  }
  async decide(row) {
    const report = row.reports.at(-1)
    report.score = report.checks.filter(check => check.verdict === 'pass').length / report.checks.length
    const best = row.reports.reduce((best, candidate) => !best || candidate.score > best.score ? candidate : best, null)
    row.best = { runId: best.runId, iteration: best.iteration, score: best.score, draftRevision: best.draftRevision }
    if (report.checks.every(check => check.verdict === 'pass')) { row.state = 'accepted'; row.reason = 'All recorded criteria passed.' }
    else if (report.checks.some(check => ['unknown', 'needs-human'].includes(check.verdict))) row.state = 'inspecting'
    else if (row.iterations >= row.maxIterations) { row.state = 'stopped'; row.reason = 'Iteration budget exhausted.' }
    else if (row.reports.length >= 2 && report.score <= row.reports.at(-2).score) { row.state = 'stopped'; row.reason = 'No measured improvement; best prior result retained.' }
    else row.state = 'needs-revision'
    return this.save(row)
  }
}
