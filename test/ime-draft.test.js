import assert from 'node:assert/strict'
import test from 'node:test'

import { createImeDraft, reduceImeDraft } from '../src/client/ime-draft.js'

test('IME draft keeps pinyin composition local until the committed Chinese value is ready', () => {
  let state = createImeDraft('')

  state = reduceImeDraft(state, { type: 'composition-start' })
  state = reduceImeDraft(state, { type: 'input', value: 'n', isComposing: true })
  assert.deepEqual(state, { draft: 'n', composing: true })

  state = reduceImeDraft(state, { type: 'input', value: 'ni', isComposing: true })
  assert.deepEqual(state, { draft: 'ni', composing: true })

  state = reduceImeDraft(state, { type: 'external', value: '' })
  assert.deepEqual(state, { draft: 'ni', composing: true })

  state = reduceImeDraft(state, { type: 'composition-end', value: '你' })
  assert.deepEqual(state, { draft: '你', composing: false, commit: '你' })
})

test('IME draft still commits ordinary non-composing input immediately', () => {
  const state = reduceImeDraft(createImeDraft('old'), {
    type: 'input',
    value: 'new',
    isComposing: false,
  })
  assert.deepEqual(state, { draft: 'new', composing: false, commit: 'new' })
})
