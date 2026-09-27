import { useRef, useState, type DragEvent } from 'react'
import { acceptsInputFile, type InputFileKind } from './input-files'
import { t } from './i18n'

/** Own file drops on an input so rejected files cannot create canvas nodes. */
export function useInputFileDrop(options: {
  enabled: boolean
  disabled: boolean
  kind?: InputFileKind
  multiple: boolean
  onFiles(files: File[]): Promise<void>
}) {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const owns = (event: DragEvent): boolean => options.enabled
    && (Array.from(event.dataTransfer.types).includes('Files') || event.dataTransfer.files.length > 0)
  const over = (event: DragEvent): void => {
    if (!owns(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = options.disabled || pending.current ? 'none' : 'copy'
    setDragging(!options.disabled && !pending.current)
  }
  return {
    dragging, busy, error,
    handlers: {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event: DragEvent): void => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDragging(false)
      },
      onDrop: (event: DragEvent): void => {
        if (!owns(event)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        if (options.disabled || pending.current) return
        const files = Array.from(event.dataTransfer.files)
        const matching = files.filter(file => acceptsInputFile(file, options.kind))
        if (!options.multiple && files.length > 1) { setError(t('Drop one file at a time on this input.')); return }
        if (!matching.length) { setError(t('No supported files match this input.')); return }
        pending.current = true
        setBusy(true)
        setError('')
        void (async () => {
          try {
            await options.onFiles(matching)
            if (matching.length < files.length) setError(t('{0} unsupported files skipped.', files.length - matching.length))
          } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
          finally { pending.current = false; setBusy(false) }
        })()
      },
    },
  }
}
