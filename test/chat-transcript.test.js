import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

test('chat renders Markdown, keeps active media local, and pairs expandable tool calls with their results', async t => {
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx', contents: `
      import { renderToStaticMarkup } from 'react-dom/server'
      import { ChatTranscript } from './ChatTranscript'
      export const render = messages => renderToStaticMarkup(<ChatTranscript messages={messages} sessionId="synthetic" readImage={() => {}} models={{ groups: [] }} />)
    ` },
    bundle: true, external: ['react', 'react-dom', 'react-dom/server'], platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const asset = '/api/video-director/assets/14f05e1d-e3a0-4f90-b90b-5d9c3536d6aa'
  const text = [
    '## Synthetic report', '- **Ready**', '', '| Input | Output |', '| --- | --- |', '| Text | Image |', '',
    '```js', 'const count = 2', '```', '', 'Compare <Image 1> and <Image 2>.', '',
    `![Grid](${asset})`, '', `[Voice.wav](${asset})`, '', `![Clip.mp4](${asset})`, '',
    '![Remote](https://example.com/tracker.png)', '', '<img src="https://example.com/raw.png">', '', '[Bad](javascript:alert%281%29)',
  ].join('\n')
  const dom = new JSDOM(module.exports.render([
    { id: 'call', role: 'assistant', kind: 'tool-call', callId: 'x', toolName: 'vd_canvas', toolCommand: 'validate', text: 'Input' },
    { id: 'result', role: 'assistant', kind: 'tool-result', callId: 'x', status: 'error', text: 'Output' },
    { id: 'reply', role: 'assistant', kind: 'assistant', text },
    { id: 'prompt', role: 'user', kind: 'user', text: [
      'Use $sketch-to-h3 with **this brief**. Write ` $example `, \\$layout-optimizer, and &#36;canvas-builder literally. Then run $canvas-builder.',
      '', '- Also use $layout-optimizer.',
    ].join('\n') },
  ]))
  t.after(() => dom.window.close())
  const doc = dom.window.document
  assert.equal(doc.querySelector('h2').textContent, 'Synthetic report')
  assert.equal(doc.querySelector('article li strong').textContent, 'Ready')
  assert.equal(doc.querySelector('tbody td:last-child').textContent, 'Image')
  assert.match(doc.querySelector('pre code').textContent, /const count = 2/)
  assert.match(doc.querySelector('article').textContent, /Compare <Image 1> and <Image 2>/)
  assert.equal(doc.querySelector('img').getAttribute('src'), asset)
  assert.equal(doc.querySelector('button').getAttribute('aria-label'), 'Preview Grid')
  for (const kind of ['audio', 'video']) assert.equal(doc.querySelector(`${kind}[controls]`).getAttribute('src'), asset)
  assert.equal(doc.querySelectorAll('img').length, 1)
  assert.equal(doc.querySelector('a[href="https://example.com/tracker.png"]').textContent, 'Remote')
  assert.equal(doc.querySelector('a[href^="javascript:"]'), null)
  assert.match(doc.querySelector('details > summary').textContent, /Tool activity \(1\).*1 error/)
  const call = doc.querySelector('details details')
  assert.equal(call.open, false)
  assert.match(call.querySelector('summary').textContent, /vd_canvas · validate/)
  assert.deepEqual([...call.querySelectorAll('pre')].map(node => node.textContent), ['Input', 'Output'])
  const prompt = doc.querySelector('.vd-message-user')
  assert.deepEqual([...prompt.querySelectorAll('.vd-chat-skill-mention')].map(node => node.textContent), ['$sketch-to-h3', '$canvas-builder', '$layout-optimizer'])
  assert.equal(prompt.querySelector('strong').textContent, 'this brief')
  assert.equal(prompt.querySelector('code').textContent, '$example')
  assert.match(prompt.textContent, /\$layout-optimizer, and \$canvas-builder literally/)
})
