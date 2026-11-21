import { useEffect, useState } from "react"
import { getPosition, usePlayer } from "@/player/store"
import { markerIndexAt, tempoAt } from "@/player/tempo-map"

export type PlayheadTempo = { bpm: number | null; num: number; den: number }

/** Tempo and meter under the playhead (song tempo, before the speed change); re-renders only when they change. */
export function usePlayheadTempo(): PlayheadTempo {
  const markers = usePlayer((s) => s.markers)
  const grid = usePlayer((s) => s.grid)
  const beatsPerBar = usePlayer((s) => s.analysis?.beatsPerBar ?? 4)
  const [tempo, setTempo] = useState<PlayheadTempo>({ bpm: null, num: 4, den: 4 })
  useEffect(() => {
    let raf = 0
    let key = ""
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const t = getPosition()
      const m = markers[markerIndexAt(markers, t)]
      const raw = tempoAt(markers, grid, t)
      const bpm = raw === null ? null : Math.round(raw * 10) / 10
      const next = m?.kind === "manual" ? { bpm, num: m.num, den: m.den } : { bpm, num: Math.round(beatsPerBar), den: 4 }
      const k = `${next.bpm}|${next.num}|${next.den}`
      if (k === key) return
      key = k
      setTempo(next)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [markers, grid, beatsPerBar])
  return tempo
}

/** "120", "120.5" or "120.25". */
export const formatBpm = (bpm: number) => String(Math.round(bpm * 100) / 100)
