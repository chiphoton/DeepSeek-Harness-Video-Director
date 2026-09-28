import { useEffect, useRef, useState } from 'react'

// One observer for the canvas, gallery, job cards, and reference thumbnails.
// Offscreen cards must not create media requests or retain native decoders.
const listeners = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | undefined

export function VideoThumbnail({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
    }, { rootMargin: '100px' })
    listeners.set(element, setVisible)
    observer.observe(element)
    return () => {
      observer?.unobserve(element)
      listeners.delete(element)
      if (!listeners.size) { observer?.disconnect(); observer = undefined }
    }
  }, [])
  useEffect(() => {
    const element = ref.current
    if (!element || !visible) return
    element.src = src
    return () => {
      if (!element.paused) element.pause()
      element.removeAttribute('src')
      // Removing src alone can leave Safari's media pipeline alive.
      if (element.networkState !== 0) element.load()
    }
  }, [src, visible])
  return <video ref={ref} aria-hidden="true" muted playsInline preload="metadata" />
}
