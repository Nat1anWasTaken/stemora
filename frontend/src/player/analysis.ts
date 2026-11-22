import type { BeatGrid } from "@/player/tempo-map"

export type ChordSegment = { start: number; end: number; label: string }
/** The model's drum classes (cymbal = crash/ride/splash/china, hihat = open/closed/pedal, tom = all toms). */
export const DRUM_KINDS = ["cymbal", "hihat", "tom", "snare", "kick"] as const
export type DrumKind = (typeof DRUM_KINDS)[number]
/** Per kind: onset times in seconds, sorted (see docs/contract.md). */
export type DrumHits = Record<DrumKind, number[]>
/** Song structure labels from the worker (docs/contract.md); "inst" is an instrumental part. */
export const SECTION_KINDS = ["intro", "verse", "prechorus", "chorus", "bridge", "inst", "outro", "silence"] as const
export type SectionKind = (typeof SECTION_KINDS)[number]
/** One part of the song; `name` is the display name, numbered when the kind repeats ("Chorus 2"). */
export type Section = { start: number; end: number; kind: SectionKind; name: string }
export type Analysis = {
  bpm: number | null
  /** Estimated song key, e.g. "Eb" or "Dm"; null for older analyses. */
  key: string | null
  beatsPerBar: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
  drums: DrumHits | null
  /** Song parts in order, contiguous; empty for older analyses or when detection failed. */
  sections: Section[]
}
/**
 * One beat of the song as shown in the chord strip and chart. `chord` is set where a chord starts and repeated on
 * downbeats (`held` then marks the repeat); "N" means no chord.
 */
export type BeatCell = { time: number; beat: number; bar: number; chord: string | null; held: boolean }
/** One bar of the chord chart; `end` is where the next bar starts (or the song ends). */
export type Bar = { bar: number; start: number; end: number; den: number; cells: BeatCell[] }

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
    drums: parseDrums(j.drums, beats),
    sections: parseSections(j.sections),
  }
}

const SECTION_NAME: Record<SectionKind, string> = {
  intro: "Intro",
  verse: "Verse",
  prechorus: "Pre-chorus",
  chorus: "Chorus",
  bridge: "Bridge",
  inst: "Instrumental",
  outro: "Outro",
  silence: "Silence",
}

/** Lenient: keeps well-formed sections with a known label, in time order; repeated kinds get a number. */
export function parseSections(json: unknown): Section[] {
  if (!Array.isArray(json)) return []
  const kinds: readonly string[] = SECTION_KINDS
  const list = json
    .flatMap((x): Omit<Section, "name">[] => {
      const s = x as { start?: unknown; end?: unknown; label?: unknown } | null
      return s && isNum(s.start) && isNum(s.end) && s.end > s.start && typeof s.label === "string" && kinds.includes(s.label)
        ? [{ start: s.start, end: s.end, kind: s.label as SectionKind }]
        : []
    })
    .sort((a, b) => a.start - b.start)
  const total = new Map<SectionKind, number>()
  for (const s of list) total.set(s.kind, (total.get(s.kind) ?? 0) + 1)
  const seen = new Map<SectionKind, number>()
  return list.map((s) => {
    const n = (seen.get(s.kind) ?? 0) + 1
    seen.set(s.kind, n)
    return { ...s, name: (total.get(s.kind) ?? 0) > 1 ? `${SECTION_NAME[s.kind]} ${n}` : SECTION_NAME[s.kind] }
  })
}

/**
 * The parts with each boundary moved to the nearest bar line of the beat grid (the tempo map as it is now, edits
 * included), so jumps and loops land on a bar. The song's start stays where it is, and the pickup's first beat is not
 * a bar line. A part whose boundaries meet on one bar line drops out, and its neighbours close the gap. Without bars
 * the parts are returned as they are.
 */
export function snapSections(sections: Section[], grid: BeatGrid): Section[] {
  const lines = grid.bars.filter((b) => b.bar > 0).map((b) => b.start)
  if (sections.length === 0 || lines.length === 0) return sections
  const nearest = (t: number) => {
    const i = lastAtOrBefore(lines, t)
    if (i < 0) return lines[0]
    if (i + 1 >= lines.length) return lines[i]
    return t - lines[i] <= lines[i + 1] - t ? lines[i] : lines[i + 1]
  }
  const starts: number[] = []
  sections.forEach((s, i) => starts.push(i === 0 ? s.start : Math.max(starts[i - 1], nearest(s.start))))
  return sections.flatMap((s, i) => {
    const start = starts[i]
    const end = i + 1 < sections.length ? starts[i + 1] : s.end
    return end - start > 1e-6 ? [{ ...s, start, end }] : []
  })
}

/**
 * The section that starts inside each bar, keyed by the bar's start time. A section start that is not on a bar line
 * (no downbeat near it) is shown on the bar it falls in.
 */
export function sectionsByBar(sections: Section[], bars: { start: number; end: number }[]): Map<number, Section> {
  const out = new Map<number, Section>()
  if (bars.length === 0) return out
  const starts = bars.map((b) => b.start)
  for (const s of sections) {
    const i = Math.max(0, lastAtOrBefore(starts, s.start + 0.05))
    if (!out.has(bars[i].start)) out.set(bars[i].start, s)
  }
  return out
}

const SLOTS = 12

/**
 * Lenient: keeps well-formed hits only; null when nothing is left (field missing, or no drums detected).
 * Accepts onset times (current) and the first release's `[beat index, slot in twelfths]` pairs.
 */
function parseDrums(json: unknown, beats: number[]): DrumHits | null {
  if (!json || typeof json !== "object") return null
  const j = json as Record<string, unknown>
  const beatLen = (b: number) => (beats[b + 1] ?? beats[b] + (b > 0 ? beats[b] - beats[b - 1] : 0.5)) - beats[b]
  let total = 0
  const out = {} as DrumHits
  for (const kind of DRUM_KINDS) {
    const list = Array.isArray(j[kind]) ? (j[kind] as unknown[]) : []
    out[kind] = list
      .flatMap((h): number[] => {
        if (isNum(h)) return h >= 0 ? [h] : []
        if (!Array.isArray(h) || h.length !== 2) return []
        const [b, slot] = h as unknown[]
        if (!Number.isInteger(b) || !Number.isInteger(slot) || (b as number) < 0 || (b as number) >= beats.length || (slot as number) < 0 || (slot as number) >= SLOTS) return []
        return [beats[b as number] + ((slot as number) / SLOTS) * beatLen(b as number)]
      })
      .sort((x, y) => x - y)
    total += out[kind].length
  }
  return total > 0 ? out : null
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

/** Beats of a grid with their chord changes. */
export function buildCells(grid: BeatGrid, chords: ChordSegment[]): BeatCell[] {
  let ci = -1
  const starts = chords.map((c) => c.start)
  return grid.beats.map(({ time, beat, bar }) => {
    // A chord label is shown on the beat where the chord changes, and again on every bar's first beat.
    const idx = lastAtOrBefore(starts, time + 0.01)
    const changed = idx !== ci
    ci = idx
    const label = idx >= 0 ? chords[idx].label : null
    const shown = !!label && (changed || beat === 1)
    return { time, beat, bar, chord: shown ? label : null, held: shown && !changed }
  })
}

/** Group beat cells into the grid's bars (pickup = bar 0). */
export function buildBars(cells: BeatCell[], grid: BeatGrid): Bar[] {
  return grid.bars.map((b) => ({ bar: b.bar, start: b.start, end: b.end, den: b.den, cells: cells.slice(b.first, b.first + b.count) }))
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
