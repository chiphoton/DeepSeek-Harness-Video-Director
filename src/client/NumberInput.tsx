import { useLayoutEffect, useRef, type InputHTMLAttributes } from 'react'

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & {
  value: number | string | undefined
  integer?: boolean
} & ({
  allowEmpty: true
  onValueCommit(value: number | undefined): void
} | {
  allowEmpty?: false
  onValueCommit(value: number): void
})

const displayValue = (value: NumberInputProps['value']): string => value === undefined ? '' : String(value)

/** Keep the browser's editing buffer intact, including empty / partial numbers.
 * Only completed edits enter application state, undo history and autosave.
 */
export function NumberInput({ value, onValueCommit, allowEmpty, integer, onFocus, onBlur, onKeyDown, ...props }: NumberInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  const dirty = useRef(false)

  // Run after every parent render: a caller may normalize a commit back to the
  // previous value. Background updates must never replace an in-progress draft.
  useLayoutEffect(() => {
    if (ref.current && !editing.current && ref.current.value !== displayValue(value)) ref.current.value = displayValue(value)
  })

  const commit = (input: HTMLInputElement): void => {
    editing.current = false
    const changed = dirty.current
    dirty.current = false
    const raw = input.value.trim()
    const invalid = input.validity.badInput || (raw !== '' && !Number.isFinite(Number(raw)))
    if (!changed || props.disabled || props.readOnly || invalid || (raw === '' && !allowEmpty)) {
      input.value = displayValue(value)
      return
    }
    if (raw === '') {
      if (allowEmpty && value !== undefined && value !== '') onValueCommit(undefined)
      return
    }
    let next = Number(raw)
    if (integer) next = Math.round(next)
    if (props.min !== undefined) next = Math.max(Number(props.min), next)
    if (props.max !== undefined) next = Math.min(Number(props.max), next)
    input.value = String(next)
    if (value === undefined || value === '' || next !== Number(value)) onValueCommit(next)
  }

  return <input {...props} ref={ref} type="number" defaultValue={displayValue(value)}
    onFocus={event => { editing.current = true; onFocus?.(event) }}
    onChange={() => { editing.current = true; dirty.current = true }}
    onBlur={event => { commit(event.currentTarget); onBlur?.(event) }}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopPropagation()
        commit(event.currentTarget)
      }
      onKeyDown?.(event)
    }} />
}
