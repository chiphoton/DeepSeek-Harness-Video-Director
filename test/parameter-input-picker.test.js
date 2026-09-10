import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost/' })
test.after(() => dom.window.close())
for (const key of ['window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
    loader: 'tsx',
    contents: `
      import React, { act, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ParameterInputPicker } from './App';
      export { act };
      function Fixture() {
        const [open, setOpen] = useState(true);
        const [node, setNode] = useState({ id: 'h3', type: 'director', position: {x: 0, y: 0},
          data: { kind: 'video-generation', title: 'MiniMax H3 Video', modelFamily: 'minimax-h3' } });
        return <section tabIndex={0} aria-label="Workflow canvas">
          {open && <ParameterInputPicker position={{nodeId: 'h3', screen: {x: 0, y: 0}}}
            node={node} edges={[]} onClose={() => setOpen(false)}
            onToggle={(id, enabled) => setNode(current => ({ ...current, data: { ...current.data,
              fieldInputModes: enabled ? {[id]: {mode: 'input'}} : undefined } }))} />}
        </section>;
      }
      export function mount() {
        const root = createRoot(document.getElementById('root'));
        root.render(<Fixture />);
        return root;
      }
    `,
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"' },
})
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

async function mount(t) {
  let root
  ui.act(() => { root = ui.mount() })
  t.after(() => { ui.act(() => root.unmount()) })
  assert.equal(document.activeElement.type, 'search')
  return document.querySelector('.vd-parameter-input-list button')
}

async function safariClick(target) {
  ui.act(() => {
    target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    if (target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))) {
      // Safari does not focus native buttons on mouse clicks. Its default action
      // focuses the nearest explicitly focusable ancestor before delivering click.
      target.closest('[tabindex]')?.focus()
    }
  })
  ui.act(() => {
    for (const type of ['pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
    }
  })
}

for (const part of ['row', 'switch']) {
  test(`Safari ${part} click keeps the picker open and toggles the parameter in both directions`, async t => {
    const row = await mount(t)
    const target = part === 'row' ? row : row.querySelector('.vd-parameter-input-switch i')
    await safariClick(target)
    assert.ok(row.isConnected, 'the picker must stay mounted until the click reaches its button')
    assert.equal(row.getAttribute('aria-pressed'), 'true')
    await safariClick(target)
    assert.equal(row.getAttribute('aria-pressed'), 'false')
  })
}

test('moving focus outside the picker still dismisses it', async t => {
  const row = await mount(t)
  ui.act(() => document.getElementById('outside').focus())
  assert.equal(row.isConnected, false)
})

test('clicking outside the picker still dismisses it', async t => {
  const row = await mount(t)
  ui.act(() => document.getElementById('outside').dispatchEvent(
    new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
  ))
  assert.equal(row.isConnected, false)
})
