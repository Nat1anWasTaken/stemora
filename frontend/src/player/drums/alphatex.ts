import { DRUM_KINDS, type DrumKind } from "@/player/analysis"
import type { QBar, QBeat } from "@/player/drums/quantize"

/**
 * GP7 percussion articulation ids (as alphaTab 1.9 numbers them), which fix each kind's staff position and note head:
 * cymbals above the staff (crash and splash on the ledger line, china above it, ride on the top line), hi-hats x heads
 * above (open with a circle) and pedal below, toms high to low, snare (side stick as an x), kick in the bottom space.
 */
export const ARTICULATIONS: Record<DrumKind, number> = {
  crash: 49, china: 52, splash: 55, ride: 51, hihat: 42, hihat_open: 46, tambourine: 54, cowbell: 56,
  tom_high: 50, tom_mid: 48, snare: 38, sidestick: 37, tom_floor: 41, kick: 36, hihat_pedal: 44,
}
const FEET: DrumKind[] = ["kick", "hihat_pedal"]
/**
 * Two voices, as drum charts are written: hands (cymbals, toms, snare) with stems up, feet (kick, hi-hat pedal) with
 * stems down. The stem directions and the feet voice's rests are set on the loaded score (see `styleDrumScore`).
 */
export const VOICES: DrumKind[][] = [DRUM_KINDS.filter((k) => !FEET.includes(k)), FEET]

export type FlatSyncPoint = { barIndex: number; barPosition: number; barOccurence: number; millisecondOffset: number }

/** Plain and dotted values in 64ths, longest first, as alphaTex durations (nothing finer than a 32nd). */
const VALUES: { len: number; tex: string }[] = [
  { len: 32, tex: "2" },
  { len: 24, tex: "4{d}" },
  { len: 16, tex: "4" },
  { len: 12, tex: "8{d}" },
  { len: 8, tex: "8" },
  { len: 6, tex: "16{d}" },
  { len: 4, tex: "16" },
  { len: 2, tex: "32" },
]
/** Whole-bar rests in 64ths. */
const BAR_RESTS: { len: number; tex: string }[] = [
  { len: 64, tex: "1" },
  { len: 48, tex: "2{d}" },
  { len: 32, tex: "2" },
  { len: 24, tex: "4{d}" },
  { len: 16, tex: "4" },
  { len: 8, tex: "8" },
  { len: 4, tex: "16" },
]
/** Length of one beat (a `den` note) in 64ths. */
const beatLen = (den: number) => 64 / den

function head(kinds: DrumKind[]): string {
  return kinds.length === 1 ? kinds[0] : `(${kinds.join(" ")})`
}

/** Split a length into the fewest plain/dotted values. */
function split(len: number, values: { len: number; tex: string }[]): string[] {
  const out: string[] = []
  while (len > 0) {
    const v = values.find((x) => x.len <= len)!
    out.push(v.tex)
    len -= v.len
  }
  return out
}

/** One beat (a `den` note) of one voice as alphaTex beats. */
function beatTex(beat: QBeat, voice: DrumKind[], den: number): string[] {
  const hits = beat.steps.map((kinds) => kinds.filter((k) => voice.includes(k)))
  if (hits.every((k) => k.length === 0)) return split(beatLen(den), VALUES).map((d) => `r.${d}`)
  if (beat.grid === 3 || beat.grid === 6) {
    // Triplets: one tuplet value per step keeps every group complete.
    const value = (2 * den * beat.grid) / 3
    return hits.map((k) => `${k.length ? head(k) : "r"}.${value}{tu ${beat.grid}}`)
  }
  // Straight grids: a note lasts until the next hit in this voice; gaps become rests.
  const unit = beatLen(den) / beat.grid
  const out: string[] = []
  const starts = hits.flatMap((k, s) => (k.length ? [s] : []))
  if (starts[0] > 0) out.push(...split(starts[0] * unit, VALUES).map((d) => `r.${d}`))
  starts.forEach((s, n) => {
    const len = ((starts[n + 1] ?? beat.grid) - s) * unit
    const [first, ...rest] = split(len, VALUES)
    out.push(`${head(hits[s])}.${first}`, ...rest.map((d) => `r.${d}`))
  })
  return out
}

/**
 * Drum notation for alphaTab: a percussion track (neutral clef), one bar per analysis bar, plus one sync point per
 * beat so the notation follows the song's real (drifting) tempo. `sections` (bar index -> name) become section marks.
 */
export function toAlphaTex(bars: QBar[], bpm: number | null, sections?: Map<number, string>): { tex: string; syncPoints: FlatSyncPoint[] } {
  const header = [
    `\\track("Drums")`,
    `\\instrument(percussion)`,
    `\\clef(neutral)`,
    ...Object.entries(ARTICULATIONS).map(([name, id]) => `\\articulation(${name} ${id})`),
    `\\tempo(${Math.round(bpm ?? 120)})`,
  ].join(" ")
  const voices = VOICES.map((voice, v) => {
    let meter = ""
    return bars
      .map((bar, i) => {
        const n = bar.beats.length
        const den = bar.den
        const name = v === 0 ? sections?.get(i) : undefined
        // Section marks belong to the bar (not a voice): written once, in the first voice.
        const mark = name ? `\\section(${JSON.stringify(name)}) ` : ""
        const ts = mark + (`${n}/${den}` !== meter ? `\\ts(${n} ${den}) ` : "")
        meter = `${n}/${den}`
        const empty = bar.beats.every((b) => b.steps.every((k) => !k.some((x) => voice.includes(x))))
        const body = empty ? split(n * beatLen(den), BAR_RESTS).map((d) => `r.${d}`) : bar.beats.flatMap((b) => beatTex(b, voice, den))
        return ts + body.join(" ")
      })
      .join(" | ")
  })
  const syncPoints = bars.flatMap((bar, barIndex) =>
    bar.beats.map((b, j) => ({ barIndex, barPosition: j / bar.beats.length, barOccurence: 0, millisecondOffset: Math.round(b.time * 1000) })),
  )
  return { tex: `${header} ${voices.map((v) => `\\voice ${v}`).join(" ")}`, syncPoints }
}
