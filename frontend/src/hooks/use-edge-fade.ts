import { useEffect, type RefObject } from "react"

/**
 * Marks a horizontal scroller (styled with `fade-x`) with `data-at-start` / `data-at-end` while it is scrolled to
 * that edge, so the edge fade only shows where more content is hidden. Writes attributes directly: no re-renders.
 */
export function useEdgeFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      el.toggleAttribute("data-at-start", el.scrollLeft <= 1)
      el.toggleAttribute("data-at-end", el.scrollLeft >= max - 1)
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener("scroll", update)
      ro?.disconnect()
    }
  }, [ref])
}

/**
 * Scrolls `child` into view inside the horizontal scroller `box` only. Unlike `scrollIntoView`, this never scrolls
 * the ancestors, which would otherwise drift sideways when they clip overflow (overflow-y-auto implies overflow-x).
 */
export function revealInline(box: HTMLElement, child: HTMLElement, margin = 24, smooth = true) {
  const b = box.getBoundingClientRect()
  const c = child.getBoundingClientRect()
  const delta = c.left < b.left + margin ? c.left - b.left - margin : c.right > b.right - margin ? c.right - b.right + margin : 0
  if (delta) box.scrollBy({ left: delta, behavior: smooth ? "smooth" : "instant" })
}
