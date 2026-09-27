import type { BatchArtifact, BatchCase, BatchInputConfig, BatchItem, DirectorGraph, DirectorNodeData, VdNodeDefinitionDescriptor } from './types'
import { isExecutableVdNodeKind } from './workflow-runner'
import { resolveEdgePorts } from './ports'

export const MAX_BATCH_CASES = 1000

export function batchSourceItems(config: BatchInputConfig): BatchItem[] {
  const items = config.source === 'files' ? config.items ?? [] : (config.text ?? '').split(/\r?\n/u)
    .map((text, index) => ({ id: `line-${index + 1}`, name: `Text ${index + 1}`, text }))
    .filter(item => item.text.trim() !== '')
  if (items.length > MAX_BATCH_CASES) throw new Error(`A batch accepts at most ${MAX_BATCH_CASES} cases.`)
  return items
}

/** Run user regexes off the UI thread; even a pathological pattern is cancellable. */
export async function matchBatchItems(items: BatchItem[], config: BatchInputConfig): Promise<BatchItem[]> {
  const eligible = items.filter(item => config.recursive !== false || !(item.relativePath ?? item.name).includes('/'))
  const pattern = config.pattern ?? ''
  if (pattern.length > 256) throw new Error('Regex must contain at most 256 characters.')
  // Validate syntax before creating a worker, including for an empty list.
  const regex = new RegExp(pattern, 'u')
  let matches: number[]
  if (pattern === '') matches = eligible.map((_, index) => index)
  else if (typeof Worker === 'undefined') {
    // Non-browser callers (offline tools/tests) only. The app always uses a worker.
    matches = eligible.flatMap((item, index) => regex.test(item.relativePath ?? item.name) ? [index] : [])
  } else {
    const url = URL.createObjectURL(new Blob([`onmessage = e => {
      try { const re = new RegExp(e.data.pattern, 'u'); postMessage({ indices: e.data.names.flatMap((name, i) => re.test(name) ? [i] : []) }); }
      catch (error) { postMessage({ error: String(error) }); }
    }`], { type: 'text/javascript' }))
    try {
      matches = await new Promise<number[]>((resolve, reject) => {
        const worker = new Worker(url)
        const finish = (indices?: number[], error?: string): void => {
          clearTimeout(timer); worker.terminate()
          if (error) reject(new Error(error)); else resolve(indices!)
        }
        const timer = setTimeout(() => finish(undefined, 'Regex took too long. Simplify the pattern.'), 1000)
        worker.onmessage = event => finish(event.data.indices, event.data.error)
        worker.onerror = () => finish(undefined, 'Could not evaluate the regex.')
        worker.postMessage({ pattern, names: eligible.map(item => item.relativePath ?? item.name) })
      })
    } finally { URL.revokeObjectURL(url) }
  }
  const result = matches.map(index => eligible[index])
  if (config.sort === 'name') {
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    result.sort((a, b) => {
      const left = a.relativePath ?? a.name; const right = b.relativePath ?? b.name
      return collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0)
    })
  }
  return result
}

export function batchRange(config: BatchInputConfig, count: number): { start: number; end: number } {
  const start = config.startIndex ?? 1
  const end = config.endIndex ?? count
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > count) {
    throw new Error(`Use an inclusive range with 1 ≤ start ≤ end ≤ ${count}.`)
  }
  return { start, end }
}

export function caseSeed(data: DirectorNodeData, offset: number, random = (): number => {
  const bytes = new Uint32Array(1); crypto.getRandomValues(bytes); return bytes[0] & 0x7fffffff
}): number {
  const policy = data.seedControlAfterGenerate ?? 'fixed'
  const base = data.seed ?? (policy === 'randomize' ? 0 : random())
  const seed = policy === 'randomize' ? random() : policy === 'increment' ? base + offset : policy === 'decrement' ? base - offset : base
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`${data.title}: seed is outside the supported safe-integer range.`)
  return seed
}

export function materializeBatchCase(graph: DirectorGraph, inputNodeId: string, row: BatchCase): DirectorGraph {
  const copy = structuredClone(graph)
  copy.nodes = copy.nodes.map(node => {
    if (node.id === inputNodeId) {
      return { ...node, data: { ...node.data, text: row.input.text, asset: row.input.asset,
        assets: row.input.asset ? [row.input.asset] : undefined, mediaKind: row.input.asset?.kind ?? 'text',
        result: undefined, status: 'completed', batchCaseIndex: row.caseIndex } }
    }
    if (node.data.frozen || (!isExecutableVdNodeKind(node.data.kind) && !['preview', 'save', 'batch-output'].includes(node.data.kind))) return node
    const { asset: _asset, assets: _assets, text: _text, result: _result, outputSeed: _seed, jobId: _job,
      derivedFrom: _derived, error: _error, phase: _phase, runStartedAt: _start, runCompletedAt: _end, ...data } = node.data
    return { ...node, data: { ...data, status: 'idle', progress: undefined } }
  })
  return copy
}

/** Resolve each edge separately so equal artifacts on different ports/cases retain identity. */
export function collectBatchArtifacts(graph: DirectorGraph, definitions: VdNodeDefinitionDescriptor[]): BatchArtifact[] {
  const artifacts: BatchArtifact[] = []
  for (const output of graph.nodes.filter(node => node.data.kind === 'batch-output' && !node.data.frozen)) {
    for (const edge of graph.edges.filter(edge => edge.target === output.id)) {
      const source = graph.nodes.find(node => node.id === edge.source)
      if (!source) continue
      const ports = resolveEdgePorts(graph, definitions, edge)
      const types = ports.sourceTypes.filter(type => ports.targetTypes.includes(type))
      const assets = source.data.assets ?? (source.data.asset ? [source.data.asset] : [])
      const common = { outputNodeId: output.id, sourceNodeId: source.id, sourcePortId: ports.sourcePortId,
        seed: source.data.outputSeed ?? (typeof source.data.result === 'object' && source.data.result !== null && 'seed' in source.data.result && typeof source.data.result.seed === 'number' ? source.data.result.seed : undefined), reused: source.data.frozen === true }
      for (const asset of assets.filter(asset => types.includes(asset.kind))) {
        artifacts.push({ ...common, ordinal: artifacts.filter(item => item.outputNodeId === output.id && item.sourceNodeId === source.id && item.sourcePortId === ports.sourcePortId).length, asset })
      }
      if (types.includes('text') && source.data.text !== undefined) {
        artifacts.push({ ...common, ordinal: assets.length, text: source.data.text })
      }
    }
  }
  return artifacts
}

export function batchFrozenWarnings(graph: DirectorGraph, inputNodeId: string): string[] {
  const seen = new Set([inputNodeId]); const pending = [inputNodeId]; const warnings: string[] = []
  while (pending.length) {
    const id = pending.shift()!
    for (const edge of graph.edges.filter(edge => edge.source === id)) {
      if (seen.has(edge.target)) continue
      seen.add(edge.target)
      const target = graph.nodes.find(node => node.id === edge.target)
      if (target?.data.frozen) warnings.push(`${target.data.title} is FROZEN: it reuses its captured output for every case.`)
      else pending.push(edge.target)
    }
  }
  return warnings
}
