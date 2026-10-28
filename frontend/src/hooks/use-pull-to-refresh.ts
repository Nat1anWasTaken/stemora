import { useEffect, useRef, type RefObject } from "react"

const THRESHOLD = 72 // css px of (damped) pull that triggers a refresh
const MAX = 120

/**
 * Touch pull-to-refresh for a page that scrolls the document. Pulling down at the top moves `indicator`
 * through `--pull` (px) and `--pull-n` (0..1), read by the `ptr-indicator` / `ptr-spin` utilities; releasing
 * past the threshold runs `onRefresh` while the indicator spins (`data-refreshing`).
 */
export function usePullToRefresh(indicator: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown>) {
  const refresh = useRef(onRefresh)
  useEffect(() => {
    refresh.current = onRefresh
  })

  useEffect(() => {
    const el = indicator.current
    if (!el) return
    let start: { x: number; y: number } | null = null
    let pulling = false
    let dist = 0
    let busy = false

    const set = (px: number) => {
      el.style.setProperty("--pull", `${px}px`)
      el.style.setProperty("--pull-n", String(Math.min(1, px / THRESHOLD)))
    }
    const onStart = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0) return
      if ((e.target as Element).closest('[role="dialog"],[role="alertdialog"],[data-no-pull]')) return
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      pulling = false
      dist = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      const dx = e.touches[0].clientX - start.x
      const dy = e.touches[0].clientY - start.y
      if (!pulling) {
        if (dy > 8 && dy > Math.abs(dx) && window.scrollY <= 0) {
          pulling = true
          el.dataset.dragging = ""
        } else if (Math.abs(dx) > 8 || dy < -8) {
          start = null
          return
        } else return
      }
      e.preventDefault()
      const next = Math.min(MAX, Math.max(0, dy - 8) * 0.5)
      if (next >= THRESHOLD && dist < THRESHOLD) navigator.vibrate?.(8)
      dist = next
      set(dist)
      el.toggleAttribute("data-armed", dist >= THRESHOLD)
    }
    const onEnd = async () => {
      if (!start) return
      start = null
      if (!pulling) return
      pulling = false
      delete el.dataset.dragging
      el.removeAttribute("data-armed")
      if (dist < THRESHOLD) return set(0)
      busy = true
      set(THRESHOLD)
      el.dataset.refreshing = ""
      // keep the spinner up long enough to read as feedback even when the refetch is instant
      await Promise.allSettled([refresh.current(), new Promise((r) => setTimeout(r, 600))])
      delete el.dataset.refreshing
      set(0)
      busy = false
    }
    window.addEventListener("touchstart", onStart, { passive: true })
    window.addEventListener("touchmove", onMove, { passive: false })
    window.addEventListener("touchend", onEnd)
    window.addEventListener("touchcancel", onEnd)
    return () => {
      window.removeEventListener("touchstart", onStart)
      window.removeEventListener("touchmove", onMove)
      window.removeEventListener("touchend", onEnd)
      window.removeEventListener("touchcancel", onEnd)
    }
  }, [indicator])
}
