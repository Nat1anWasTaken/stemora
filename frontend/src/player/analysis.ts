export type ChordSegment = { start: number; end: number; label: string }
/** Drum kinds in chart order, top to bottom (as on a drum staff: cymbals high, kick low). */
export const DRUM_KINDS = ["cymbal", "hihat", "tom", "snare", "kick"] as const
export type DrumKind = (typeof DRUM_KINDS)[number]
export const DRUM_NAMES: Record<DrumKind, { short: string; name: string }> = {
  cymbal: { short: "CY", name: "cymbal" },
  hihat: { short: "HH", name: "hi-hat" },
  tom: { short: "TM", name: "tom" },
  snare: { short: "SN", name: "snare" },
  kick: { short: "BD", name: "kick" },
}
/** Per kind: [beat index, slot 0..11 in twelfths of that beat] (see docs/contract.md). */
export type DrumHits = Record<DrumKind, [number, number][]>
export type Analysis = {
  bpm: number | null
  /** Estimated song key, e.g. "Eb" or "Dm"; null for older analyses. */
  key: string | null
  beatsPerBar: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
  drums: DrumHits | null
}
/** One beat of the drum chart: `grid` steps (4 = 16ths, 3 = triplets), `hits[step]` = kinds struck there. */
export type DrumBeat = { time: number; end: number; grid: 3 | 4; hits: DrumKind[][] }
/**
 * One beat of the song as shown in the chord strip and chart. `chord` is set where a chord starts and repeated on
 * downbeats (`held` then marks the repeat); "N" means no chord.
 */
export type BeatCell = { time: number; beat: number; bar: number; chord: string | null; held: boolean }
/** One bar of the chord chart; `end` is where the next bar starts (or the song ends). */
export type Bar = { bar: number; start: number; end: number; cells: BeatCell[] }

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
    key: typeof j.key === "string" && /^[A-G][b#]?m?$/.test(j.key) ? j.key : null,
    beatsPerBar: isNum(j.beats_per_bar) && j.beats_per_bar > 0 ? j.beats_per_bar : 4,
    beats,
    downbeats: j.downbeats.filter(isNum),
    chords,
    drums: parseDrums(j.drums, beats.length),
  }
}

const SLOTS = 12

/** Lenient: keeps well-formed hits only; null when nothing is left (field missing, or no drums detected). */
function parseDrums(json: unknown, nBeats: number): DrumHits | null {
  if (!json || typeof json !== "object") return null
  const j = json as Record<string, unknown>
  let total = 0
  const out = {} as DrumHits
  for (const kind of DRUM_KINDS) {
    const list = Array.isArray(j[kind]) ? (j[kind] as unknown[]) : []
    out[kind] = list.flatMap((h): [number, number][] => {
      if (!Array.isArray(h) || h.length !== 2) return []
      const [b, slot] = h as unknown[]
      return Number.isInteger(b) && Number.isInteger(slot) && (b as number) >= 0 && (b as number) < nBeats && (slot as number) >= 0 && (slot as number) < SLOTS
        ? [[b as number, slot as number]]
        : []
    })
    total += out[kind].length
  }
  return total > 0 ? out : null
}

/**
 * Drum chart cells, one per entry of `a.beats`. A beat uses triplets when any hit sits on a triplet slot (4 or 8),
 * else 16ths. The last beat lasts as long as the one before it.
 */
export function buildDrumBeats(a: Analysis): DrumBeat[] {
  const { beats } = a
  const out: DrumBeat[] = beats.map((time, i) => {
    const prev = i > 0 ? time - beats[i - 1] : 0.5
    return { time, end: beats[i + 1] ?? time + prev, grid: 4, hits: [] }
  })
  if (!a.drums) return out.map((b) => ({ ...b, hits: [[], [], [], []] }))
  for (const kind of DRUM_KINDS) for (const [i, slot] of a.drums[kind]) if (slot % 4 === 0 && slot % 3 !== 0) out[i].grid = 3
  for (const b of out) b.hits = Array.from({ length: b.grid }, () => [])
  for (const kind of DRUM_KINDS) {
    for (const [i, slot] of a.drums[kind]) {
      const b = out[i]
      const step = Math.min(b.grid - 1, Math.round((slot * b.grid) / SLOTS))
      if (!b.hits[step].includes(kind)) b.hits[step].push(kind)
    }
  }
  return out
}

/** Start time of each step of a drum beat. */
export function stepTimes(b: DrumBeat): number[] {
  return Array.from({ length: b.grid }, (_, k) => b.time + (k * (b.end - b.time)) / b.grid)
}

/** Screen-reader summary of a drum beat, e.g. "kick, hi-hat ×2" (kick first, as a drummer reads it). */
export function describeDrumBeat(b: DrumBeat): string {
  const counts = new Map<DrumKind, number>()
  for (const step of b.hits) for (const k of step) counts.set(k, (counts.get(k) ?? 0) + 1)
  const order = [...DRUM_KINDS].reverse().filter((k) => counts.has(k))
  return order.length ? order.map((k) => `${DRUM_NAMES[k].name}${counts.get(k)! > 1 ? ` ×${counts.get(k)}` : ""}`).join(", ") : "rest"
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
    const shown = !!label && (changed || beat === 1)
    return { time, beat, bar, chord: shown ? label : null, held: shown && !changed }
  })
}

/** Group beat cells into bars (pickup beats form bar 0). */
export function buildBars(cells: BeatCell[], duration: number): Bar[] {
  const bars: Bar[] = []
  for (const c of cells) {
    const last = bars.at(-1)
    if (last && last.bar === c.bar) last.cells.push(c)
    else bars.push({ bar: c.bar, start: c.time, end: duration, cells: [c] })
  }
  bars.forEach((b, i) => {
    if (i + 1 < bars.length) b.end = bars[i + 1].start
  })
  return bars
}

/** Split "Abmaj7" into the root ("Ab") and the quality suffix ("maj7"). */
export function splitChord(label: string): { root: string; suffix: string } {
  const m = /^([A-G][b#]?)(.*)$/.exec(label)
  return m ? { root: m[1], suffix: m[2] } : { root: label, suffix: "" }
}

const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

/** Move a chord or key label ("Abmaj7", "Dm", "N") by `semitones`, spelled with flats like the worker's labels. */
export function transposeChord(label: string, semitones: number): string {
  if (semitones === 0) return label
  const { root, suffix } = splitChord(label)
  const i = FLATS.includes(root) ? FLATS.indexOf(root) : SHARPS.indexOf(root)
  if (i < 0) return label
  return FLATS[(((i + semitones) % 12) + 12) % 12] + suffix
}
