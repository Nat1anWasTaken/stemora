import { useEffect, useRef, type RefObject } from "react"
import { clampZoom } from "@/player/drums/notation-prefs"

/** Where a finished pinch should stay put once the content is redrawn at the new zoom. */
export type PinchAnchor = { ratio: number; x: number; y: number; viewX: number; viewY: number }

const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

/**
 * Two-finger pinch on `scroller` zooms `content`. One finger keeps scrolling natively (the scroller uses
 * `touch-pan`, so the browser neither page-zooms nor pans while two fingers are down). During the gesture the
 * content is only scaled with a CSS transform (`--pinch`, around the fingers' midpoint); on release `onZoom` gets the
 * new zoom and the anchor, and the caller redraws at that size, then calls `settle(anchor)` to scroll the
 * midpoint back under the fingers and drop the transform.
 */
export function usePinchZoom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  enabled: boolean,
  zoom: number,
  onZoom: (zoom: number, anchor: PinchAnchor) => void,
) {
  const live = useRef({ zoom, onZoom })
  useEffect(() => {
    live.current = { zoom, onZoom }
  }, [zoom, onZoom])

  useEffect(() => {
    const box = scroller.current
    if (!enabled || !box) return
    let start: { d: number; x: number; y: number; viewX: number; viewY: number } | null = null
    let ratio = 1

    const onStart = (e: TouchEvent) => {
      const el = content.current
      if (e.touches.length !== 2 || !el) return
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2
      start = { d: dist(e.touches), x: mx - r.left, y: my - r.top, viewX: mx - b.left, viewY: my - b.top }
      ratio = 1
      el.style.setProperty("--pinch-x", `${start.x}px`)
      el.style.setProperty("--pinch-y", `${start.y}px`)
    }
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return
      e.preventDefault()
      const z = live.current.zoom
      ratio = clampZoom((z * dist(e.touches)) / start.d) / z
      content.current?.style.setProperty("--pinch", String(ratio))
    }
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return
      const s = start
      start = null
      if (Math.abs(ratio - 1) < 0.02) {
        content.current?.style.removeProperty("--pinch")
        return
      }
      live.current.onZoom(clampZoom(live.current.zoom * ratio), { ratio, x: s.x, y: s.y, viewX: s.viewX, viewY: s.viewY })
    }
    // Safari's own pinch gesture would zoom the whole page.
    const noGesture = (e: Event) => e.preventDefault()

    box.addEventListener("touchstart", onStart, { passive: true })
    box.addEventListener("touchmove", onMove, { passive: false })
    box.addEventListener("touchend", onEnd)
    box.addEventListener("touchcancel", onEnd)
    box.addEventListener("gesturestart", noGesture)
    return () => {
      box.removeEventListener("touchstart", onStart)
      box.removeEventListener("touchmove", onMove)
      box.removeEventListener("touchend", onEnd)
      box.removeEventListener("touchcancel", onEnd)
      box.removeEventListener("gesturestart", noGesture)
    }
  }, [enabled, scroller, content])
}

/** After the redraw at the new zoom: keep the pinch midpoint under the fingers, then drop the live transform. */
export function settlePinch(scroller: HTMLElement, content: HTMLElement, a: PinchAnchor) {
  content.style.removeProperty("--pinch")
  const offsetTop = content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  const offsetLeft = content.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft
  scroller.scrollTo({ left: offsetLeft + a.x * a.ratio - a.viewX, top: offsetTop + a.y * a.ratio - a.viewY })
}
