import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

/**
 * iOS-style swipe-left on a list row (touch and pen only; mouse users have the row's menu).
 * Dragging moves `row` through `--swipe-x` (the `swipe-row` utility). Releasing past half the row width calls
 * `onFullSwipe`; past half of `reveal` it stays open showing the action behind it; otherwise it springs back.
 * A tap anywhere else closes it, and the click that ends a swipe is swallowed so links under it don't fire.
 */
export function useSwipeAction(row: RefObject<HTMLElement | null>, { reveal, onFullSwipe }: { reveal: number; onFullSwipe: () => void }) {
  const [open, setOpen] = useState(false)
  const isOpen = useRef(false)
  const full = useRef(onFullSwipe)
  useEffect(() => {
    full.current = onFullSwipe
  })
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    isOpen.current = open
    row.current?.style.setProperty("--swipe-x", open ? `${-reveal}px` : "0px")
  }, [row, open, reveal])

  useEffect(() => {
    const el = row.current
    if (!el) return
    let start: { id: number; x: number; y: number; base: number } | null = null
    let axis: "x" | "y" | null = null
    let offset = 0
    const swallow = (c: MouseEvent) => {
      c.preventDefault()
      c.stopPropagation()
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, base: isOpen.current ? -reveal : 0 }
      axis = null
      offset = start.base
    }
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (!axis) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          axis = "x"
          el.setPointerCapture(e.pointerId)
          el.dataset.dragging = ""
        } else if (Math.abs(dy) > 8) axis = "y"
      }
      if (axis !== "x") return
      const raw = start.base + dx
      // rubber-band past the right edge, no limit to the left (up to the row width)
      offset = raw > 0 ? raw * 0.2 : Math.max(raw, -el.offsetWidth)
      el.style.setProperty("--swipe-x", `${offset}px`)
    }
    const onUp = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const swiped = axis === "x"
      start = null
      axis = null
      if (!swiped) return
      delete el.dataset.dragging
      // swallow the click that ends this gesture
      el.addEventListener("click", swallow, { capture: true, once: true })
      setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 300)
      const fullSwipe = e.type === "pointerup" && offset < -el.offsetWidth * 0.5
      const next = !fullSwipe && e.type === "pointerup" && offset < -reveal / 2
      el.style.setProperty("--swipe-x", next ? `${-reveal}px` : "0px")
      isOpen.current = next
      setOpen(next)
      if (fullSwipe) full.current()
    }
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
    }
  }, [row, reveal])

  // Any press outside the open row closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!row.current?.parentElement?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [row, open])

  return { open, close }
}
