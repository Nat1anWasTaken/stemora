import { DRUM_KINDS, lastAtOrBefore, type Analysis, type DrumKind } from "@/player/analysis"
import type { BeatGrid } from "@/player/tempo-map"

/** Notation precision picked by the viewer; "auto" uses the simplest grid that fits each beat. */
export type Precision = "auto" | "8" | "16" | "32"
/** One beat (a `den` note) split into `grid` equal steps; `steps[k]` lists the drums struck on step k. */
export type QBeat = { time: number; end: number; grid: number; steps: DrumKind[][] }
export type QBar = { bar: number; start: number; end: number; den: number; beats: QBeat[] }

/** Note value of a fixed precision (8 = eighth notes). */
const VALUE: Record<Exclude<Precision, "auto">, number> = { "8": 8, "16": 16, "32": 32 }
/** Finest note value written (32nds). */
const FINEST = 32
/** Straight steps per beat for a note value, at least one. */
const stepsFor = (value: number, den: number) => Math.max(1, value / den)
/** Triplet steps that replace `g` straight steps, if notation can write them (3 or 6 per beat, no finer than 32nds). */
const tripletFor = (g: number, den: number) => {
  const t = (g * 3) / 2
  return (t === 3 || t === 6) && (2 * den * t) / 3 <= FINEST ? t : null
}
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

/** Steps per beat for one beat (a `den` note) whose hits sit at `fracs` (0..1 of the beat). */
export function chooseGrid(fracs: number[], beatLen: number, precision: Precision, triplets: boolean, den = 4): number {
  if (fracs.length === 0) return 1
  const finest = stepsFor(FINEST, den)
  if (precision !== "auto") {
    const g = Math.min(finest, stepsFor(VALUE[precision], den))
    const t = triplets ? tripletFor(Math.max(2, g), den) : null
    if (!t) return g
    // Triplets only when the hits really sit on triplet steps and fit them clearly better (not a finer straight figure).
    const straight = gridError(fracs, g)
    return straight > 0 && fits(fracs, t, beatLen) && gridError(fracs, t) < TRIPLET_BIAS * straight ? t : g
  }
  const straight = [1, 2, 4, 8, 16].filter((g) => g <= finest)
  const tuplets = triplets ? [3, 6].filter((t) => (2 * den * t) / 3 <= FINEST) : []
  const candidates = [...straight, ...tuplets].sort((x, y) => x - y)
  return candidates.find((g) => fits(fracs, g, beatLen)) ?? finest
}

/**
 * Quantise the drum onsets of an analysis onto a beat grid, bar by bar (the grid's bars, pickup = bar 0). Each beat
 * gets its own grid, from `precision`, `triplets` and the beat's note value. Hits that round onto the next beat move
 * there; hits before the first beat or after the last are dropped.
 */
export function quantize(a: Analysis, precision: Precision, triplets: boolean, grid: BeatGrid): QBar[] {
  const beats = grid.beats.map((b) => b.time)
  const last = grid.bars[grid.bars.length - 1]?.end
  const ends = beats.map((t, i) => beats[i + 1] ?? (last !== undefined && last > t ? last : t + (i > 0 ? t - beats[i - 1] : 0.5)))
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
    const g = chooseGrid(fracs[i], ends[i] - time, precision, triplets, grid.beats[i].den)
    return { time, end: ends[i], grid: g, steps: Array.from({ length: g }, () => []) }
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
  return grid.bars.filter((b) => b.count > 0).map((b) => ({ bar: b.bar, start: b.start, end: b.end, den: b.den, beats: qbeats.slice(b.first, b.first + b.count) }))
}
