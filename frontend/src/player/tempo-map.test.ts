import { describe, expect, it } from "vitest"
import * as alphaTab from "@coderline/alphatab"
import { parseAnalysis } from "@/player/analysis"
import { toAlphaTex } from "@/player/drums/alphatex"
import { quantize } from "@/player/drums/quantize"
import {
  buildGrid, defaultMarkers, detectedTempo, gridClicks, insertMarker, isLocked, moveMarker, normalizeMarkers, parseTimeSignature,
  removeMarker, snapTime, tempoAt, updateMarker, type ManualMarker, type TempoMarker,
} from "@/player/tempo-map"

const manual = (time: number, bpm: number, num = 4, den = 4): ManualMarker => ({ time, kind: "manual", bpm, num, den })
const auto = (time: number): TempoMarker => ({ time, kind: "auto" })
const times = (ms: TempoMarker[] | null) => ms?.map((m) => Math.round(m.time * 1000) / 1000)

// Detected: 120 BPM from 0.3 s, downbeat every 4 beats.
const detected = Array.from({ length: 40 }, (_, i) => 0.3 + i * 0.5)
const analysis = parseAnalysis({ version: 1, bpm: 120, beats_per_bar: 4, beats: detected, downbeats: detected.filter((_, i) => i % 4 === 0), chords: [] })!

describe("time signatures", () => {
  it("reads what people type", () => {
    expect(parseTimeSignature("6/8")).toEqual({ num: 6, den: 8 })
    expect(parseTimeSignature(" 7 8 ")).toEqual({ num: 7, den: 8 })
    expect(parseTimeSignature("12:8")).toEqual({ num: 12, den: 8 })
    expect(parseTimeSignature("3")).toEqual({ num: 3, den: 4 })
    expect(parseTimeSignature("4/3")).toBeNull()
    expect(parseTimeSignature("0/4")).toBeNull()
    expect(parseTimeSignature("abc")).toBeNull()
  })
})

describe("normalizeMarkers", () => {
  it("keeps a marker at 0:00, sorts, drops junk and puts locked markers on their grid", () => {
    expect(normalizeMarkers([])).toEqual(defaultMarkers())
    expect(normalizeMarkers(null)).toEqual(defaultMarkers())
    const n = normalizeMarkers([auto(10.1), manual(2, 120), { time: "x" }, manual(0.001, 60, 4, 3), auto(30)], 20)
    expect(n.map((m) => m.kind)).toEqual(["auto", "manual", "auto"])
    expect(times(n)).toEqual([0, 2, 10]) // 10.1 lands on the 120 BPM grid; 30 is past the song
  })
})

describe("snapping and ripple", () => {
  const map = [auto(0), manual(1, 120), manual(5, 60), auto(9)]

  it("snaps to a manual marker's grid only", () => {
    expect(snapTime(map, 3.2)).toBe(3)
    expect(snapTime(map, 0.73)).toBe(0.73) // after the auto marker: free
    expect(snapTime(map, 1.1)).toBe(1.5) // at least one beat after
    expect(isLocked(map, 2)).toBe(true)
    expect(isLocked(map, 1)).toBe(false)
  })

  it("moves locked markers a beat at a time and ripples what is locked behind", () => {
    expect(times(moveMarker(map, 2, 5.3))).toEqual([0, 1, 5.5, 9.5])
    expect(times(moveMarker(map, 1, 1.25))).toEqual([0, 1.25, 5.25, 9.25])
    expect(moveMarker(map, 0, 3)).toBeNull()
    expect(moveMarker(map, 2, 20, 12)).toBeNull() // pushes the auto marker past the song
  })

  it("re-times what is locked when the tempo changes, and frees or locks the next marker with the kind", () => {
    expect(times(updateMarker(map, 1, manual(1, 60)))).toEqual([0, 1, 9, 13]) // 8 beats at 60 BPM
    const freed = updateMarker(map, 1, auto(1))!
    expect(times(freed)).toEqual([0, 1, 5, 9])
    expect(times(updateMarker(freed, 1, manual(1, 100)))).toEqual([0, 1, 5.2, 9.2]) // relocked to the nearest 0.6 s beat
  })

  it("inserts on the grid and keeps what follows in place where it can", () => {
    const r = insertMarker(map, manual(2.9, 120, 3, 4))!
    expect(r.index).toBe(2)
    expect(times(r.markers)).toEqual([0, 1, 3, 5, 9])
    expect(insertMarker(map, auto(0))).toBeNull()
  })

  it("relocks the next marker to the grid before a removed one", () => {
    const m = [auto(0), manual(1, 120), manual(3, 100), auto(4.2)]
    expect(times(removeMarker(m, 2))).toEqual([0, 1, 4]) // 3.2 s after 1 s rounds to 6 beats of 0.5 s
    expect(removeMarker(m, 0)).toBeNull()
  })
})

describe("buildGrid", () => {
  it("follows the detected beats in auto segments and keeps the pickup", () => {
    const g = buildGrid(defaultMarkers(), analysis, 20)
    expect(g.beats.length).toBe(detected.length)
    expect(g.bars[0]).toMatchObject({ bar: 1, start: 0.3, count: 4, den: 4, auto: true })
    expect(gridClicks(g).slice(0, 5).map((c) => c.accent)).toEqual([true, false, false, false, true])
  })

  it("lays manual grids, starts a bar at every marker and drops detected beats right next to a marker", () => {
    const g = buildGrid([auto(0), manual(2.28, 60, 6, 8), auto(8.28)], analysis, 12)
    const t = g.beats.map((b) => Math.round(b.time * 100) / 100)
    expect(t.slice(0, 5)).toEqual([0.3, 0.8, 1.3, 1.8, 2.28]) // 2.3 is dropped: the marker is the beat
    expect(g.bars.map((b) => [b.bar, b.count, b.den])).toEqual([[1, 4, 4], [2, 6, 8], [3, 4, 4], [4, 4, 4], [5, 3, 4]].slice(0, g.bars.length))
    expect(g.beats.filter((b) => !b.auto).map((b) => b.beat)).toEqual([1, 2, 3, 4, 5, 6])
    expect(tempoAt([auto(0), manual(2.28, 60, 6, 8)], g, 3)).toBe(60)
    expect(Math.round(tempoAt(defaultMarkers(), g, 10)!)).toBe(120)
  })

  it("is empty until the song's length is known", () => {
    expect(buildGrid([auto(0), manual(1, 120)], analysis, 0)).toEqual({ beats: [], bars: [] })
  })

  it("has no beats in auto segments without an analysis", () => {
    const g = buildGrid([auto(0), manual(4, 90, 3, 4)], null, 10)
    expect(g.beats[0].time).toBe(4)
    expect(g.bars.every((b) => b.count <= 3)).toBe(true)
  })

  it("starts a manual marker from the detected tempo", () => {
    expect(detectedTempo(analysis, 2, 8)).toEqual({ bpm: 120, num: 4, den: 4 })
    expect(detectedTempo(null, 0, 1)).toBeNull()
  })
})

describe("drum notation on a tempo map", () => {
  const parse = (tex: string) => {
    const imp = new alphaTab.importer.AlphaTexImporter()
    imp.initFromString(tex, new alphaTab.Settings())
    const score = imp.readScore()
    const diags = [...(imp.lexerDiagnostics ?? []), ...(imp.parserDiagnostics ?? []), ...(imp.semanticDiagnostics ?? [])].map((d) => d.message)
    return { score, diags }
  }

  for (const den of [2, 4, 8, 16]) {
    it(`writes bars of /${den} that add up`, () => {
      const bpm = 60 * (den / 4) * 2 // a quarter lasts 0.5 s
      const len = 60 / bpm
      const hits = Array.from({ length: 60 }, (_, i) => 1 + i * len * 0.37)
      const a = parseAnalysis({ version: 1, beats: [0, 0.5], downbeats: [0], chords: [], drums: { kick: hits, hihat: hits.map((h) => h + len / 3) } })!
      const grid = buildGrid([auto(0), manual(1, bpm, den === 8 ? 6 : 3, den)], a, 1 + 24 * len)
      for (const precision of ["auto", "8", "16", "32"] as const) {
        for (const triplets of [true, false]) {
          const bars = quantize(a, precision, triplets, grid)
          const { score, diags } = parse(toAlphaTex(bars, bpm).tex)
          expect(diags, `${precision} ${triplets}`).toEqual([])
          expect(score.masterBars.slice(1).every((m) => m.timeSignatureDenominator === den)).toBe(true)
          for (const bar of score.tracks[0].staves[0].bars) {
            const expected = score.masterBars[bar.index].calculateDuration()
            for (const voice of bar.voices) if (!voice.isEmpty) expect(voice.beats.reduce((s, b) => s + b.playbackDuration, 0)).toBe(expected)
          }
        }
      }
    })
  }
})
