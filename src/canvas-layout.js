import { nodePorts, portHandleId } from '../lib/workflow-execution.js'
import { fault } from './workspace-files.js'

const COLUMN_GAP = 128
const ROW_GAP = 72
const stagePrefix = /^Stage\s+\d+\s*:\s*/i
const titleForKind = kind => kind.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ')

// Reserve extra room for cards that have not been mounted in a view yet.
function fallbackSize(node, definition) {
  const kind = node.data.kind
  if (kind.startsWith('load-')) return { width: 330, height: kind === 'load-video' || kind === 'load-sketch' ? 680 : 500 }
  if (kind === 'preview' || kind === 'save') return { width: 360, height: 540 }
  if (kind.startsWith('batch-')) return { width: 390, height: 880 }
  if (['vram-trigger', 'ollama-eject', 'comfyui-clear'].includes(kind)) return { width: 350, height: 420 }
  return { width: 390, height: Math.max(820, 420 + (definition?.fields?.length ?? 0) * 36) }
}

function handleOffsets(node, definitions, direction, measured, height) {
  const ports = nodePorts(node, definitions, direction)
  // Connected field controls render above embedded reference thumbnails.
  const order = direction === 'input' ? [...ports].sort((a, b) => Number(b.id.startsWith('field:')) - Number(a.id.startsWith('field:'))) : ports
  return new Map(order.map((port, index) => {
    const handle = portHandleId(direction, port, ports)
    return [handle, (measured?.get(handle) ?? height * (index + 1) / (order.length + 1)) / height]
  }))
}

function ranksFor(nodes, links) {
  const queue = nodes.filter(node => node.in.length === 0)
  const pending = new Map(nodes.map(node => [node, node.in.length]))
  const layers = []
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    const layer = layers[node.rank] ??= []
    layer.push(node)
    for (const { target } of node.out) {
      target.rank = Math.max(target.rank, node.rank + 1)
      const remaining = pending.get(target) - 1
      pending.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  if (queue.length !== nodes.length || links.some(edge => edge.source.rank >= edge.target.rank)) {
    throw fault('invalid-layout', 'Resolve circular connections before arranging the canvas.')
  }
  return layers
}

function place(layers) {
  let x = 0
  for (const layer of layers) {
    let y = 0, width = 0
    for (const node of layer) {
      node.x = x; node.y = y
      width = Math.max(width, node.width)
      y += node.height + ROW_GAP
    }
    x += width + COLUMN_GAP
  }
}

function inversions(values) {
  if (values.length < 2) return 0
  const middle = values.length >> 1
  const left = values.slice(0, middle), right = values.slice(middle)
  let count = inversions(left) + inversions(right), a = 0, b = 0
  for (let i = 0; i < values.length; i++) {
    if (b === right.length || (a < left.length && left[a] <= right[b])) values[i] = left[a++]
    else { values[i] = right[b++]; count += left.length - a }
  }
  return count
}

const sourceY = link => link.source.y + link.from * link.source.height
const targetY = link => link.target.y + link.to * link.target.height

function crossings(links) {
  const bundles = new Map()
  for (const link of links) {
    const key = `${link.source.rank}:${link.target.rank}`
    if (!bundles.has(key)) bundles.set(key, [])
    bundles.get(key).push([sourceY(link), targetY(link)])
  }
  let count = 0
  for (const pairs of bundles.values()) {
    pairs.sort(([a, b], [c, d]) => a - c || b - d)
    count += inversions(pairs.map(([, y]) => y))
  }
  return count
}

function sweep(layers, forward) {
  for (let i = forward ? 1 : layers.length - 2; forward ? i < layers.length : i >= 0; i += forward ? 1 : -1) {
    const layer = layers[i]
    const score = new Map(layer.map(node => {
      const links = forward ? node.in : node.out
      return [node, links.length ? links.reduce((sum, link) => sum + (forward ? sourceY(link) : targetY(link)), 0) / links.length : node.y + node.height / 2]
    }))
    layer.sort((a, b) => score.get(a) - score.get(b))
    let y = 0
    for (const node of layer) { node.y = y; y += node.height + ROW_GAP }
  }
}

/** Compute positions and title changes only. The graph is never modified here. */
export function planCanvasLayout(graph, definitions, geometry, { stageTitles = false, titles = new Map() } = {}) {
  const definitionsByType = new Map(definitions.map(row => [`${row.type}:${row.version}`, row]))
  const byId = new Map(graph.nodes.map(node => {
    const measured = geometry?.get(node.id)
    const size = measured ?? fallbackSize(node, definitionsByType.get(`${node.data.nodeType}:${node.data.nodeVersion ?? '1.0.0'}`))
    return [node.id, { node, measured: measured !== undefined, width: Math.ceil(size.width), height: Math.ceil(size.height),
      input: handleOffsets(node, definitions, 'input', measured?.inputs, size.height),
      output: handleOffsets(node, definitions, 'output', measured?.outputs, size.height), in: [], out: [], rank: 0, x: 0, y: 0 }]
  }))
  const nodes = [...byId.values()], links = []
  for (const edge of graph.edges) {
    const source = byId.get(edge.source), target = byId.get(edge.target)
    if (!source || !target) throw fault('invalid-layout', 'Resolve missing connection endpoints before arranging the canvas.')
    const link = { source, target, from: source.output.get(edge.sourceHandle ?? 'out') ?? .5, to: target.input.get(edge.targetHandle ?? 'in') ?? .5 }
    source.out.push(link); target.in.push(link); links.push(link)
  }
  const layers = ranksFor(nodes, links)
  for (const layer of layers) layer.sort((a, b) => (a.node.position?.y ?? 0) - (b.node.position?.y ?? 0))
  place(layers)
  const originalScore = crossings(links)
  let best = layers.map(layer => [...layer]), bestScore = originalScore
  for (let pass = 0; pass < 4 && bestScore > 0; pass++) {
    sweep(layers, pass % 2 === 0)
    const score = crossings(links)
    if (score < bestScore) { best = layers.map(layer => [...layer]); bestScore = score }
  }
  place(best)
  // Retain the original top-left anchor so the canvas does not jump off screen.
  const originX = nodes.length ? Math.min(...nodes.map(row => row.node.position?.x ?? 0)) : 0
  const originY = nodes.length ? Math.min(...nodes.map(row => row.node.position?.y ?? 0)) : 0
  const changes = [], counts = { moved: 0, renamed: 0 }
  for (const row of nodes) {
    const { id, data, position } = row.node
    const nextPosition = { x: originX + row.x, y: originY + row.y }
    const proposed = titles.get(id) ?? data.title ?? titleForKind(data.kind)
    const title = stageTitles ? `Stage ${row.rank + 1}: ${proposed.replace(stagePrefix, '').trim() || titleForKind(data.kind)}` : proposed
    const moved = position?.x !== nextPosition.x || position?.y !== nextPosition.y
    const renamed = title !== data.title
    if (moved) counts.moved++
    if (renamed) counts.renamed++
    if (moved || renamed) changes.push({ id, ...(moved && { position: nextPosition }), ...(renamed && { title }) })
  }
  return { changes, ...counts, stages: layers.length, estimatedCrossings: bestScore, measuredNodes: nodes.filter(row => row.measured).length }
}
