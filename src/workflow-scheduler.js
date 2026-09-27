import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DirectorInputError, jsonValue, record, uuid } from './validation.js'
import { planVdRun, prepareNodeRequest, isTriggerNodeKind, nodeDefinition,
  hasReusableNodeOutput, vdNodeResultPayload, recomputeSinkPayloads,
  materializeBatchCase, collectBatchArtifacts, resolveEdgePorts } from '../lib/workflow-execution.js'

const active = run => ['queued', 'running'].includes(run.status)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()

/** Owns the entire lifetime of accepted graph runs, independently of RPC connections. */
export class WorkflowScheduler {
  constructor({ store, jobs, providers, workflows, nodes, call }) {
    Object.assign(this, { store, jobs, providers, workflows, nodes, call })
    this.pending = new Map()
    this.current = null
    this.closed = false
    this.sequence = Date.now() * 1000
  }

  catalog() {
    return { providers: this.providers.publicCatalog(), workflows: this.workflows.list(), nodeDefinitions: this.nodes.list() }
  }

  async recover() {
    const runs = (await Promise.all((await this.store.listProjects()).map(project => this.store.listVdRuns(project.id)))).flat()
    for (const run of runs.sort((a, b) => (a.queueSequence ?? 0) - (b.queueSequence ?? 0))) {
      this.sequence = Math.max(this.sequence, run.queueSequence ?? 0)
      if (run.scheduler !== 'host' || run.status !== 'queued') continue
      this.pending.set(run.id, run)
      this.jobs.runQueue.register(run)
    }
    this.wake()
  }

  async submit(input) {
    if (this.closed) throw new Error('The workflow scheduler is shutting down.')
    const projectId = uuid(input.projectId, 'projectId')
    const project = await this.store.getProject(projectId)
    const snapshot = record(jsonValue(input.snapshot, 'workflow snapshot', 32 * 1024 * 1024), 'snapshot')
    const options = record(input.options ?? {}, 'options')
    const count = options.batchSize ?? 1
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new DirectorInputError('Batch size must be an integer from 1 to 20.')
    const ids = input.runIds
    if (!Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count) throw new DirectorInputError('Supply one unique run ID per repetition.')
    ids.forEach(id => uuid(id, 'runId'))
    const source = { ...project, ...snapshot }
    const plan = planVdRun(source.graph, options)
    this.validateFrozen(source.graph, plan)
    const batch = input.batch
    if (batch && count !== 1) throw new DirectorInputError('Case batches cannot be repeated.')
    if (batch) {
      const node = source.graph.nodes.find(node => node.id === batch.nodeId)
      if (node?.data.kind !== 'batch-input' || node.data.frozen) throw new DirectorInputError('Choose an unfrozen Batch Input node.')
      if (source.graph.nodes.some(node => node.data.kind === 'batch-input' && !node.data.frozen && node.id !== batch.nodeId)) throw new DirectorInputError('Use one active Batch Input per workflow.')
      if (!Array.isArray(batch.rows) || !batch.rows.length || batch.rows.length > 1000) throw new DirectorInputError('Invalid batch cases.')
      for (const row of batch.rows) {
        for (const edge of source.graph.edges.filter(edge => edge.source === batch.nodeId)) {
          const target = source.graph.nodes.find(node => node.id === edge.target)
          if (target?.data.frozen) continue
          const ports = resolveEdgePorts(source.graph, this.nodes.list(), edge)
          if (!ports.targetTypes.includes('flow') && !ports.targetTypes.includes(row.input?.asset?.kind ?? 'text')) throw new DirectorInputError(`Case ${row.caseIndex} is incompatible with ${target?.data.title}.`)
        }
      }
    }
    const submissionHash = digest({ snapshot, options, ids, batch })
    const existing = await this.store.listVdRuns(projectId)
    if (existing.some(run => ids.includes(run.id))) {
      const found = ids.map(id => existing.find(run => run.id === id))
      if (found.some(run => !run || run.submissionHash !== submissionHash)) throw new DirectorInputError('Run IDs already belong to a different submission.')
      return { runs: found }
    }
    if (batch && existing.some(run => run.kind === 'batch' && run.batchInputNodeId === batch.nodeId && active(run))) throw new DirectorInputError('This Batch Input already has a queued or running batch.')
    const created = []
    try {
      for (const [repeatIndex, id] of ids.entries()) {
        const run = { id, projectId, scheduler: 'host', submissionHash, queueSequence: ++this.sequence,
          workflowName: source.name, mode: options.mode, batchSize: 1, nodeIds: plan.nodeIds,
          totalJobs: plan.nodeIds.length, completedJobs: 0, status: 'queued', startedAt: now(), queuedAt: now(),
          execution: { selectedNodeIds: options.selectedNodeIds, repeatIndex, sourceRevision: project.revision },
          ...(batch ? { kind: 'batch', batchInputNodeId: batch.nodeId, batchSize: batch.rows.length,
            startIndex: batch.rows[0].caseIndex, endIndex: batch.rows.at(-1).caseIndex,
            totalJobs: plan.nodeIds.length * batch.rows.length, completedCases: 0, failedCases: 0 } : {}) }
        created.push(await this.store.saveVdRun(projectId, run, snapshot))
        if (batch) await this.store.initializeBatchCases(projectId, id, batch.rows)
      }
    } catch (error) {
      for (const run of created) await this.store.saveVdRun(projectId, { ...run, status: 'failed', error: error.message, completedAt: now() })
      throw error
    }
    // Reserve the entire submission before executing any part of it or replying.
    for (const run of created) { this.pending.set(run.id, run); this.jobs.runQueue.register(run) }
    this.wake()
    return { runs: created }
  }

  validateFrozen(graph, plan) {
    for (const id of plan.frozenNodeIds) {
      const node = graph.nodes.find(node => node.id === id)
      if (!['save', 'batch-output'].includes(node.data.kind) && !isTriggerNodeKind(node.data.kind)
        && (node.data.kind !== 'preview' || graph.edges.some(edge => edge.source === id)) && !hasReusableNodeOutput(node)) {
        throw new DirectorInputError(`Frozen node has no reusable result: ${node.data.title}. Unfreeze and run it first.`)
      }
    }
  }

  async resume(projectId, runId) {
    const { snapshot, ...run } = await this.store.getVdRun(projectId, runId)
    if (run.scheduler !== 'host' || run.kind !== 'batch' || active(run)) throw new DirectorInputError('Choose a finished case batch to resume.')
    const rows = await this.store.listBatchCases(projectId, runId)
    if (!rows.some(row => row.status !== 'completed')) throw new DirectorInputError('All cases are already complete.')
    if (rows.some(row => row.status === 'running' || row.uncertain || row.jobs.some(job => job.errorCode === 'video-director/remote-cancel-failed' || ['orphaned', 'queued', 'running'].includes(job.status)))) {
      throw new DirectorInputError('Resolve the uncertain remote jobs before retrying this batch.')
    }
    const saved = await this.store.saveVdRun(projectId, { ...run, status: 'queued', cancelRequested: false,
      error: undefined, completedAt: undefined, executionStartedAt: undefined, queuedAt: now(), queueSequence: ++this.sequence })
    this.jobs.runQueue.cancelled.delete(runId)
    this.pending.set(runId, saved); this.jobs.runQueue.register(saved); this.wake()
    return { runs: [saved] }
  }

  wake() {
    if (this.closed || this.current || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, 20)
  }

  async pump() {
    if (this.closed || this.current) return
    const id = this.jobs.runQueue.head(this.jobs.jobs)
    const run = this.pending.get(id)
    if (!run) { if (this.pending.size) { this.timer = setTimeout(() => { this.timer = null; void this.pump() }, 100) } return }
    this.pending.delete(id)
    const controller = new AbortController()
    this.current = { run, controller }
    this.work = this.execute(run, controller).catch(async error => {
      // A disk error must not leave an unhandled rejection or silently release unfinished work.
      this.lastError = error.message
      try { await this.save(run, { status: 'failed', completedAt: now(), error: error.message }) } catch { /* Leave durable state for conservative restart recovery. */ }
    }).finally(() => { this.current = null; this.work = null; this.wake() })
    await this.work
  }

  async save(run, patch) {
    Object.assign(run, patch)
    const saved = await this.store.saveVdRun(run.projectId, run)
    this.jobs.runQueue.register(saved)
    return saved
  }

  async execute(run, controller) {
    try {
      const stored = await this.store.getVdRun(run.projectId, run.id)
      const project = await this.store.getProject(run.projectId)
      const source = { ...project, ...stored.snapshot }
      const plan = planVdRun(source.graph, { mode: run.mode, selectedNodeIds: run.execution?.selectedNodeIds })
      controller.signal.throwIfAborted()
      await this.save(run, { status: 'running', executionStartedAt: now() })
      if (run.kind === 'batch') await this.executeBatch(run, source, plan, controller)
      else {
        await this.executeGraph(run, source, plan, controller)
        controller.signal.throwIfAborted()
        await this.save(run, { status: 'completed', completedAt: now() })
      }
    } catch (error) {
      const related = [...this.jobs.jobs.values()].filter(job => (job.workflowRunId === run.id || job.batchRunId === run.id))
      const cleanupFailed = related.some(job => job.errorCode === 'video-director/remote-cancel-failed')
      await this.save(run, { status: controller.signal.aborted && !cleanupFailed ? 'cancelled' : 'failed',
        completedAt: now(), error: error.message })
    }
  }

  async executeGraph(run, source, plan, controller, row) {
    let graph = structuredClone(source.graph)
    const catalog = this.catalog()
    graph.nodes = recomputeSinkPayloads(graph.nodes, graph.edges, catalog.nodeDefinitions)
    for (const stage of plan.stages) {
      controller.signal.throwIfAborted()
      const outcomes = await Promise.allSettled(stage.map(async nodeId => {
        const node = graph.nodes.find(node => node.id === nodeId)
        if (isTriggerNodeKind(node.data.kind)) {
          const definition = nodeDefinition(node.data, catalog.nodeDefinitions)
          const action = node.data.kind === 'vram-trigger' ? node.data.vramAction ?? 'skip' : definition?.triggerAction ?? node.data.kind
          await this.call('triggers/run', { action, releaseWaitSeconds: node.data.vramReleaseWaitSeconds ?? 10 }, controller.signal)
          return null
        }
        const seed = row ? row.seeds[nodeId] : node.data.seedControlAfterGenerate !== 'randomize' && Number.isSafeInteger(node.data.seed)
          ? (node.data.seed + (run.execution?.repeatIndex ?? 0)) % 2_147_483_648 : undefined
        const prepared = prepareNodeRequest({ ...source, graph }, nodeId, catalog, {
          workflowRunId: run.id, workflowRunMode: run.mode, seed,
          ...(row ? { batchRunId: row.batchRunId, caseId: row.caseId, caseIndex: row.caseIndex } : {}) })
        controller.signal.throwIfAborted()
        let receipt
        try {
          ;({ job: receipt } = await this.call('jobs/start', { projectId: run.projectId, nodeId, clientRunId: randomUUID(),
            snapshot: { version: 1, sourceRevision: run.execution?.sourceRevision ?? source.revision,
              nodeType: prepared.node.data.nodeType, nodeVersion: prepared.node.data.nodeVersion, nodeDigest: prepared.node.data.nodeDigest,
              request: prepared.request } }))
        } catch (error) {
          if (row && error.code !== 'video-director/invalid-input') {
            row.uncertain = true
            throw new Error(`Submission receipt is uncertain. Inspect this case's jobs before retrying. ${error.message}`)
          }
          throw error
        }
        if (row) { row.jobs.push(receipt); await this.store.saveBatchCase(run.projectId, row.batchRunId, row) }
        await this.store.saveVdRunJob(run.projectId, run.id, receipt)
        let job = receipt
        if (controller.signal.aborted) await this.jobs.cancel(run.projectId, job.id)
        // These timers live in the Node Host, never in a page/worker/request lifetime.
        while (active(job)) { await delay(100); job = await this.jobs.get(run.projectId, job.id) }
        await this.store.saveVdRunJob(run.projectId, run.id, job)
        return job
      }))
      const errors = []
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') { errors.push(outcome.reason.message); continue }
        const job = outcome.value
        if (!job) continue
        if (job.status === 'completed' && job.result) {
          const result = job.result
          const count = result.kind === 'assets' ? result.assets.length : 1
          run.artifactCount = (run.artifactCount ?? 0) + count
          if (count) {
            run.previewJobId = job.id
            run.previewResult = result.kind === 'assets' ? { ...result, assets: result.assets.slice(0, 1) }
              : { kind: 'text', providerId: result.providerId, text: (result.kind === 'text' ? result.text : JSON.stringify(result.result)).slice(0, 2048) }
          }
        }
        if (row) row.jobs = [...row.jobs.filter(item => item.id !== job.id), job]
        if (job.status === 'completed' && job.result) graph.nodes = graph.nodes.map(node => node.id === job.nodeId
          ? { ...node, data: { ...node.data, ...vdNodeResultPayload(job.result), result: job.result,
            outputSeed: job.seed ?? job.result.seed, status: 'completed', phase: 'completed', progress: 1,
            jobId: job.id, runStartedAt: job.startedAt, runCompletedAt: job.completedAt } } : node)
        else errors.push(job.error ?? job.status)
      }
      graph.nodes = recomputeSinkPayloads(graph.nodes, graph.edges, catalog.nodeDefinitions)
      if (row) {
        row.artifacts = collectBatchArtifacts(graph, catalog.nodeDefinitions)
        await this.store.saveBatchCase(run.projectId, row.batchRunId, row)
      }
      await this.save(run, { completedJobs: run.completedJobs + stage.length })
      if (errors.length) throw new Error(errors.join(' '))
    }
    return graph
  }

  async executeBatch(run, source, plan, controller) {
    const rows = await this.store.listBatchCases(run.projectId, run.id)
    const config = source.graph.nodes.find(node => node.id === run.batchInputNodeId).data.batch ?? {}
    for (const row of rows) {
      controller.signal.throwIfAborted()
      if (row.status === 'completed') continue
      const child = { id: randomUUID(), projectId: run.projectId, scheduler: 'host', workflowName: source.name,
        mode: run.mode, batchSize: 1, batchRunId: run.id, caseId: row.caseId, caseIndex: row.caseIndex,
        nodeIds: plan.nodeIds, totalJobs: plan.nodeIds.length, completedJobs: 0, status: 'running',
        startedAt: run.startedAt, queuedAt: run.queuedAt, executionStartedAt: now() }
      Object.assign(row, { status: 'running', attempt: row.attempt + 1, workflowRunId: child.id, jobs: [], artifacts: [], error: undefined })
      await this.store.saveBatchCase(run.projectId, run.id, row)
      const caseSource = { ...source, graph: materializeBatchCase(source.graph, run.batchInputNodeId, row) }
      await this.store.saveVdRun(run.projectId, child, caseSource)
      try {
        const graph = await this.executeGraph(child, caseSource, plan, controller, row)
        controller.signal.throwIfAborted()
        row.artifacts = collectBatchArtifacts(graph, this.nodes.list()); row.status = 'completed'
        await this.save(child, { status: 'completed', completedAt: now() })
      } catch (error) {
        const uncertain = row.jobs.some(job => job.errorCode === 'video-director/remote-cancel-failed')
        row.status = controller.signal.aborted && !uncertain ? 'cancelled' : 'failed'; row.error = error.message
        await this.save(child, { status: row.status, completedAt: now(), error: row.error })
        if (config.errorPolicy !== 'continue' || controller.signal.aborted || uncertain || row.uncertain) throw error
      } finally {
        await this.store.saveBatchCase(run.projectId, run.id, row)
        await this.save(run, { completedCases: rows.filter(row => row.status === 'completed').length,
          failedCases: rows.filter(row => row.status === 'failed').length,
          completedJobs: rows.reduce((sum, row) => sum + (row.status === 'completed' ? plan.nodeIds.length : row.jobs.filter(job => !active(job)).length), 0) })
      }
    }
    const failed = rows.filter(row => row.status === 'failed').length
    await this.save(run, { status: failed ? 'failed' : 'completed', completedAt: now(), error: failed ? `${failed} case(s) failed. Resume to retry them with the same inputs and seeds.` : undefined })
  }

  async cancel(projectId, runId) {
    const stored = await this.store.getVdRun(projectId, runId)
    const id = stored.batchRunId ?? runId
    const current = this.current?.run.id === id ? this.current : null
    const pending = this.pending.get(id)
    if (!current && !pending) return { cancelled: true }
    this.jobs.runQueue.cancelled.add(id)
    if (current) {
      current.run.cancelRequested = true
      current.controller.abort(new Error('vd-run was cancelled.'))
      await this.save(current.run, { cancelRequested: true })
      await Promise.all([...this.jobs.jobs.values()].filter(job => job.projectId === projectId
        && (job.workflowRunId === id || job.batchRunId === id) && active(job)).map(job => this.jobs.cancel(projectId, job.id)))
    } else {
      this.pending.delete(id)
      await this.save(pending, { status: 'cancelled', cancelRequested: true, completedAt: now() })
    }
    this.wake()
    return { cancelled: true }
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    if (this.current) await this.cancel(this.current.run.projectId, this.current.run.id)
    await this.work
  }
}
