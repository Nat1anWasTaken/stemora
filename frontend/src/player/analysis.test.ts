import { describe, expect, it } from "vitest"
import { parseAnalysis, parseSections, sectionsByBar } from "@/player/analysis"

const part = (start: number, end: number, label: string) => ({ start, end, label })

describe("sections", () => {
  it("keeps well-formed known parts in order and numbers repeated kinds", () => {
    const s = parseSections([
      part(20, 30, "chorus"),
      part(0, 10, "intro"),
      part(10, 20, "verse"),
      part(30, 40, "verse"),
      part(40, 50, "prechorus"),
      part(50, 60, "chorus"),
      part(60, 60, "outro"), // empty
      part(60, 70, "drop"), // unknown label
      { start: "x", end: 80, label: "outro" },
      null,
    ])
    expect(s.map((x) => x.name)).toEqual(["Intro", "Verse 1", "Chorus 1", "Verse 2", "Pre-chorus", "Chorus 2"])
    expect(s[4]).toEqual({ start: 40, end: 50, kind: "prechorus", name: "Pre-chorus" })
    expect(parseSections(undefined)).toEqual([])
    expect(parseSections({})).toEqual([])
  })

  it("is empty for analyses written before sections existed", () => {
    expect(parseAnalysis({ version: 1, beats: [0, 1], downbeats: [0], chords: [] })!.sections).toEqual([])
  })

  it("puts each part on the bar it starts in", () => {
    const bars = [0, 2, 4, 6, 8].map((start) => ({ start, end: start + 2 }))
    const s = parseSections([part(0, 3.1, "intro"), part(3.1, 4, "silence"), part(4, 10, "verse")])
    const by = sectionsByBar(s, bars)
    expect([...by].map(([t, x]) => [t, x.name])).toEqual([[0, "Intro"], [2, "Silence"], [4, "Verse"]])
    expect(sectionsByBar(s, []).size).toBe(0)
  })
})
