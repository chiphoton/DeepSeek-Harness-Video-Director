import type { DirectorNodeData } from './types'

/** The node footer treats a submitted job as idle until execution starts. */
export function nodeStatus(data: DirectorNodeData): 'idle' | 'running' | 'completed' | 'failed' | 'FROZEN' {
  if (data.frozen === true) return 'FROZEN'
  return data.status === 'queued' ? 'idle' : data.status ?? 'idle'
}

/** Format local completion time without relying on locale-dependent date ordering. */
export function completionDetails(data: DirectorNodeData): { time: string; seconds?: string } | undefined {
  if (data.runCompletedAt === undefined) return undefined
  const end = new Date(data.runCompletedAt)
  if (!Number.isFinite(end.getTime())) return undefined
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(end.getMonth() + 1)}${pad(end.getDate())}-${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}`
  const start = data.runStartedAt === undefined ? NaN : Date.parse(data.runStartedAt)
  const elapsed = end.getTime() - start
  return { time, seconds: Number.isFinite(elapsed) && elapsed >= 0 ? (elapsed / 1_000).toFixed(1) : undefined }
}

/** Execution phases add detail only when they do not repeat a status word. */
export function progressDescription(data: DirectorNodeData): { phase?: string; percent?: string } {
  const phase = data.phase?.trim()
  return {
    phase: phase && !['idle', 'queued', 'running', 'completed', 'failed', 'frozen'].includes(phase.toLowerCase()) ? phase : undefined,
    percent: typeof data.progress === 'number' && Number.isFinite(data.progress)
      ? `${Math.round(Math.max(0, Math.min(1, data.progress)) * 100)}%` : undefined,
  }
}
