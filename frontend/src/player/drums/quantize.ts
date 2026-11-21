import { buildBars, buildCells, DRUM_KINDS, lastAtOrBefore, type Analysis, type DrumKind } from "@/player/analysis"

/** Notation precision picked by the viewer; "auto" uses the simplest grid that fits each beat. */
export type Precision = "auto" | "8" | "16" | "32"
/** One beat split into `grid` equal steps; `steps[k]` lists the drums struck on step k. */
export type QBeat = { time: number; end: number; grid: number; steps: DrumKind[][] }
export type QBar = { bar: number; start: number; end: number; beats: QBeat[] }

/** Longest bar written as one bar (in beats); longer stretches are cut into bars of the song's meter. */
const MAX_BAR_BEATS = 16

const STRAIGHT: Record<Exclude<Precision, "auto">, number> = { "8": 2, "16": 4, "32": 8 }
/** Auto accepts a grid when every hit lies within this share of a step (and at most AUTO_MAX_S seconds) of one. */
const AUTO_SHARE = 0.2
const AUTO_MAX_S = 0.03
/** A beat is read as triplets only when that fits clearly better than the straight grid. */
const TRIPLET_BIAS = 0.6

/** Sum of distances (in fractions of the beat) from each position to the nearest step of a `g`-step grid. */
function gridError(fracs: number[], g: number): number {
  return fracs.reduce((s, f) => s + Math.abs(f * g - Math.round(f * g)) / g, 0)
}

function maxError(fracs: number[], g: number): number {
  return fracs.reduce((m, f) => Math.max(m, Math.abs(f * g - Math.round(f * g)) / g), 0)
}

/** Whether every position lies close enough to a step of a `g`-step grid to be read as that grid. */
function fits(fracs: number[], g: number, beatLen: number): boolean {
  return maxError(fracs, g) * beatLen <= Math.min(AUTO_MAX_S, (AUTO_SHARE * beatLen) / g)
}

/** Steps per beat for one beat whose hits sit at `fracs` (0..1 of the beat). */
export function chooseGrid(fracs: number[], beatLen: number, precision: Precision, triplets: boolean): number {
  if (fracs.length === 0) return 1
  if (precision !== "auto") {
    const g = STRAIGHT[precision]
    if (!triplets) return g
    // Triplets only when the hits really sit on triplet steps and fit them clearly better (not a finer straight figure).
    const t = g === 2 ? 3 : 6
    const straight = gridError(fracs, g)
    return straight > 0 && fits(fracs, t, beatLen) && gridError(fracs, t) < TRIPLET_BIAS * straight ? t : g
  }
  const candidates = triplets ? [1, 2, 3, 4, 6, 8] : [1, 2, 4, 8]
  return candidates.find((g) => fits(fracs, g, beatLen)) ?? 8
}

/**
 * Quantise the drum onsets of an analysis onto its beat grid, bar by bar (bars as in the chord chart, pickup = bar 0).
 * Each beat gets its own grid, from `precision` and `triplets`. Hits that round onto the next beat move there;
 * hits before the first beat or after the last are dropped.
 */
export function quantize(a: Analysis, precision: Precision, triplets: boolean, duration: number): QBar[] {
  const { beats } = a
  const ends = beats.map((t, i) => beats[i + 1] ?? t + (i > 0 ? t - beats[i - 1] : 0.5))
  const located: { kind: DrumKind; i: number; f: number }[] = []
  const fracs: number[][] = beats.map(() => [])
  if (a.drums) {
    for (const kind of DRUM_KINDS) {
      for (const t of a.drums[kind]) {
        let i = lastAtOrBefore(beats, t)
        if (i < 0) {
          // A hair before the first beat still counts as on it.
          if (beats.length === 0 || beats[0] - t > (ends[0] - beats[0]) / 16) continue
          i = 0
        }
        if (t >= ends[i]) continue
        const f = Math.max(0, (t - beats[i]) / (ends[i] - beats[i]))
        located.push({ kind, i, f })
        fracs[i].push(f)
      }
    }
  }
  const qbeats: QBeat[] = beats.map((time, i) => {
    const grid = chooseGrid(fracs[i], ends[i] - time, precision, triplets)
    return { time, end: ends[i], grid, steps: Array.from({ length: grid }, () => []) }
  })
  for (const { kind, i, f } of located) {
    let b = i
    let step = Math.round(f * qbeats[b].grid)
    if (step >= qbeats[b].grid) {
      b += 1
      step = 0
      if (b >= qbeats.length) continue
    }
    const at = qbeats[b].steps[step]
    if (!at.includes(kind)) at.push(kind)
  }
  let first = 0
  const chunk = Math.min(MAX_BAR_BEATS, Math.max(1, a.beatsPerBar || 4))
  return buildBars(buildCells(a), duration).flatMap((bar) => {
    const all = qbeats.slice(first, first + bar.cells.length)
    first += bar.cells.length
    if (all.length === 0) return []
    if (all.length <= MAX_BAR_BEATS) return [{ bar: bar.bar, start: bar.start, end: bar.end, beats: all }]
    // Stretches without downbeats would make one huge bar, which notation cannot hold (alphaTab allows up to 32/4):
    // cut them into bars of the song's meter.
    const out: QBar[] = []
    for (let i = 0; i < all.length; i += chunk) {
      const beats = all.slice(i, i + chunk)
      out.push({ bar: bar.bar, start: beats[0].time, end: beats[beats.length - 1].end, beats })
    }
    return out
  })
}
