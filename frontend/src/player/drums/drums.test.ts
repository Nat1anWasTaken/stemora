import { describe, expect, it } from "vitest"
import * as alphaTab from "@coderline/alphatab"
import { parseAnalysis, type Analysis } from "@/player/analysis"
import { toAlphaTex } from "@/player/drums/alphatex"
import { chooseGrid, quantize } from "@/player/drums/quantize"

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
    const bars = quantize(a, "auto", true, 4)
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
    const a = song({ tom: [3.5, 3.5625, 3.625, 3.6875] })
    expect(quantize(a, "32", false, 4)[1].beats[3].grid).toBe(8)
    expect(quantize(a, "auto", false, 4)[1].beats[3].grid).toBe(8)
    const coarse = quantize(a, "16", false, 4)[1].beats[3]
    expect(coarse.grid).toBe(4)
    expect(coarse.steps.flat()).toEqual(["tom", "tom", "tom"]) // four 32nds land on three 16th steps
  })
})

/** Parse alphaTex with alphaTab itself; returns the score and every diagnostic message. */
function parse(tex: string) {
  const imp = new alphaTab.importer.AlphaTexImporter()
  imp.initFromString(tex, new alphaTab.Settings())
  const score = imp.readScore()
  const diags = [...(imp.lexerDiagnostics ?? []), ...(imp.parserDiagnostics ?? []), ...(imp.semanticDiagnostics ?? [])].map((d) => d.message)
  return { score, diags }
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
      const bars = quantize(a, precision, triplets, 4)
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

  it("handles pickup bars and meter changes", () => {
    const b = parseAnalysis({ version: 1, beats: [0, 1, 2, 3, 4, 5], downbeats: [1, 4], chords: [], drums: { kick: [0, 1, 2, 3, 4, 5, 1.5, 4.5] } })!
    const { tex } = toAlphaTex(quantize(b, "auto", true, 6), null)
    const { score, diags } = parse(tex)
    expect(diags).toEqual([])
    expect(score.masterBars.map((m) => m.timeSignatureNumerator)).toEqual([1, 3, 2])
  })
})
