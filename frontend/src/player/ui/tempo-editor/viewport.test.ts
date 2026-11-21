import { describe, expect, it } from "vitest"
import { centerOn, clampView, fitView, follow, MAX_PPS, timeToX, zoomAt } from "@/player/ui/tempo-editor/viewport"

describe("viewport", () => {
  const v = { start: 10, pps: 100, width: 1000 } // 10 s .. 20 s

  it("zooms around the anchor", () => {
    const z = zoomAt(v, 2, 500, 60, false)
    expect(z.pps).toBe(200)
    expect(timeToX(z, 15)).toBeCloseTo(500)
    expect(zoomAt(v, 1e9, 0, 60, false).pps).toBe(MAX_PPS)
    const out = zoomAt(v, 1e-9, 0, 60, false)
    expect(out.pps).toBe(fitView(1000, 60).pps)
    expect(out.start).toBeCloseTo(0)
  })

  it("keeps the view inside the song, or half a screen past it when centred", () => {
    expect(clampView({ ...v, start: -3 }, 60, false).start).toBe(0)
    expect(clampView({ ...v, start: 55 }, 60, false).start).toBe(50)
    expect(clampView({ ...v, start: -3 }, 60, true).start).toBe(-3)
    expect(centerOn(v, 0, 60).start).toBe(-5)
  })

  it("turns pages while following", () => {
    expect(follow(v, 15, 60)).toBe(v)
    expect(follow(v, 19.9, 60).start).toBeCloseTo(19.4)
    expect(follow(v, 2, 60).start).toBe(1.5)
  })
})
