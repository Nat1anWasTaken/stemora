import { useEffect, useState } from "react"
import { getPosition, usePlayer } from "@/player/store"
import { beatLength, markerIndexAt, patternFor } from "@/player/tempo-map"

/** Index of the tempo marker under the playhead; re-renders only when it changes. */
export function usePlayheadMarker(): number {
  const markers = usePlayer((s) => s.markers)
  const [index, setIndex] = useState(() => markerIndexAt(markers, getPosition()))
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      setIndex(markerIndexAt(markers, getPosition()))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [markers])
  return Math.min(index, markers.length - 1)
}

/**
 * The click of marker `index`'s pattern sounding now, as "beat:sub", or null when the song is paused or elsewhere.
 * Drives the ring on the pattern grid, like a conductor's hand.
 */
export function usePlayingClick(index: number): string | null {
  const markers = usePlayer((s) => s.markers)
  const playing = usePlayer((s) => s.playing)
  const [click, setClick] = useState<string | null>(null)
  useEffect(() => {
    const m = markers[index]
    const pattern = m?.kind === "manual" ? patternFor(m) : null
    const end = markers[index + 1]?.time ?? Infinity
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const t = getPosition()
      if (!playing || m?.kind !== "manual" || !pattern || t < m.time - 1e-6 || t >= end) return setClick(null)
      const beats = (t - m.time) / beatLength(m)
      const n = Math.floor(beats)
      const beat = n % m.num
      const sub = Math.min(pattern[beat].length - 1, Math.floor((beats - n) * pattern[beat].length))
      setClick(`${beat}:${sub}`)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [markers, index, playing])
  return click
}
