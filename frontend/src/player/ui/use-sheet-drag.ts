import { useEffect, useRef, type RefObject } from "react"

const DISMISS_DISTANCE = 120 // css px
const DISMISS_VELOCITY = 0.5 // css px per ms

/**
 * Swipe-down-to-dismiss for a full-screen sheet. Dragging `zone` moves `sheet` through the
 * `--drag-y` variable read by the `sheet-drag` utility; a long or fast enough drag calls `onDismiss`,
 * otherwise the sheet springs back. Presses that start on a button are left alone.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>, zone: RefObject<HTMLElement | null>, onDismiss: () => void, enabled: boolean) {
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  })

  useEffect(() => {
    const el = sheet.current
    const z = zone.current
    if (!enabled || !el || !z) return
    let start: { id: number; y: number; t: number } | null = null
    let last = { y: 0, t: 0 }
    let velocity = 0
    let dy = 0

    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || (e.target as HTMLElement).closest("button,a,[role=button]")) return
      start = { id: e.pointerId, y: e.clientY, t: e.timeStamp }
      last = { y: e.clientY, t: e.timeStamp }
      dy = 0
      velocity = 0
      z.setPointerCapture(e.pointerId)
      el.dataset.dragging = ""
    }
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      dy = Math.max(0, e.clientY - start.y)
      el.style.setProperty("--drag-y", `${dy}px`)
      if (e.timeStamp > last.t) velocity = (e.clientY - last.y) / (e.timeStamp - last.t)
      last = { y: e.clientY, t: e.timeStamp }
    }
    const onUp = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const recent = e.timeStamp - last.t < 100 ? velocity : 0
      const overall = dy / Math.max(1, e.timeStamp - start.t)
      start = null
      delete el.dataset.dragging
      if (e.type === "pointerup" && (dy > DISMISS_DISTANCE || (dy > 24 && Math.max(recent, overall) > DISMISS_VELOCITY))) dismiss.current()
      else el.style.setProperty("--drag-y", "0px")
    }
    z.addEventListener("pointerdown", onDown)
    z.addEventListener("pointermove", onMove)
    z.addEventListener("pointerup", onUp)
    z.addEventListener("pointercancel", onUp)
    return () => {
      z.removeEventListener("pointerdown", onDown)
      z.removeEventListener("pointermove", onMove)
      z.removeEventListener("pointerup", onUp)
      z.removeEventListener("pointercancel", onUp)
      delete el.dataset.dragging
      el.style.removeProperty("--drag-y")
    }
  }, [sheet, zone, enabled])
}
