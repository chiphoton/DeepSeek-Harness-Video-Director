import { useEffect } from 'react'

let locks = 0
let bodyOverflow = ''
let rootOverflow = ''

/** Nested galleries and inspectors release page scrolling only after the last dialog closes. */
export function useModalScrollLock(): void {
  useEffect(() => {
    if (locks++ === 0) {
      bodyOverflow = document.body.style.overflow
      rootOverflow = document.documentElement.style.overflow
      document.body.style.overflow = 'hidden'
      document.documentElement.style.overflow = 'hidden'
    }
    return () => {
      if (--locks !== 0) return
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = rootOverflow
    }
  }, [])
}
