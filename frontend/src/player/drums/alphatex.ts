import type { DrumKind } from "@/player/analysis"
import type { QBar, QBeat } from "@/player/drums/quantize"

/** GP7 percussion articulation ids (as alphaTab numbers them). The model's merged classes get the most common line. */
const ARTICULATIONS: Record<DrumKind, number> = { kick: 36, snare: 38, hihat: 42, tom: 47, cymbal: 49 }
/**
 * Two voices, as drum charts are written: hands (cymbals, toms, snare) with stems up, feet (kick) with stems down.
 * The stem directions and the kick voice's rests are set on the loaded score (see `styleDrumScore`).
 */
export const VOICES: DrumKind[][] = [["cymbal", "hihat", "tom", "snare"], ["kick"]]

export type FlatSyncPoint = { barIndex: number; barPosition: number; barOccurence: number; millisecondOffset: number }

/** Plain and dotted values in 32nds, longest first, as alphaTex durations. */
const VALUES: { len: number; tex: string }[] = [
  { len: 8, tex: "4" },
  { len: 6, tex: "8{d}" },
  { len: 4, tex: "8" },
  { len: 3, tex: "16{d}" },
  { len: 2, tex: "16" },
  { len: 1, tex: "32" },
]
/** Whole-bar rests in quarters. */
const BAR_RESTS: { len: number; tex: string }[] = [
  { len: 4, tex: "1" },
  { len: 3, tex: "2{d}" },
  { len: 2, tex: "2" },
  { len: 1, tex: "4" },
]

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

/** One beat of one voice as alphaTex beats. */
function beatTex(beat: QBeat, voice: DrumKind[]): string[] {
  const hits = beat.steps.map((kinds) => kinds.filter((k) => voice.includes(k)))
  if (hits.every((k) => k.length === 0)) return ["r.4"]
  if (beat.grid === 3 || beat.grid === 6) {
    // Triplets: one tuplet value per step keeps every group complete.
    const value = beat.grid === 3 ? "8" : "16"
    return hits.map((k) => `${k.length ? head(k) : "r"}.${value}{tu ${beat.grid}}`)
  }
  // Straight grids (1, 2, 4, 8 steps): a note lasts until the next hit in this voice; gaps become rests.
  const unit = 8 / beat.grid
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
 * beat so the notation follows the song's real (drifting) tempo.
 */
export function toAlphaTex(bars: QBar[], bpm: number | null): { tex: string; syncPoints: FlatSyncPoint[] } {
  const header = [
    `\\track("Drums")`,
    `\\instrument(percussion)`,
    `\\clef(neutral)`,
    ...Object.entries(ARTICULATIONS).map(([name, id]) => `\\articulation(${name} ${id})`),
    `\\tempo(${Math.round(bpm ?? 120)})`,
  ].join(" ")
  const voices = VOICES.map((voice) => {
    let meter = 0
    return bars
      .map((bar) => {
        const n = bar.beats.length
        const ts = n !== meter ? `\\ts(${n} 4) ` : ""
        meter = n
        const empty = bar.beats.every((b) => b.steps.every((k) => !k.some((x) => voice.includes(x))))
        const body = empty ? split(n, BAR_RESTS).map((d) => `r.${d}`) : bar.beats.flatMap((b) => beatTex(b, voice))
        return ts + body.join(" ")
      })
      .join(" | ")
  })
  const syncPoints = bars.flatMap((bar, barIndex) =>
    bar.beats.map((b, j) => ({ barIndex, barPosition: j / bar.beats.length, barOccurence: 0, millisecondOffset: Math.round(b.time * 1000) })),
  )
  return { tex: `${header} ${voices.map((v) => `\\voice ${v}`).join(" ")}`, syncPoints }
}
