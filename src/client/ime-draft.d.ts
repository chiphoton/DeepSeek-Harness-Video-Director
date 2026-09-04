export interface ImeDraftState {
  draft: string
  composing: boolean
  commit?: string
}

export type ImeDraftEvent =
  | { type: 'composition-start' }
  | { type: 'composition-end'; value: string }
  | { type: 'external'; value: string }
  | { type: 'input'; value: string; isComposing: boolean }

export function createImeDraft(value: string): ImeDraftState
export function reduceImeDraft(state: ImeDraftState, event: ImeDraftEvent): ImeDraftState
