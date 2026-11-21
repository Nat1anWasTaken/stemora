import { describe, expect, it } from "vitest"
import { applyPreset, clampLoop, currentPreset, defaultMixer, effectiveGain, loopedPosition, toggleIn } from "@/player/mixer"
import { parseMixer } from "@/player/mixerStorage"
import { buildBars, buildCells, lastAtOrBefore, parseAnalysis, splitChord, transposeChord } from "@/player/analysis"
import { binPeaks, computePeaks, parsePeaks } from "@/player/peaks"
import { speedFor, tempoMarking, tempoRange, tempoValue } from "@/player/tempo"

describe("effectiveGain", () => {
  it("respects volume and mute", () => {
    const m = { ...defaultMixer(), muted: ["drums" as const] }
    m.volumes.vocals = 0.4
    expect(effectiveGain("vocals", m)).toBe(0.4)
    expect(effectiveGain("drums", m)).toBe(0)
  })
  it("solo takes precedence over mute", () => {
    const m = { ...defaultMixer(), muted: ["bass" as const], soloed: ["bass" as const] }
    expect(effectiveGain("bass", m)).toBe(1)
    expect(effectiveGain("vocals", m)).toBe(0)
  })
  it("supports multiple solos", () => {
    const m = { ...defaultMixer(), soloed: ["bass" as const, "drums" as const] }
    expect(["vocals", "drums", "bass", "other"].map((n) => effectiveGain(n as "vocals", m))).toEqual([0, 1, 1, 0])
  })
})

describe("presets", () => {
  it("minus-one mutes only the chosen stem and toggles off", () => {
    const m1 = applyPreset(defaultMixer(), { kind: "minus", stem: "vocals" })
    expect(m1.muted).toEqual(["vocals"])
    expect(m1.soloed).toEqual([])
    expect(currentPreset(m1)).toEqual({ kind: "minus", stem: "vocals" })
    expect(currentPreset(applyPreset(m1, { kind: "minus", stem: "vocals" }))).toEqual({ kind: "all" })
  })
  it("solo replaces mutes", () => {
    const m = applyPreset({ ...defaultMixer(), muted: ["bass"] }, { kind: "solo", stem: "drums" })
    expect(m.soloed).toEqual(["drums"])
    expect(m.muted).toEqual([])
  })
  it("toggleIn adds and removes", () => {
    expect(toggleIn([], "bass")).toEqual(["bass"])
    expect(toggleIn(["bass"], "bass")).toEqual([])
  })
})

describe("loops", () => {
  it("wraps position inside the loop", () => {
    const loop = { a: 10, b: 20 }
    expect(loopedPosition(5, loop)).toBe(5)
    expect(loopedPosition(19.5, loop)).toBe(19.5)
    expect(loopedPosition(20, loop)).toBe(10)
    expect(loopedPosition(27, loop)).toBe(17)
    expect(loopedPosition(37, loop)).toBe(17)
    expect(loopedPosition(12, null)).toBe(12)
  })
  it("clamps regions", () => {
    expect(clampLoop(8, 3, 100)).toEqual({ a: 3, b: 8 })
    expect(clampLoop(-5, 200, 100)).toEqual({ a: 0, b: 100 })
    expect(clampLoop(10, 10.1, 100)).toEqual({ a: 10, b: 10.5 })
    expect(clampLoop(99.9, 99.95, 100)).toEqual({ a: 99.5, b: 100 })
  })
})

describe("mixer persistence parsing", () => {
  it("falls back to defaults on garbage", () => {
    expect(parseMixer(null)).toEqual(defaultMixer())
    expect(parseMixer("x")).toEqual(defaultMixer())
  })
  it("validates fields", () => {
    const m = parseMixer({ volumes: { vocals: 0.3, drums: 9, bass: "no" }, muted: ["bass", "nope"], soloed: 4 })
    expect(m.volumes).toEqual({ vocals: 0.3, drums: 1, bass: 1, other: 1 })
    expect(m.muted).toEqual(["bass"])
    expect(m.soloed).toEqual([])
  })
})

describe("peaks", () => {
  it("parses and clamps", () => {
    expect(parsePeaks({ version: 2 })).toBeNull()
    const p = parsePeaks({ version: 1, samples_per_second: 20, stems: { vocals: [0, 2, -1, 0.5] } })
    expect(p?.stems.vocals).toEqual([0, 1, 0, 0.5])
  })
  it("bins by max", () => {
    expect(binPeaks([0.1, 0.9, 0.2, 0.3], 1, 4, 2)).toEqual([0.9, 0.3])
    expect(binPeaks([0.5], 1, 4, 4)).toEqual([0.5, 0, 0, 0])
    expect(binPeaks([], 1, 4, 3)).toEqual([0, 0, 0])
  })
  it("computes from samples", () => {
    const ch = new Float32Array(40)
    ch[3] = -0.8
    ch[25] = 0.5
    expect(computePeaks([ch], 20, 1 / 1)).toEqual([expect.closeTo(0.8, 5), 0.5])
  })
})

describe("analysis", () => {
  const a = parseAnalysis({
    version: 1,
    bpm: 120,
    beats_per_bar: 4,
    beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
    downbeats: [0.5, 2.5],
    chords: [{ start: 0.5, end: 2.5, label: "Abmaj7" }, { start: 2.5, end: 4.5, label: "Bb" }],
  })

  it("rejects bad input", () => {
    expect(parseAnalysis(null)).toBeNull()
    expect(parseAnalysis({ version: 2 })).toBeNull()
    expect(parseAnalysis({ version: 1, beats: [], downbeats: [], chords: [] })).toBeNull()
  })

  it("numbers beats and shows chords on changes and downbeats", () => {
    const cells = buildCells(a!)
    expect(cells.map((c) => `${c.bar}.${c.beat}`)).toEqual(["1.1", "1.2", "1.3", "1.4", "2.1", "2.2", "2.3", "2.4"])
    expect(cells.map((c) => c.chord)).toEqual(["Abmaj7", null, null, null, "Bb", null, null, null])
    expect(cells.every((c) => !c.held)).toBe(true)
  })

  it("marks chords repeated on a downbeat as held and groups bars", () => {
    const b = parseAnalysis({ version: 1, beats: [0, 1, 2, 3, 4, 5], downbeats: [1, 4], chords: [{ start: 0, end: 1, label: "N" }, { start: 1, end: 6, label: "C" }] })!
    const cells = buildCells(b)
    expect(cells.map((c) => c.chord)).toEqual(["N", "C", null, null, "C", null])
    expect(cells.map((c) => c.held)).toEqual([false, false, false, false, true, false])
    const bars = buildBars(cells, 7)
    expect(bars.map((x) => [x.bar, x.start, x.end, x.cells.length])).toEqual([[0, 0, 1, 1], [1, 1, 4, 3], [2, 4, 7, 2]])
  })

  it("finds positions and splits labels", () => {
    expect(lastAtOrBefore([1, 2, 3], 0.5)).toBe(-1)
    expect(lastAtOrBefore([1, 2, 3], 2)).toBe(1)
    expect(lastAtOrBefore([1, 2, 3], 9)).toBe(2)
    expect(splitChord("Abmaj7")).toEqual({ root: "Ab", suffix: "maj7" })
    expect(splitChord("Gm")).toEqual({ root: "G", suffix: "m" })
  })
  it("reads an optional key", () => {
    const base = { version: 1, beats: [0, 0.5], downbeats: [0], chords: [] }
    expect(parseAnalysis({ ...base, key: "Dm" })?.key).toBe("Dm")
    expect(parseAnalysis({ ...base, key: "H" })?.key).toBeNull()
    expect(parseAnalysis(base)?.key).toBeNull()
  })

  it("transposes chord and key labels with flat spelling", () => {
    expect(transposeChord("Abmaj7", 2)).toBe("Bbmaj7")
    expect(transposeChord("Dm", -3)).toBe("Bm")
    expect(transposeChord("B7", 1)).toBe("C7")
    expect(transposeChord("C", -1)).toBe("B")
    expect(transposeChord("F#m", 1)).toBe("Gm")
    expect(transposeChord("Eb", 12)).toBe("Eb")
    expect(transposeChord("N", 5)).toBe("N")
  })
})

describe("tempo", () => {
  it("maps the dial to speed in BPM, or percent without a detected tempo", () => {
    expect(tempoRange(120)).toEqual({ min: 60, max: 180 })
    expect(tempoRange(null)).toEqual({ min: 50, max: 150 })
    expect(speedFor(90, 120)).toBe(0.75)
    expect(speedFor(80, null)).toBe(0.8)
    expect(tempoValue(0.75, 120)).toBe(90)
  })
  it("snaps the original value to exactly 1 and clamps", () => {
    expect(speedFor(118, 117.6)).toBe(1)
    expect(tempoValue(1, 117.6)).toBe(118)
    expect(speedFor(400, 120)).toBe(1.5)
  })
  it("names tempo markings", () => {
    expect(tempoMarking(50)).toBe("Largo")
    expect(tempoMarking(100)).toBe("Andante")
    expect(tempoMarking(115)).toBe("Allegretto")
    expect(tempoMarking(130)).toBe("Allegro")
    expect(tempoMarking(220)).toBe("Prestissimo")
  })
})
