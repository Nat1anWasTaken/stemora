import { lastAtOrBefore, type Analysis } from "@/player/analysis"

/**
 * Tempo map: markers along the song that decide where the beats are. A manual marker lays a fixed grid (BPM counted
 * in the time signature's denominator note, so 6/8 at 120 is 120 eighths a minute); an auto marker hands the beats
 * back to the detected ones. Every marker starts a new bar. The first marker sits at 0:00 and always exists.
 *
 * A marker right after a manual marker is locked to that marker's grid: it sits a whole number of beats after it, so
 * changing or moving the manual marker moves it too (and whatever is locked to it in turn). A marker after an auto
 * marker is free.
 */
export type AutoMarker = { time: number; kind: "auto" }
export type ManualMarker = { time: number; kind: "manual"; bpm: number; num: number; den: number }
export type TempoMarker = AutoMarker | ManualMarker

export const DENOMINATORS = [2, 4, 8, 16] as const
export const MIN_BPM = 20
export const MAX_BPM = 400
export const MAX_NUM = 32
export const MAX_MARKERS = 1000
/** Closest two markers may sit, in seconds. */
const MIN_GAP = 0.02
/** Detected beats closer than this share of a beat to a marker are dropped (the marker is the beat). */
const EDGE_SHARE = 0.4
/** Longest bar written as one bar (in beats); longer stretches without downbeats are cut. */
const MAX_BAR_BEATS = 16

export const defaultMarkers = (): TempoMarker[] => [{ time: 0, kind: "auto" }]

export const beatLength = (m: ManualMarker) => 60 / m.bpm
const roundBpm = (bpm: number) => Math.round(bpm * 100) / 100
export const clampBpm = (bpm: number) => roundBpm(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)))

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

/** A well-formed marker from JSON, or null. */
export function parseMarker(json: unknown): TempoMarker | null {
  if (!json || typeof json !== "object") return null
  const j = json as Record<string, unknown>
  if (!isNum(j.time) || j.time < 0) return null
  if (j.kind === "auto") return { time: j.time, kind: "auto" }
  if (j.kind !== "manual" || !isNum(j.bpm) || !isNum(j.num) || !isNum(j.den)) return null
  if (!Number.isInteger(j.num) || j.num < 1 || j.num > MAX_NUM || !(DENOMINATORS as readonly number[]).includes(j.den)) return null
  return { time: j.time, kind: "manual", bpm: clampBpm(j.bpm), num: j.num, den: j.den }
}

/** Sorted, one marker per time, the first at 0:00, locked markers exactly on their grid, nothing past `duration`. */
export function normalizeMarkers(list: unknown, duration = Infinity): TempoMarker[] {
  const parsed = (Array.isArray(list) ? list : []).map(parseMarker).filter((m): m is TempoMarker => !!m).sort((a, b) => a.time - b.time)
  const out: TempoMarker[] = []
  for (const m of parsed) {
    if (out.length === 0) {
      out.push(m.time < MIN_GAP ? { ...m, time: 0 } : { time: 0, kind: "auto" })
      if (m.time < MIN_GAP) continue
    }
    const prev = out[out.length - 1]
    let time = m.time
    if (prev.kind === "manual") time = prev.time + Math.max(1, Math.round((time - prev.time) / beatLength(prev))) * beatLength(prev)
    if (time - prev.time < MIN_GAP || time >= duration) continue
    out.push({ ...m, time })
  }
  return out.length ? out : defaultMarkers()
}

/** A marker in a chain: `beats` is its offset from a manual predecessor, null when free, "relock" to recompute it. */
type Anchor = { m: TempoMarker; beats: number | null | "relock" }

const toAnchors = (ms: TempoMarker[]): Anchor[] =>
  ms.map((m, i) => {
    const prev = ms[i - 1]
    return { m, beats: prev?.kind === "manual" ? Math.max(1, Math.round((m.time - prev.time) / beatLength(prev))) : null }
  })

/** Lays the chain out again from the first marker; null when markers would cross or leave the song. */
function fromAnchors(anchors: Anchor[], duration: number): TempoMarker[] | null {
  const out: TempoMarker[] = []
  for (const [i, a] of anchors.entries()) {
    if (i === 0) {
      out.push({ ...a.m, time: 0 })
      continue
    }
    const prev = out[i - 1]
    let time = a.m.time
    if (prev.kind === "manual") {
      const len = beatLength(prev)
      const beats = a.beats === null || a.beats === "relock" ? Math.max(1, Math.round((a.m.time - prev.time) / len)) : a.beats
      time = prev.time + beats * len
    }
    if (time - prev.time < MIN_GAP || time >= duration) return null
    out.push({ ...a.m, time })
  }
  return out
}

/** Where a marker placed at `t` lands: on the grid of a manual marker before it, else at `t`. */
export function snapTime(markers: TempoMarker[], t: number): number {
  const i = Math.max(0, lastAtOrBefore(markers.map((m) => m.time), t))
  const prev = markers[i]
  if (prev.kind !== "manual") return t
  const len = beatLength(prev)
  return prev.time + Math.max(1, Math.round((t - prev.time) / len)) * len
}

/** Whether the marker at `index` is locked to a manual marker's grid (moves a beat at a time). */
export const isLocked = (markers: TempoMarker[], index: number) => index > 0 && markers[index - 1].kind === "manual"

/** Adds `marker` at its (snapped) time; returns the new list and its index, or null if it does not fit. */
export function insertMarker(markers: TempoMarker[], marker: TempoMarker, duration = Infinity): { markers: TempoMarker[]; index: number } | null {
  const time = snapTime(markers, marker.time)
  const index = lastAtOrBefore(markers.map((m) => m.time), time) + 1
  if (index === 0) return null
  const anchors = toAnchors(markers)
  anchors.splice(index, 0, { m: { ...marker, time }, beats: "relock" })
  // The next marker now follows the new one: it keeps its time, on the new marker's grid if that is manual.
  if (anchors[index + 1]) anchors[index + 1].beats = "relock"
  const out = fromAnchors(anchors, duration)
  return out ? { markers: out, index } : null
}

/** Moves the marker at `index` to `t` (a whole beat at a time when locked); markers locked behind it follow. */
export function moveMarker(markers: TempoMarker[], index: number, t: number, duration = Infinity): TempoMarker[] | null {
  if (index <= 0 || index >= markers.length) return null
  const anchors = toAnchors(markers)
  const prev = markers[index - 1]
  if (prev.kind === "manual") anchors[index].beats = Math.max(1, Math.round((t - prev.time) / beatLength(prev)))
  else anchors[index].m = { ...anchors[index].m, time: t }
  return fromAnchors(anchors, duration)
}

/** Changes the marker at `index` (kind, BPM, meter); markers locked to it move with its new grid. */
export function updateMarker(markers: TempoMarker[], index: number, next: TempoMarker, duration = Infinity): TempoMarker[] | null {
  if (index < 0 || index >= markers.length) return null
  const anchors = toAnchors(markers)
  const before = markers[index]
  anchors[index].m = { ...next, time: before.time }
  // A marker that was free becomes locked (to the nearest beat) once its predecessor turns manual, and the other way round.
  if (anchors[index + 1] && (before.kind !== "manual" || next.kind !== "manual")) anchors[index + 1].beats = "relock"
  return fromAnchors(anchors, duration)
}

/** Removes the marker at `index` (never the first); the next marker locks to the grid before it, if any. */
export function removeMarker(markers: TempoMarker[], index: number, duration = Infinity): TempoMarker[] | null {
  if (index <= 0 || index >= markers.length) return null
  const anchors = toAnchors(markers)
  anchors.splice(index, 1)
  if (anchors[index]) anchors[index].beats = "relock"
  return fromAnchors(anchors, duration)
}

/** Index of the marker whose segment holds `t`. */
export const markerIndexAt = (markers: TempoMarker[], t: number) => Math.max(0, lastAtOrBefore(markers.map((m) => m.time), t + 1e-6))

// --- Time signatures ---------------------------------------------------------------------------------------------

export type TimeSignature = { num: number; den: number }
export const COMMON_SIGNATURES: TimeSignature[] = [
  { num: 2, den: 4 }, { num: 3, den: 4 }, { num: 4, den: 4 }, { num: 5, den: 4 }, { num: 6, den: 4 }, { num: 7, den: 4 },
  { num: 3, den: 8 }, { num: 5, den: 8 }, { num: 6, den: 8 }, { num: 7, den: 8 }, { num: 9, den: 8 }, { num: 12, den: 8 },
]

/** "6/8", "6 8", "6:8" or "6-8" → {6, 8}; a bare number means that many quarters. Null when not a valid meter. */
export function parseTimeSignature(text: string): TimeSignature | null {
  const m = /^\s*(\d{1,2})\s*(?:[/:\- ]\s*(\d{1,2}))?\s*$/.exec(text)
  if (!m) return null
  const num = Number(m[1])
  const den = m[2] === undefined ? 4 : Number(m[2])
  if (num < 1 || num > MAX_NUM || !(DENOMINATORS as readonly number[]).includes(den)) return null
  return { num, den }
}

export const formatTimeSignature = (s: TimeSignature) => `${s.num}/${s.den}`

// --- Beat grid ---------------------------------------------------------------------------------------------------

/** One beat. `beat` is 1-based within its bar; pickup beats before the first bar are bar 0. */
export type GridBeat = { time: number; bar: number; beat: number; downbeat: boolean; den: number; auto: boolean }
/** One bar: `count` beats of `den` notes from beat index `first`; `end` is where the next bar starts (or the song ends). */
export type GridBar = { bar: number; start: number; end: number; first: number; count: number; den: number; auto: boolean }
export type BeatGrid = { beats: GridBeat[]; bars: GridBar[] }

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Median beat length of the detected beats between `from` and `to` (NaN without any). */
function detectedBeatLength(beats: number[], from: number, to: number): number {
  const gaps: number[] = []
  for (let i = 1; i < beats.length; i++) if (beats[i - 1] >= from - 1e-6 && beats[i] <= to + 1e-6) gaps.push(beats[i] - beats[i - 1])
  return median(gaps)
}

/** Detected tempo and meter between two times, to start a manual marker from; null without detected beats there. */
export function detectedTempo(a: Analysis | null, from: number, to: number): { bpm: number; num: number; den: number } | null {
  if (!a) return null
  let len = detectedBeatLength(a.beats, from, to)
  if (!Number.isFinite(len)) len = detectedBeatLength(a.beats, 0, Infinity)
  const bpm = Number.isFinite(len) && len > 0 ? 60 / len : a.bpm
  if (!bpm) return null
  return { bpm: clampBpm(bpm), num: Math.min(MAX_NUM, Math.max(1, Math.round(a.beatsPerBar))), den: 4 }
}

/** The beats a tempo map puts on the song: manual segments on their grid, auto segments on the detected beats. */
export function buildGrid(markers: TempoMarker[], analysis: Analysis | null, duration: number): BeatGrid {
  // Without the song's length the last manual segment would never end.
  if (!(duration > 0) || !Number.isFinite(duration)) return { beats: [], bars: [] }
  type Raw = { time: number; downbeat: boolean; den: number; auto: boolean; meter: number }
  const raw: Raw[] = []
  const end = duration
  const detected = analysis?.beats ?? []
  const downs = new Set((analysis?.downbeats ?? []).map((d) => Math.round(d * 1000)))
  const meter = Math.min(MAX_BAR_BEATS, Math.max(1, Math.round(analysis?.beatsPerBar ?? 4)))
  markers.forEach((m, k) => {
    const start = m.time
    const stop = Math.min(end, markers[k + 1]?.time ?? end)
    if (stop <= start) return
    if (m.kind === "manual") {
      const len = beatLength(m)
      for (let j = 0; j < 100_000; j++) {
        const time = start + j * len
        if (time >= stop - 1e-6 || !Number.isFinite(time)) break
        raw.push({ time, downbeat: j % m.num === 0, den: m.den, auto: false, meter: m.num })
      }
      return
    }
    let len = detectedBeatLength(detected, start, stop)
    if (!Number.isFinite(len)) len = detectedBeatLength(detected, 0, Infinity)
    const edge = Number.isFinite(len) ? len * EDGE_SHARE : 0
    // The song's start keeps the detected pickup; a later auto marker is itself a downbeat.
    if (k > 0) raw.push({ time: start, downbeat: true, den: 4, auto: true, meter })
    const from = k > 0 ? start + edge : start
    const next = markers[k + 1]
    const to = next ? stop - edge : stop
    const i0 = Math.max(0, lastAtOrBefore(detected, from - 1e-9) + 1)
    for (let i = i0; i < detected.length && detected[i] < to; i++) {
      const time = detected[i]
      if (time < from) continue
      raw.push({ time, downbeat: downs.has(Math.round(time * 1000)), den: 4, auto: true, meter })
    }
  })

  // Bars: a new one on every downbeat; beats before the first downbeat are the pickup (bar 0). A stretch longer than
  // MAX_BAR_BEATS without a downbeat (notation cannot hold it) is cut into bars of the song's meter.
  const groups: Raw[][] = []
  for (const r of raw) {
    if (r.downbeat || groups.length === 0) groups.push([r])
    else groups[groups.length - 1].push(r)
  }
  const pieces = groups.flatMap((g, gi) => {
    // Only detected stretches without downbeats are cut; a manual meter (up to 32 beats) stays one bar.
    if (g.length <= MAX_BAR_BEATS || !g[0].auto) return [{ g, pickup: gi === 0 && !g[0].downbeat }]
    const size = Math.min(MAX_BAR_BEATS, g[0].meter || meter)
    const out: { g: Raw[]; pickup: boolean }[] = []
    for (let i = 0; i < g.length; i += size) out.push({ g: g.slice(i, i + size), pickup: false })
    return out
  })
  const beats: GridBeat[] = []
  const bars: GridBar[] = []
  let bar = 0
  for (const { g, pickup } of pieces) {
    if (!pickup) bar += 1
    const n = pickup ? 0 : bar
    bars.push({ bar: n, start: g[0].time, end: g[0].time, first: beats.length, count: g.length, den: g[0].den, auto: g[0].auto })
    g.forEach((r, j) => beats.push({ time: r.time, bar: n, beat: j + 1, downbeat: j === 0 && !pickup, den: r.den, auto: r.auto }))
  }
  bars.forEach((b, i) => {
    b.end = bars[i + 1]?.start ?? end
  })
  return { beats, bars }
}

/** Tempo at `t`: the manual marker's BPM, or the local detected tempo (median of the nearby beats). */
export function tempoAt(markers: TempoMarker[], grid: BeatGrid, t: number): number | null {
  const m = markers[markerIndexAt(markers, t)]
  if (m?.kind === "manual") return m.bpm
  const times = grid.beats.map((b) => b.time)
  const i = lastAtOrBefore(times, t)
  const gaps: number[] = []
  for (let j = Math.max(1, i - 3); j <= Math.min(times.length - 1, i + 4); j++) if (grid.beats[j].auto && grid.beats[j - 1].auto) gaps.push(times[j] - times[j - 1])
  const len = median(gaps)
  return Number.isFinite(len) && len > 0 ? 60 / len : null
}

/** Metronome clicks for a grid: every beat, accented on downbeats. */
export const gridClicks = (grid: BeatGrid) => grid.beats.map((b) => ({ time: b.time, accent: b.downbeat }))
