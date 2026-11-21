import { describe, expect, it } from "vitest"
import { breakBars, remapBreaks } from "@/player/drums/breaks"

const bars = (starts: number[], end: number) => starts.map((start, i) => ({ start, end: starts[i + 1] ?? end }))

describe("line breaks by time", () => {
  const four = bars([0, 2, 4, 6, 8, 10], 12)

  it("finds the bars that start at the breaks", () => {
    expect(breakBars([4, 8.001, 5, 0], four)).toEqual([2, 4])
  })

  it("follows bar lines that moved a little and drops those whose bar line is gone", () => {
    // A slower grid from 3 s: lines at 0, 2, 3, 5.5, 8, 10.5.
    const moved = bars([0, 2, 3, 5.5, 8, 10.5], 12)
    const r = remapBreaks([4, 6, 8], moved)
    // 4 is 1 s from 3 and 1.5 s from 5.5: half the shorter neighbouring bar is 0.5 s, so it goes; 6 -> 5.5; 8 stays.
    expect(r).toEqual({ times: [5.5, 8], removed: 1 })
  })

  it("keeps the closer of two breaks that land on one bar line", () => {
    const wide = bars([0, 4, 8], 12)
    expect(remapBreaks([3.5, 4.2, 7], wide)).toEqual({ times: [4, 8], removed: 1 })
  })

  it("changes nothing on the same bars", () => {
    expect(remapBreaks([2, 10], four)).toEqual({ times: [2, 10], removed: 0 })
  })
})
