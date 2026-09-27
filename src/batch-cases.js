import { DirectorInputError, jsonValue, oneOf, record, string, uuid } from './validation.js'

export const MAX_BATCH_CASES = 1000

export function validateBatchCase(value, projectId, batchRunId, assetLookup) {
  const row = record(jsonValue(value, 'batch case', 16 * 1024 * 1024), 'batch case')
  uuid(row.caseId, 'caseId')
  if (row.batchRunId !== batchRunId) throw new DirectorInputError('case batchRunId does not match')
  if (!Number.isSafeInteger(row.caseIndex) || row.caseIndex < 1 || row.caseIndex > MAX_BATCH_CASES) throw new DirectorInputError('invalid caseIndex')
  if (!Number.isSafeInteger(row.attempt) || row.attempt < 0) throw new DirectorInputError('invalid case attempt')
  oneOf(row.status, 'case status', ['pending', 'running', 'completed', 'failed', 'cancelled'])
  if (row.uncertain !== undefined && typeof row.uncertain !== 'boolean') throw new DirectorInputError('invalid uncertain submission flag')
  if (row.workflowRunId !== undefined) uuid(row.workflowRunId, 'workflowRunId')
  const input = record(row.input, 'case input')
  string(input.id, 'input.id', { min: 1, max: 256 })
  string(input.name, 'input.name', { min: 1, max: 1024 })
  if (input.text !== undefined) string(input.text, 'input.text', { max: 100_000, trim: false })
  const asset = value => {
    const ref = assetLookup(uuid(value?.id, 'asset.id'))
    if (ref.projectId !== projectId) throw new DirectorInputError('batch asset belongs to another project')
    return ref
  }
  if (input.asset !== undefined) input.asset = asset(input.asset)
  if (input.asset === undefined && typeof input.text !== 'string') throw new DirectorInputError('case requires text or an asset')
  for (const seed of Object.values(record(row.seeds, 'case seeds'))) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new DirectorInputError('invalid case seed')
  }
  if (!Array.isArray(row.jobs) || row.jobs.length > 2000 || !Array.isArray(row.artifacts) || row.artifacts.length > 10_000) throw new DirectorInputError('invalid case results')
  for (const job of row.jobs) {
    if (job.projectId !== projectId || job.batchRunId !== batchRunId || job.caseId !== row.caseId || job.caseIndex !== row.caseIndex || job.workflowRunId !== row.workflowRunId) throw new DirectorInputError('job does not belong to this case attempt')
    // Persist public job receipts only, never provider requests or credentials.
    delete job.request
    delete job.controller
  }
  row.artifacts = row.artifacts.map(value => {
    const item = record(value, 'case artifact')
    for (const key of ['outputNodeId', 'sourceNodeId', 'sourcePortId']) string(item[key], key, { min: 1, max: 256 })
    if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0) throw new DirectorInputError('invalid artifact ordinal')
    if (item.asset !== undefined) item.asset = asset(item.asset)
    if (item.text !== undefined) string(item.text, 'artifact.text', { max: 1_000_000, trim: false })
    if (item.asset === undefined && item.text === undefined) throw new DirectorInputError('empty batch artifact')
    return item
  })
  return row
}

export function caseIdentity(row) {
  return JSON.stringify([row.caseId, row.batchRunId, row.caseIndex, row.input, row.seeds])
}
