import { beforeEach, describe, expect, it, vi } from "vitest"
import { clampOffset, heardDelay, loadOutputOffset, measureDelay, reportedLatency, saveOutputOffset } from "@/player/output-latency"

const clicks = Array.from({ length: 16 }, (_, i) => 1 + i * 0.75)

describe("output latency", () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    })
  })

  it("adds the browser's figures and the user's correction", () => {
    expect(reportedLatency({ baseLatency: 0.01, outputLatency: 0.2 })).toBeCloseTo(0.21)
    // Safari has no outputLatency.
    expect(reportedLatency({ baseLatency: 0.005 })).toBeCloseTo(0.005)
    expect(heardDelay({ baseLatency: 0.01, outputLatency: 0.04 }, 150)).toBeCloseTo(0.2)
    expect(heardDelay({ baseLatency: 0.01, outputLatency: 0.04 }, -200)).toBe(0)
  })

  it("keeps the correction in range and in this browser", () => {
    expect(loadOutputOffset()).toBe(0)
    expect(clampOffset(9000)).toBe(500)
    expect(clampOffset(-12.4)).toBe(-12)
    saveOutputOffset(180)
    expect(loadOutputOffset()).toBe(180)
    localStorage.setItem("stemora:output-offset", "nope")
    expect(loadOutputOffset()).toBe(0)
  })

  it("measures how far taps lag their clicks", () => {
    const taps = clicks.map((c, i) => c + 0.22 + (i % 2 ? 0.01 : -0.01))
    const m = measureDelay(clicks, taps, 0.75)
    expect(m?.delay).toBeCloseTo(0.22, 2)
    expect(m?.taps).toBe(16)
    expect(m?.spread).toBeCloseTo(0.01, 3)
  })

  it("counts a tap a little ahead of its click as early, not as the previous click's", () => {
    const m = measureDelay(clicks, clicks.map((c) => c - 0.03), 0.75)
    expect(m?.delay).toBeCloseTo(-0.03)
  })

  it("leaves out stray taps and needs enough steady ones", () => {
    const taps = [...clicks.map((c) => c + 0.3), clicks[3] + 0.6, clicks[8] + 0.05].sort((a, b) => a - b)
    const m = measureDelay(clicks, taps, 0.75)
    expect(m?.delay).toBeCloseTo(0.3)
    expect(m?.taps).toBe(16)
    expect(measureDelay(clicks, clicks.slice(0, 5).map((c) => c + 0.2), 0.75)).toBeNull()
    expect(measureDelay(clicks, [], 0.75)).toBeNull()
  })
})
