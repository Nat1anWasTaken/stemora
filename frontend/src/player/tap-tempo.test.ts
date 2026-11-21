import { describe, expect, it } from "vitest"
import { TAP_RESET_MS, tapTempo } from "@/player/tap-tempo"

const run = (times: number[]) => times.reduce<{ taps: number[]; bpm: number | null }>((s, t) => tapTempo(s.taps, t), { taps: [], bpm: null })

describe("tapTempo", () => {
  it("needs two taps", () => {
    expect(tapTempo([], 0).bpm).toBeNull()
    expect(run([0, 500]).bpm).toBe(120)
  })
  it("averages the intervals", () => {
    expect(run([0, 490, 1000, 1510, 2000]).bpm).toBe(120)
  })
  it("starts over after a long pause", () => {
    const s = run([0, 500, 1000, 1000 + TAP_RESET_MS + 1])
    expect(s.taps).toHaveLength(1)
    expect(s.bpm).toBeNull()
  })
  it("follows a sudden change of pace", () => {
    expect(run([0, 500, 1000, 1500, 1750, 2000]).bpm).toBe(240)
  })
  it("keeps a sliding window", () => {
    const times = Array.from({ length: 20 }, (_, i) => i * 600)
    const s = run(times)
    expect(s.taps).toHaveLength(9)
    expect(s.bpm).toBe(100)
  })
  it("clamps to the BPM range", () => {
    expect(run([0, 10]).bpm).toBe(400)
  })
})
