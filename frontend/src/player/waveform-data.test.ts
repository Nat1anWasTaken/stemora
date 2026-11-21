import { describe, expect, it } from "vitest"
import { BASE, buildWaveSync, levelFor, rangeOf } from "@/player/waveform-data"

const source = (data: number[][]) => ({ sampleRate: 1000, length: data[0].length, numberOfChannels: data.length, getChannelData: (c: number) => Float32Array.from(data[c]) })

describe("waveform pyramid", () => {
  const n = BASE * 300
  const left = Array.from({ length: n }, (_, i) => Math.sin(i / 50) * 0.5)
  const right = left.map((v, i) => (i === 5000 ? 0.9 : v))
  const wave = buildWaveSync(source([left, right]))

  it("keeps min and max across channels at every level", () => {
    expect(wave.levels.length).toBeGreaterThan(1)
    for (const l of wave.levels) {
      const i = Math.floor(5000 / l.block)
      expect(l.max[i]).toBeCloseTo(0.9)
    }
    const [lo, hi] = rangeOf(wave, 0, n)
    expect(hi).toBeCloseTo(0.9)
    expect(lo).toBeCloseTo(-0.5, 2)
  })

  it("reads samples when zoomed in past the base level", () => {
    expect(levelFor(wave, BASE / 2)).toBeNull()
    expect(rangeOf(wave, 5000, 5001)).toEqual([Math.fround(Math.sin(100) * 0.5), Math.fround(0.9)])
    expect(rangeOf(wave, n + 10, n + 20)).toEqual([0, 0])
  })

  it("picks the coarsest level that still fits a pixel", () => {
    expect(levelFor(wave, BASE)!.block).toBe(BASE)
    expect(levelFor(wave, BASE * 5)!.block).toBe(BASE * 4)
  })
})
