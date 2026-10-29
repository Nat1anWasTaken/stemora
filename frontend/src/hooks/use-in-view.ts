import { useEffect, useRef, type RefObject } from "react"

/**
 * Calls `onEnter` whenever the element scrolls within `rootMargin` of the viewport
 * (infinite scroll sentinel). Does nothing while `enabled` is false.
 */
export function useInView(ref: RefObject<Element | null>, onEnter: () => void, { enabled = true, rootMargin = "400px" } = {}) {
  const cb = useRef(onEnter)
  useEffect(() => {
    cb.current = onEnter
  })
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) cb.current()
    }, { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, enabled, rootMargin])
}
