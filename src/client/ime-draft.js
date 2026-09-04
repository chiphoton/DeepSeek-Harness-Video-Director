export function createImeDraft(value) {
  return { draft: value, composing: false }
}

export function reduceImeDraft(state, event) {
  if (event.type === 'composition-start') return { draft: state.draft, composing: true }
  if (event.type === 'composition-end') return { draft: event.value, composing: false, commit: event.value }
  if (event.type === 'external') {
    return state.composing ? { draft: state.draft, composing: true } : { draft: event.value, composing: false }
  }
  if (state.composing || event.isComposing === true) {
    return { draft: event.value, composing: true }
  }
  return { draft: event.value, composing: false, commit: event.value }
}
