import { describe, expect, it } from "vitest"
import * as alphaTab from "@coderline/alphatab"
import { DRUM_KINDS, parseAnalysis, type Analysis } from "@/player/analysis"
import { ARTICULATIONS, toAlphaTex, VOICES } from "@/player/drums/alphatex"
import { hideCoveredRests } from "@/player/drums/hide-rests"
import { chooseGrid, quantize } from "@/player/drums/quantize"
import { buildGrid, defaultMarkers } from "@/player/tempo-map"

const grid = (a: Analysis, duration: number) => buildGrid(defaultMarkers(), a, duration)

// 120 BPM, 4/4, two bars: beats every 0.5 s from 0.
const base = { version: 1, bpm: 120, beats_per_bar: 4, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], downbeats: [0, 2], chords: [] }
const song = (drums: Record<string, unknown>): Analysis => parseAnalysis({ ...base, drums })!

describe("drum parsing", () => {
  it("reads onset times and the legacy [beat, slot] pairs", () => {
    expect(song({ kick: [1, 0, -1, "x"] }).drums!.kick).toEqual([0, 1])
    expect(song({ kick: [[1, 6], [0, 0], [9, 0], [0, 12]] }).drums!.kick).toEqual([0, 0.75])
    expect(parseAnalysis({ ...base, drums: { kick: [] } })!.drums).toBeNull()
    expect(parseAnalysis(base)!.drums).toBeNull()
  })

  it("folds the 5-class files' tom and cymbal into tom_mid and crash, and ignores unknown kinds", () => {
    const d = song({ tom: [1, 0.5], cymbal: [0], tom_mid: [2], hihat: [0.25], cowbell2: [1], constructor: [1] }).drums!
    expect(d.tom_mid).toEqual([0.5, 1, 2])
    expect(d.crash).toEqual([0])
    expect(d.hihat).toEqual([0.25])
    expect(DRUM_KINDS.reduce((n, k) => n + d[k].length, 0)).toBe(5)
  })
})

describe("quantize", () => {
  it("picks grids per precision", () => {
    expect(chooseGrid([], 0.5, "16", true)).toBe(1)
    expect(chooseGrid([0, 0.5], 0.5, "16", true)).toBe(4)
    expect(chooseGrid([0, 1 / 3, 2 / 3], 0.5, "16", true)).toBe(6)
    expect(chooseGrid([0, 1 / 3, 2 / 3], 0.5, "16", false)).toBe(4)
    expect(chooseGrid([0, 1 / 3, 2 / 3], 0.5, "8", true)).toBe(3)
    expect(chooseGrid([0, 0.5], 0.5, "auto", true)).toBe(2)
    expect(chooseGrid([0, 1 / 3, 2 / 3], 0.5, "auto", true)).toBe(3)
    expect(chooseGrid([0, 0.125], 0.5, "auto", true)).toBe(8)
    expect(chooseGrid([0, 0.125], 0.5, "16", true)).toBe(4)
    expect(chooseGrid([0.02, 0.52], 0.5, "auto", true)).toBe(2) // timing jitter still reads as 8ths
  })

  it("places hits on steps, rolls late hits over and drops outside ones", () => {
    const a = song({ kick: [0, 1.0, 1.49, 4.2], hihat: [0.012, 0.25, 0.5, 0.75], snare: [-1] })
    const bars = quantize(a, "auto", true, grid(a, 4))
    expect(bars.map((b) => b.beats.length)).toEqual([4, 4])
    const [b0, b1, b2, b3] = bars[0].beats
    expect(b0.grid).toBe(2)
    expect(b0.steps).toEqual([["hihat", "kick"], ["hihat"]])
    expect(b1.steps).toEqual([["hihat"], ["hihat"]])
    expect(b2.steps).toEqual([["kick"]])
    expect(b3.steps).toEqual([["kick"]]) // 1.49 rounds onto beat 4
    expect(bars[1].beats.every((b) => b.steps.flat().length === 0)).toBe(true) // 4.2 is past the song
  })

  it("keeps 32nds only at 32nd or auto precision", () => {
    const a = song({ tom_floor: [3.5, 3.5625, 3.625, 3.6875] })
    expect(quantize(a, "32", false, grid(a, 4))[1].beats[3].grid).toBe(8)
    expect(quantize(a, "auto", false, grid(a, 4))[1].beats[3].grid).toBe(8)
    const coarse = quantize(a, "16", false, grid(a, 4))[1].beats[3]
    expect(coarse.grid).toBe(4)
    expect(coarse.steps.flat()).toEqual(["tom_floor", "tom_floor", "tom_floor"]) // four 32nds land on three 16th steps
  })
})

/** Parse alphaTex with alphaTab itself; returns the score and every diagnostic message. */
function parse(tex: string) {
  const imp = new alphaTab.importer.AlphaTexImporter()
  imp.initFromString(tex, new alphaTab.Settings())
  let score: alphaTab.model.Score | null = null
  try {
    score = imp.readScore()
  } catch {
    // the diagnostics below say why
  }
  const diags = [...(imp.lexerDiagnostics ?? []), ...(imp.parserDiagnostics ?? []), ...(imp.semanticDiagnostics ?? [])].map((d) => d.message)
  return { score: score!, diags }
}

describe("toAlphaTex", () => {
  const a = song({
    kick: [0, 0.875, 1, 2, 3],
    snare: [0.5, 1.5, 2.5, 3.5],
    hihat: [0, 0.25, 0.5, 0.75, 1, 1.25, 2, 2 + 1 / 6, 2 + 1 / 3],
    cymbal: [0],
    tom: [3.5, 3.5625, 3.625, 3.6875, 3.75],
  })

  for (const [precision, triplets] of [["auto", true], ["16", false], ["32", true], ["8", true]] as const) {
    it(`renders a valid percussion score (${precision}${triplets ? ", triplets" : ""})`, () => {
      const bars = quantize(a, precision, triplets, grid(a, 4))
      const { tex, syncPoints } = toAlphaTex(bars, 120)
      const { score, diags } = parse(tex)
      expect(diags).toEqual([])
      expect(score.masterBars).toHaveLength(2)
      const staff = score.tracks[0].staves[0]
      expect(staff.isPercussion).toBe(true)
      expect(staff.showTablature).toBe(false)
      for (const bar of staff.bars) {
        const expected = score.masterBars[bar.index].calculateDuration()
        for (const voice of bar.voices) {
          if (voice.isEmpty) continue
          expect(voice.beats.reduce((s, b) => s + b.playbackDuration, 0)).toBe(expected)
        }
      }
      expect(syncPoints).toHaveLength(8)
      expect(syncPoints[5]).toEqual({ barIndex: 1, barPosition: 0.25, barOccurence: 0, millisecondOffset: 2500 })
    })
  }

  it("marks the bars where song parts start", () => {
    const bars = quantize(a, "auto", true, grid(a, 4))
    const { tex } = toAlphaTex(bars, 120, new Map([[0, "Intro"], [1, "Chorus 1"]]))
    const { score, diags } = parse(tex)
    expect(diags).toEqual([])
    expect(score.masterBars.map((m) => m.section?.text ?? null)).toEqual(["Intro", "Chorus 1"])
    expect(score.masterBars).toHaveLength(2)
  })

  it("handles pickup bars and meter changes", () => {
    const b = parseAnalysis({ version: 1, beats: [0, 1, 2, 3, 4, 5], downbeats: [1, 4], chords: [], drums: { kick: [0, 1, 2, 3, 4, 5, 1.5, 4.5] } })!
    const { tex } = toAlphaTex(quantize(b, "auto", true, grid(b, 6)), null)
    const { score, diags } = parse(tex)
    expect(diags).toEqual([])
    expect(score.masterBars.map((m) => m.timeSignatureNumerator)).toEqual([1, 3, 2])
  })
})

describe("drum kinds", () => {
  it("draws every kind on its own articulation, feet in the second voice", () => {
    const drums = Object.fromEntries(DRUM_KINDS.map((k, i) => [k, [(i % 8) * 0.5]]))
    const { tex } = toAlphaTex(quantize(song(drums), "auto", true, grid(song(drums), 4)), 120)
    const { score, diags } = parse(tex)
    expect(diags).toEqual([])
    const track = score.tracks[0]
    const drawn = new Map<number, number>() // articulation -> voice
    for (const bar of track.staves[0].bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) for (const n of beat.notes) drawn.set(track.percussionArticulations[n.percussionArticulation].outputMidiNumber, voice.index)
      }
    }
    for (const kind of DRUM_KINDS) expect(drawn.get(ARTICULATIONS[kind]), kind).toBe(VOICES[1].includes(kind) ? 1 : 0)
    expect(VOICES[1]).toEqual(["kick", "hihat_pedal"])
    expect(new Set(Object.values(ARTICULATIONS)).size).toBe(DRUM_KINDS.length)
  })
})

describe("hideCoveredRests", () => {
  it("hides rests the other voice sounds through, keeps rests where both are silent", () => {
    // Beat 1 kick, 2 hands, 3 kick + kick on the "and", 4 hands; then a bar with a silent last beat.
    const tex = String.raw`\track("Drums") \instrument(percussion) \clef(neutral) \articulation(kick 36) \articulation(snare 38)
      \voice r.4 snare.4 r.4 snare.4 | snare.4 snare.4 snare.4 r.4
      \voice kick.4 r.4 kick.8 kick.8 r.4 | r.1`
    const { score, diags } = parse(tex)
    expect(diags).toEqual([])
    hideCoveredRests(score)
    const shown = (bar: number, voice: number) =>
      score.tracks[0].staves[0].bars[bar].voices[voice].beats.filter((b) => b.isRest && !b.isEmpty).length
    expect([shown(0, 0), shown(0, 1)]).toEqual([0, 0])
    // Bar 2: nobody plays beat 4, so both rests stay (the kick's whole-bar rest is not fully covered).
    expect([shown(1, 0), shown(1, 1)]).toEqual([1, 1])
  })
})

describe("long bars", () => {
  it("cuts stretches without downbeats into bars of the song's meter", () => {
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5)
    const a = parseAnalysis({ version: 1, bpm: 120, beats_per_bar: 4, beats, downbeats: [], chords: [], drums: { kick: beats } })!
    const bars = quantize(a, "auto", true, grid(a, 20))
    expect(bars.map((b) => b.beats.length)).toEqual(Array(10).fill(4))
    const { score, diags } = parse(toAlphaTex(bars, 120).tex)
    expect(diags).toEqual([])
    expect(score.masterBars).toHaveLength(10)
  })
})

describe("toAlphaTex fuzz", () => {
  // Small seeded PRNG (mulberry32) so failures reproduce.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const KINDS = [...DRUM_KINDS, "tom", "cymbal"] // the 5-class files' kinds too

  for (let seed = 1; seed <= 60; seed++) {
    it(`parses random songs cleanly (seed ${seed})`, () => {
      const r = rng(seed)
      // Drifting tempo, a pickup, meters of 1..7 beats, sometimes no downbeats at all.
      const beats: number[] = []
      let t = r() * 0.8
      const n = 8 + Math.floor(r() * 60)
      for (let i = 0; i < n; i++) {
        beats.push(t)
        t += 0.3 + r() * 0.4
      }
      const downbeats: number[] = []
      if (r() > 0.1) {
        let i = Math.floor(r() * 4)
        while (i < beats.length) {
          downbeats.push(beats[i])
          i += 1 + Math.floor(r() * 7)
        }
      }
      const end = t + r()
      const drums: Record<string, number[]> = {}
      for (const k of KINDS) {
        const hits: number[] = []
        const density = r() * 3
        for (let x = r() * 0.5; x < end + 0.5; x += 0.02 + r() * (1 / (density + 0.1))) hits.push(x - 0.2)
        if (r() > 0.2) drums[k] = hits
      }
      const a = parseAnalysis({ version: 1, bpm: r() > 0.2 ? 60 + r() * 120 : null, beats_per_bar: 4, beats, downbeats, chords: [], drums })
      if (!a?.drums) return
      for (const precision of ["auto", "8", "16", "32"] as const) {
        for (const triplets of [true, false]) {
          const bars = quantize(a, precision, triplets, grid(a, end))
          const { tex, syncPoints } = toAlphaTex(bars, a.bpm)
          const { score, diags } = parse(tex)
          expect(diags, `${precision} ${triplets}`).toEqual([])
          expect(score.masterBars).toHaveLength(bars.length)
          for (const bar of score.tracks[0].staves[0].bars) {
            const expected = score.masterBars[bar.index].calculateDuration()
            for (const voice of bar.voices) {
              if (voice.isEmpty) continue
              expect(voice.beats.reduce((s, b) => s + b.playbackDuration, 0), `${precision} ${triplets} bar ${bar.index}`).toBe(expected)
            }
          }
          for (let i = 1; i < syncPoints.length; i++) expect(syncPoints[i].millisecondOffset).toBeGreaterThanOrEqual(syncPoints[i - 1].millisecondOffset)
        }
      }
    })
  }
})
