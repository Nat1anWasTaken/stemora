import { describe, expect, it } from "vitest"
import { parseAnalysis, parseSections, sectionsByBar, snapSections } from "@/player/analysis"
import type { BeatGrid } from "@/player/tempo-map"

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

  // Bars every 2 s from 1 s, after a pickup bar (bar 0) at 0.5 s.
  const grid = (starts: number[], pickup = 0.5): BeatGrid => ({
    beats: [],
    bars: [pickup, ...starts].map((start, i, all) => ({ bar: i, start, end: all[i + 1] ?? start + 2, first: 0, count: 4, den: 4, auto: true })),
  })
  const span = (xs: { start: number; end: number; name: string }[]) => xs.map((x) => [x.start, x.end, x.name])

  it("moves each boundary to the nearest bar line of the current grid", () => {
    const s = parseSections([part(0, 4.6, "intro"), part(4.6, 9.4, "verse"), part(9.4, 12, "chorus")])
    expect(span(snapSections(s, grid([1, 3, 5, 7, 9, 11])))).toEqual([[0, 5, "Intro"], [5, 9, "Verse"], [9, 12, "Chorus"]])
  })

  it("keeps the song's start and never snaps to the pickup", () => {
    const s = parseSections([part(0, 0.6, "silence"), part(0.6, 6, "intro")])
    // 0.6 is nearest the pickup (0.5) but the first bar line is 1.
    expect(span(snapSections(s, grid([1, 3, 5])))).toEqual([[0, 1, "Silence"], [1, 6, "Intro"]])
  })

  it("drops a part whose boundaries meet on one bar line", () => {
    const s = parseSections([part(0, 2.8, "intro"), part(2.8, 3.3, "inst"), part(3.3, 8, "verse")])
    expect(span(snapSections(s, grid([1, 3, 5, 7])))).toEqual([[0, 3, "Intro"], [3, 8, "Verse"]])
  })

  it("leaves the parts alone without bars", () => {
    const s = parseSections([part(0, 4.6, "intro"), part(4.6, 9, "verse")])
    expect(snapSections(s, { beats: [], bars: [] })).toBe(s)
    expect(snapSections(s, grid([], 0.5))).toBe(s)
  })
})
