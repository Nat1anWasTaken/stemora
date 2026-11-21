import { useMemo } from "react"
import { lastAtOrBefore, sectionsByBar } from "@/player/analysis"
import { toAlphaTex, type FlatSyncPoint } from "@/player/drums/alphatex"
import type { DrumPrecision } from "@/player/drums/precision"
import { quantize, type QBar } from "@/player/drums/quantize"
import { usePlayer } from "@/player/store"

/** The drum chart at one precision: quantised bars plus the alphaTex and sync points that draw them. */
export type DrumChart = { bars: QBar[]; tex: string; syncPoints: FlatSyncPoint[] }

export function useDrumChart(precision: DrumPrecision): DrumChart | null {
  const analysis = usePlayer((s) => s.analysis)
  const duration = usePlayer((s) => s.duration)
  return useMemo(() => {
    if (!analysis?.drums) return null
    const bars = quantize(analysis, precision.precision, precision.triplets, duration)
    const byStart = sectionsByBar(analysis.sections, bars)
    const marks = new Map<number, string>()
    bars.forEach((b, i) => {
      const part = byStart.get(b.start)
      if (part) marks.set(i, part.name)
    })
    return { bars, ...toAlphaTex(bars, analysis.bpm, marks) }
  }, [analysis, precision, duration])
}

/** Index of the notation bar playing at `t` seconds (0 before the first bar). */
export function barIndexAt(bars: QBar[], t: number): number {
  return Math.max(0, lastAtOrBefore(bars.map((b) => b.start), t + 0.01))
}
