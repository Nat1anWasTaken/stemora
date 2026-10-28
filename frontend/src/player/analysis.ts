export type ChordSegment = { start: number; end: number; label: string }
export type Analysis = {
  bpm: number | null
  beatsPerBar: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
}
/** One beat of the song as shown in the chord strip. */
export type BeatCell = { time: number; beat: number; bar: number; chord: string | null }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

export function parseAnalysis(json: unknown): Analysis | null {
  if (!json || typeof json !== "object") return null
  const j = json as Record<string, unknown>
  if (j.version !== 1 || !Array.isArray(j.beats) || !Array.isArray(j.downbeats) || !Array.isArray(j.chords)) return null
  const beats = j.beats.filter(isNum)
  if (beats.length === 0) return null
  const chords = j.chords.flatMap((c): ChordSegment[] => {
    const s = c as Partial<ChordSegment> | null
    return s && isNum(s.start) && isNum(s.end) && typeof s.label === "string" ? [{ start: s.start, end: s.end, label: s.label }] : []
  })
  return {
    bpm: isNum(j.bpm) ? j.bpm : null,
    beatsPerBar: isNum(j.beats_per_bar) && j.beats_per_bar > 0 ? j.beats_per_bar : 4,
    beats,
    downbeats: j.downbeats.filter(isNum),
    chords,
  }
}

export async function fetchAnalysis(url: string): Promise<Analysis | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return parseAnalysis(await res.json())
  } catch {
    return null
  }
}

/** Index of the last element <= t in a sorted array (-1 if t precedes all of them). */
export function lastAtOrBefore(sorted: number[], t: number): number {
  let lo = 0
  let hi = sorted.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Beats annotated with bar/beat numbers (1-based; pickup beats before the first downbeat are bar 0) and chord changes. */
export function buildCells(a: Analysis): BeatCell[] {
  const downs = new Set(a.downbeats.map((d) => Math.round(d * 1000)))
  let bar = 0
  let beat = 0
  let ci = -1
  const starts = a.chords.map((c) => c.start)
  return a.beats.map((time) => {
    if (downs.has(Math.round(time * 1000))) {
      bar += 1
      beat = 1
    } else beat += 1
    // A chord label is shown on the beat where the chord changes, and again on every downbeat.
    const idx = lastAtOrBefore(starts, time + 0.01)
    const changed = idx !== ci
    ci = idx
    const label = idx >= 0 ? a.chords[idx].label : null
    return { time, beat, bar, chord: label && label !== "N" && (changed || beat === 1) ? label : null }
  })
}

/** Split "Abmaj7" into the root ("Ab") and the quality suffix ("maj7"). */
export function splitChord(label: string): { root: string; suffix: string } {
  const m = /^([A-G][b#]?)(.*)$/.exec(label)
  return m ? { root: m[1], suffix: m[2] } : { root: label, suffix: "" }
}
