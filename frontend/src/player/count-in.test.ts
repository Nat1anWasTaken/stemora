import { describe, expect, it } from "vitest"
import { countInClicks } from "@/player/count-in"

const grid = { beats: [], bars: [{ bar: 1, start: 0, end: 2, first: 0, count: 4, den: 4, auto: false }, { bar: 2, start: 2, end: 3.5, first: 4, count: 3, den: 4, auto: false }] }

describe("countInClicks", () => {
  it("clicks one bar of the bar being started, accenting beat 1", () => {
    const c = countInClicks(grid, 0, 1)
    expect(c.map((x) => x.before)).toEqual([2, 1.5, 1, 0.5])
    expect(c.map((x) => x.level)).toEqual(["accent", "normal", "normal", "normal"])
    expect(countInClicks(grid, 2.5, 1)).toHaveLength(3)
  })
  it("follows the speed and needs a grid", () => {
    expect(countInClicks(grid, 0, 0.5)[3].before).toBe(1)
    expect(countInClicks({ beats: [], bars: [] }, 0, 1)).toEqual([])
  })
})
