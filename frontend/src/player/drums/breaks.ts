import { lastAtOrBefore } from "@/player/analysis"

/**
 * Line breaks in the drum notation are stored as times: the start of each bar that begins a new row. The bars come
 * from the tempo map, so they are looked up by time; when the map changes, each break moves to the bar line now
 * nearest it, as long as one is within half a bar.
 */
type BarLike = { start: number; end: number }

/** A bar starts at a break when they are this close (seconds). */
const SAME = 0.002

/** Index of the bar starting at `t`, or -1. Bar 0 never takes a break (nothing before it). */
function barAt(bars: BarLike[], t: number): number {
  const i = lastAtOrBefore(bars.map((b) => b.start), t + SAME)
  return i >= 1 && Math.abs(bars[i].start - t) <= SAME ? i : -1
}

/** Indices of the bars the breaks start, sorted (breaks not on a bar line are left out). */
export function breakBars(times: number[], bars: BarLike[]): number[] {
  return [...new Set(times.map((t) => barAt(bars, t)).filter((i) => i >= 1))].sort((a, b) => a - b)
}

/**
 * The breaks on a new set of bars: each moves to the nearest bar start within half a bar (of the bars either side of
 * that line). Breaks with no bar line near them, or that would land on a line another break already took (the
 * closer one keeps it), are dropped and counted.
 */
export function remapBreaks(times: number[], bars: BarLike[]): { times: number[]; removed: number } {
  const starts = bars.map((b) => b.start)
  const best = new Map<number, { t: number; d: number }>()
  let removed = 0
  for (const t of times) {
    const i = lastAtOrBefore(starts, t)
    let pick = -1
    let dist = Infinity
    for (const j of [i, i + 1]) {
      if (j < 1 || j >= bars.length) continue
      const half = Math.min(bars[j].end - bars[j].start, bars[j - 1].end - bars[j - 1].start) / 2
      const d = Math.abs(bars[j].start - t)
      if (d <= half && d < dist) {
        pick = j
        dist = d
      }
    }
    if (pick < 0) {
      removed++
      continue
    }
    const held = best.get(pick)
    if (held) removed++
    if (!held || dist < held.d) best.set(pick, { t, d: dist })
  }
  return { times: [...best.keys()].sort((a, b) => a - b).map((j) => bars[j].start), removed }
}
