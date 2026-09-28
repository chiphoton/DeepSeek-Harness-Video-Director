import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BatchInputConfig, BatchItem, DirectorNodeData } from './types'
import type { DirectorRuntimeValue } from './DirectorNode'
import { batchRange, batchSourceItems, matchBatchItems } from './batch'
import { batchArchive, downloadBatchArchive } from './batch-export'
import { ArtifactPreviewDialog, ArtifactThumbnail, previewArtifactFromAsset, previewArtifactFromText, type PreviewArtifact } from './ArtifactPreview'
import { t, useLanguage } from './i18n'
import { NumberInput } from './NumberInput'

type Props = { id: string; data: DirectorNodeData; runtime: DirectorRuntimeValue | null }

export function BatchInputBody({ id, data, runtime }: Props): ReactNode {
  useLanguage()
  const config = data.batch ?? { source: 'text' as const }
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<BatchItem[]>([])
  const [error, setError] = useState('')
  const [matchingError, setMatchingError] = useState('')
  const [busy, setBusy] = useState(false)
  const [matching, setMatching] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const runs = runtime?.batchRuns ?? []
  const run = runs.find(run => run.id === data.batchRunId) ?? runs.find(run => run.batchInputNodeId === id)
  const active = run?.status === 'queued' || run?.status === 'running'
  const locked = busy || runtime?.inputFilesBusy === true || active || data.frozen === true
  const update = (patch: Partial<BatchInputConfig>): void => runtime?.onChange(id, { batch: { ...config, ...patch } })
  const perform = async (work: () => Promise<unknown>): Promise<void> => {
    setError(''); setBusy(true)
    try { await work() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', '') }, [])
  useEffect(() => {
    let current = true
    setMatching(true)
    void (async () => {
      try {
        const matched = await matchBatchItems(batchSourceItems(config), config)
        if (current) { setItems(matched); setMatchingError('') }
      } catch (error) { if (current) { setItems([]); setMatchingError(String(error)) } }
      finally { if (current) setMatching(false) }
    })()
    return () => { current = false }
  }, [config.source, config.text, config.items, config.pattern, config.recursive, config.sort])
  let rangeError = ''
  try { batchRange(config, items.length) } catch (error) { rangeError = (error as Error).message }
  return <div className="vd-batch nodrag nowheel" onWheel={event => event.stopPropagation()}>
    <label>{t('Case source')}<select value={config.source} disabled={locked} onChange={event => update({ source: event.target.value as 'text' | 'files', endIndex: undefined })}>
      <option value="text">{t('Text — one case per line')}</option><option value="files">{t('Files or folder')}</option>
    </select></label>
    {config.source === 'text' ? <textarea aria-label={t('Batch text cases')} rows={4} value={config.text ?? ''} disabled={locked} onChange={event => update({ text: event.target.value })} placeholder={t('One prompt per line')} /> : <>
      <div className="vd-batch-actions"><button disabled={locked} onClick={() => files.current?.click()}>{t('Choose files')}</button><button disabled={locked} onClick={() => folder.current?.click()}>{t('Choose folder')}</button></div>
      <small>{t('Files are copied from this computer into project storage.')}</small>
    </>}
    <input ref={files} hidden type="file" multiple onChange={event => {
      const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''
      if (chosen.length) void perform(() => runtime!.onImportBatchFiles!(id, chosen, false))
    }} />
    <input ref={folder} hidden type="file" multiple onChange={event => {
      const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''
      if (chosen.length) void perform(() => runtime!.onImportBatchFiles!(id, chosen, true))
    }} />
    <label>{t('Filename regex')}<input value={config.pattern ?? ''} disabled={locked} placeholder="\\.(png|jpg)$" onChange={event => update({ pattern: event.target.value })} /></label>
    <div className="vd-batch-pair"><label>{t('Order')}<select value={config.sort ?? 'input'} disabled={locked} onChange={event => update({ sort: event.target.value as 'input' | 'name' })}><option value="input">{t('Input order')}</option><option value="name">{t('Natural filename order')}</option></select></label>
      <label className="vd-batch-check"><input type="checkbox" checked={config.recursive !== false} disabled={locked} onChange={event => update({ recursive: event.target.checked })} />{t('Include subfolders')}</label></div>
    <div className="vd-batch-pair"><label>{t('Start index')}<NumberInput integer min={1} step={1} value={config.startIndex ?? 1} disabled={locked} onValueCommit={value => update({ startIndex: value })} /></label>
      <label>{t('End index (inclusive)')}<NumberInput allowEmpty integer min={1} step={1} value={config.endIndex} placeholder={String(items.length)} disabled={locked} onValueCommit={value => update({ endIndex: value })} /></label></div>
    <label>{t('On case error')}<select value={config.errorPolicy ?? 'stop'} disabled={locked} onChange={event => update({ errorPolicy: event.target.value as 'stop' | 'continue' })}><option value="stop">{t('Stop batch')}</option><option value="continue">{t('Continue; keep failed index')}</option></select></label>
    <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{matching ? t('Matching…') : t('{0} matched cases · preview', items.length)}</button>
    {expanded ? <div className="vd-batch-table"><table><thead><tr><th>#</th><th>{t('Input')}</th></tr></thead><tbody>{items.map((item, index) => <tr key={item.id} className={index + 1 < (config.startIndex ?? 1) || index + 1 > (config.endIndex ?? items.length) ? 'vd-batch-excluded' : undefined}><td>{index + 1}</td><td title={item.text ?? item.relativePath ?? item.name}>{item.relativePath ?? item.name}{item.text !== undefined ? ` · ${item.text.slice(0, 80)}` : ''}</td></tr>)}</tbody></table></div> : null}
    {(runtime?.batchWarnings?.[id] ?? []).map(warning => <small key={warning} className="vd-batch-warning">{warning}</small>)}
    {matchingError || rangeError ? <small role="status">{matchingError || rangeError}</small> : null}
    <div className="vd-batch-actions">
      <button disabled={locked || matching || !!matchingError || !!rangeError} onClick={() => void perform(() => runtime!.onRunBatch!(id))}>{t('Run Batch')}</button>
      {run && !active && run.status !== 'completed' ? <button disabled={busy || data.frozen} onClick={() => void perform(() => runtime!.onRunBatch!(id, run.id))}>{t('Resume / retry failed')}</button> : null}
      {active ? <button onClick={() => { void runtime?.onCancelBatch?.(run.id).catch(error => setError(String(error))) }}>{t('Cancel batch')}</button> : null}
    </div>
    {run ? <small role="status">{t('Case {0} · {1}/{2} completed · {3} failed', data.batchCaseIndex ?? run.startIndex ?? 1, run.completedCases ?? 0, run.batchSize, run.failedCases ?? 0)} · {run.status}</small> : null}
    <small>{t('Keep this browser tab open while the batch runs. You can switch workflows.')}</small>
    {error ? <p className="vd-batch-error" role="alert">{error}</p> : null}
  </div>
}

export function BatchOutputBody({ id, data, runtime }: Props): ReactNode {
  useLanguage()
  const runs = runtime?.batchRuns ?? []
  const runId = data.batchRunId ?? (data.frozen ? undefined : runs[0]?.id)
  const rows = data.frozen ? (data.batchFrozenCase ? [data.batchFrozenCase] : []) : runId ? runtime?.batchCases?.[runId] : undefined
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const follow = data.batchFollow !== false
  const setFollow = (value: boolean): void => runtime?.onChange(id, { batchFollow: value })
  const [open, setOpen] = useState<PreviewArtifact | null>(null)
  const row = follow && !data.frozen ? (rows ? [...rows].reverse().find(row => row.status !== 'pending') : undefined) ?? rows?.[0]
    : rows?.find(row => row.caseIndex === data.batchCaseIndex) ?? rows?.[0]
  const artifacts = row?.artifacts.filter(artifact => artifact.outputNodeId === id) ?? []
  useEffect(() => {
    if (data.frozen || !runId || rows !== undefined || !runtime?.onLoadBatchCases) { setLoading(false); return }
    let current = true
    setLoading(true); setError('')
    void runtime.onLoadBatchCases(runId).catch(error => { if (current) setError(String(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [runId, rows])
  const save = async (all: boolean): Promise<void> => {
    if (!runId || !rows || !row) return
    setSaving(true); setError('')
    try { downloadBatchArchive(await batchArchive(all ? rows : [row], id), runId) }
    catch (error) { setError(String(error)) }
    finally { setSaving(false) }
  }
  const select = (index: number): void => { runtime?.onChange(id, { batchCaseIndex: index, batchFollow: false }) }
  const inputPreview = row?.input.asset ? previewArtifactFromAsset(row.input.asset) : row?.input.text === undefined ? undefined : previewArtifactFromText(row.input.text, row.input.name)
  return <div className="vd-batch nodrag nowheel" onWheel={event => event.stopPropagation()}>
    <label>{t('Batch run')}<select value={runId ?? ''} disabled={data.frozen} onChange={event => runtime?.onChange(id, { batchRunId: event.target.value, batchCaseIndex: undefined, batchFollow: true })}>
      {!runs.length ? <option value="">{t('Run a Batch Input to collect results')}</option> : null}
      {runs.map(run => <option key={run.id} value={run.id}>{run.startedAt.slice(0, 19).replace('T', ' ')} · {run.startIndex}–{run.endIndex} · {run.status}</option>)}
    </select></label>
    <div className="vd-batch-actions">
      <button disabled={!row || row.caseIndex === rows?.[0]?.caseIndex} onClick={() => row && select(row.caseIndex - 1)} aria-label={t('Previous case')}>←</button>
      <select aria-label={t('Case index')} value={row?.caseIndex ?? ''} onChange={event => select(Number(event.target.value))}>
        {(rows ?? []).map(row => <option key={row.caseId} value={row.caseIndex}>{row.caseIndex} · {row.input.name} · {row.status}</option>)}
      </select>
      <button disabled={!row || row.caseIndex === rows?.at(-1)?.caseIndex} onClick={() => row && select(row.caseIndex + 1)} aria-label={t('Next case')}>→</button>
    </div>
    <label className="vd-batch-check"><input type="checkbox" checked={follow && !data.frozen} disabled={data.frozen} onChange={event => setFollow(event.target.checked)} />{t('Follow current case')}</label>
    {loading ? <small>{t('Loading cases…')}</small> : null}
    {row ? <>
      <small>{t('Input')} · {row.input.relativePath ?? row.input.name} · {row.status}</small>
      {inputPreview ? <details><summary>{t('Preview input')}</summary><ArtifactThumbnail artifact={inputPreview} variant="node" onOpen={setOpen} /></details> : null}
      {artifacts.map((artifact, index) => <div key={`${row.caseId}:${index}`}>
        <ArtifactThumbnail artifact={artifact.asset ? previewArtifactFromAsset(artifact.asset) : previewArtifactFromText(artifact.text ?? '', `${row.caseIndex} · ${artifact.sourcePortId}`)} variant="node" onOpen={setOpen} />
        <small>{artifact.sourcePortId}{artifact.seed === undefined ? '' : ` · seed ${artifact.seed}`}{artifact.reused ? ' · FROZEN' : ''}</small>
      </div>)}
      {!artifacts.length ? <small>{t('No artifacts for this case and output node.')}</small> : null}
      {row.error ? <p role="alert" className="vd-batch-error">{row.error}</p> : null}
    </> : null}
    <div className="vd-batch-actions"><button disabled={!row || saving} onClick={() => void save(false)}>{t('Save selected case')}</button><button disabled={!rows?.length || saving} onClick={() => void save(true)}>{saving ? t('Saving…') : t('Save all cases')}</button></div>
    <small>{t('Downloads a TAR archive with indexed files and a JSON manifest.')}</small>
    {error ? <p role="alert" className="vd-batch-error">{error}</p> : null}
    {open ? <ArtifactPreviewDialog artifact={open} onClose={() => setOpen(null)} /> : null}
  </div>
}
