import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx',
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { StatusView } from './DirectorNode';
      export * from './node-status';
      export const render = data => renderToStaticMarkup(<StatusView data={data} />);
    `,
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
})
const status = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

test('queued nodes display IDLE without a duplicate phase or progress percentage', () => {
  const html = status.render({ status: 'queued', phase: 'submitting', progress: 0 })
  assert.equal(status.nodeStatus({ status: 'queued' }), 'idle')
  assert.match(html, />idle</)
  assert.doesNotMatch(html, /submitting|0%|queued/)
})

test('completed nodes show the local MMDD-HH:mm:ss time and execution duration together', () => {
  const end = new Date(2026, 8, 17, 9, 5, 3)
  const data = { status: 'completed', phase: 'completed', progress: 1,
    runStartedAt: new Date(end.getTime() - 12_300).toISOString(), runCompletedAt: end.toISOString() }
  assert.deepEqual(status.completionDetails(data), { time: '0917-09:05:03', seconds: '12.3' })
  const html = status.render(data)
  assert.equal((html.match(/>completed</g) ?? []).length, 1)
  assert.match(html, /<time[^>]*>0917-09:05:03<\/time><span> · 12.3 seconds<\/span>/)
  assert.doesNotMatch(html, /100%/)
})

test('running nodes show real progress and stages without repeating RUNNING', () => {
  const percent = status.render({ status: 'running', phase: 'running', progress: .42 })
  assert.equal((percent.match(/>running</g) ?? []).length, 1)
  assert.match(percent, />42%</)
  const stage = status.render({ status: 'running', phase: 'decoding video' })
  assert.match(stage, />decoding video</)
  assert.doesNotMatch(stage, /0%/)
})

test('frozen nodes retain FROZEN and do not display completion or progress details', () => {
  const html = status.render({ frozen: true, status: 'completed', phase: 'completed', progress: 1,
    runCompletedAt: new Date().toISOString() })
  assert.match(html, />FROZEN</)
  assert.doesNotMatch(html, /<time|completed|100%/)
})

test('missing or invalid historical timing never fabricates a completion duration', () => {
  assert.equal(status.completionDetails({}), undefined)
  assert.equal(status.completionDetails({ runCompletedAt: 'invalid' }), undefined)
  const runCompletedAt = new Date(2026, 8, 17, 9, 5, 3).toISOString()
  assert.deepEqual(status.completionDetails({ runCompletedAt }), { time: '0917-09:05:03', seconds: undefined })
  assert.equal(status.completionDetails({ runCompletedAt, runStartedAt: '2030-01-01T00:00:00Z' }).seconds, undefined)
})
