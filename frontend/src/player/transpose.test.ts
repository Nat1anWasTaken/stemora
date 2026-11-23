import { describe, expect, it } from "vitest"
import { DEFAULT_TRANSPOSED, heardSemitones, parseTransposed, signed, stemSemitones, toggleTransposed, transposedLabel } from "@/player/transpose"

describe("transposed stems", () => {
  it("leaves drums out by default", () => {
    expect(DEFAULT_TRANSPOSED).toEqual(["vocals", "bass", "other"])
    expect(parseTransposed(null)).toEqual(["vocals", "bass", "other"])
  })
  it("parses stored lists, dropping unknown names and keeping stem order", () => {
    expect(parseTransposed(["other", "nope", "vocals", 3])).toEqual(["vocals", "other"])
    expect(parseTransposed([])).toEqual([])
    expect(parseTransposed({ vocals: true })).toEqual(["vocals", "bass", "other"])
  })
  it("toggles a stem in stem order", () => {
    expect(toggleTransposed(["vocals", "bass", "other"], "drums")).toEqual(["vocals", "drums", "bass", "other"])
    expect(toggleTransposed(["vocals", "bass"], "vocals")).toEqual(["bass"])
  })
  it("plays only the transposed stems at the key change, and none while the switch is off", () => {
    expect(stemSemitones("vocals", 3, ["vocals"])).toBe(3)
    expect(stemSemitones("drums", 3, ["vocals"])).toBe(0)
    expect(heardSemitones(3, true)).toBe(3)
    expect(heardSemitones(3, false)).toBe(0)
  })
  it("summarises the selection", () => {
    expect(transposedLabel(["vocals", "drums", "bass", "other"])).toBe("All stems")
    expect(transposedLabel(["vocals", "bass", "other"])).toBe("All but drums")
    expect(transposedLabel(["vocals", "bass"])).toBe("Vocals, Bass")
    expect(transposedLabel([])).toBe("None")
  })
  it("signs semitones with a real minus", () => {
    expect([signed(2), signed(-3), signed(0)]).toEqual(["+2", "−3", "0"])
  })
})
