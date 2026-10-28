import { describe, expect, it } from "vitest"
import { applyPreset, clampLoop, currentPreset, defaultMixer, effectiveGain, loopedPosition, toggleIn } from "@/player/mixer"
import { parseMixer } from "@/player/mixerStorage"
import { binPeaks, computePeaks, parsePeaks } from "@/player/peaks"

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
