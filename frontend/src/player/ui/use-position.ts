import { useEffect, useState } from "react"
import { getPosition } from "@/player/store"

/** Playhead position in seconds, refreshed every animation frame (re-renders only when it moves by >= `step` s). */
export function usePosition(active = true, step = 0.1): number {
  const [pos, setPos] = useState(() => getPosition())
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = -1
    const tick = () => {
      const p = getPosition()
      if (Math.abs(p - last) >= step || p < last) {
        last = p
        setPos(p)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, step])
  return pos
}
