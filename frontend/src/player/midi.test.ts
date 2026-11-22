import { describe, expect, it } from "vitest"
import { parseAnalysis, type Section } from "@/player/analysis"
import { PPQ, tempoMidi, vlq } from "@/player/midi"
import { buildGrid, type ManualMarker, type TempoMarker } from "@/player/tempo-map"

type Meta = { tick: number; type: number; data: number[] }

/** Reads back what tempoMidi writes: the header and the meta events of its one track. */
function read(bytes: Uint8Array) {
  const s = (at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n))
  const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1]
  const u32 = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  expect(s(0, 4)).toBe("MThd")
  const header = { format: u16(8), tracks: u16(10), ppq: u16(12) }
  expect(s(14, 4)).toBe("MTrk")
  const end = 22 + u32(18)
  expect(end).toBe(bytes.length)
  let p = 22
  const num = () => {
    let v = 0
    for (;;) {
      const b = bytes[p++]
      v = v * 128 + (b & 0x7f)
      if (!(b & 0x80)) return v
    }
  }
  const events: Meta[] = []
  let tick = 0
  while (p < end) {
    tick += num()
    expect(bytes[p++]).toBe(0xff)
    const type = bytes[p++]
    const len = num()
    events.push({ tick, type, data: [...bytes.slice(p, p + len)] })
    p += len
  }
  return { header, events }
}

/** Seconds at `tick` from the file's tempo events. */
function secondsAt(events: Meta[], tick: number): number {
  const tempos = events.filter((e) => e.type === 0x51)
  let t = 0
  for (const [i, e] of tempos.entries()) {
    if (e.tick >= tick) break
    const until = Math.min(tick, tempos[i + 1]?.tick ?? Infinity)
    const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]
    t += ((until - e.tick) / PPQ) * us / 1e6
  }
  return t
}

const signatures = (events: Meta[]) => events.filter((e) => e.type === 0x58).map((e) => ({ tick: e.tick, sig: `${e.data[0]}/${2 ** e.data[1]}`, cc: e.data[2] }))
const tempos = (events: Meta[]) => events.filter((e) => e.type === 0x51).map((e) => ({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }))
const texts = (events: Meta[], type: number) => events.filter((e) => e.type === type).map((e) => ({ tick: e.tick, text: new TextDecoder().decode(new Uint8Array(e.data)) }))

const manual = (time: number, bpm: number, num = 4, den = 4): ManualMarker => ({ time, kind: "manual", bpm, num, den })
const auto = (time: number): TempoMarker => ({ time, kind: "auto" })

// Detected: drifting around 120 BPM from 0.3 s, downbeat every 4 beats.
const detected = Array.from({ length: 60 }, (_, i) => 0.3 + i * 0.5 + 0.013 * Math.sin(i))
const analysis = parseAnalysis({ version: 1, bpm: 120, beats_per_bar: 4, beats: detected, downbeats: detected.filter((_, i) => i % 4 === 0), chords: [] })!

/** Every grid beat lands at its own time when the file is played back. */
function expectAligned(markers: TempoMarker[], duration: number) {
  const grid = buildGrid(markers, analysis, duration)
  const { events } = read(tempoMidi(grid, duration)!)
  // Ticks of each grid beat, skipping any lead-in beats the file starts with.
  const lead = grid.beats[0].time > 1e-4 ? Math.ceil(grid.beats[0].time / ((0xffffff / 1e6) * grid.beats[0].den / 4)) : 0
  let tick = lead * (PPQ * 4) / grid.beats[0].den
  for (const b of grid.beats) {
    expect(Math.abs(secondsAt(events, tick) - b.time)).toBeLessThan(1e-4)
    tick += (PPQ * 4) / b.den
  }
  return { grid, events }
}

describe("vlq", () => {
  it("encodes the spec's examples", () => {
    expect(vlq(0)).toEqual([0x00])
    expect(vlq(0x7f)).toEqual([0x7f])
    expect(vlq(0x80)).toEqual([0x81, 0x00])
    expect(vlq(0x2000)).toEqual([0xc0, 0x00])
    expect(vlq(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f])
  })
})

describe("tempoMidi", () => {
  it("writes a format 1 file with one track and the title", () => {
    const grid = buildGrid([manual(0, 120)], analysis, 10)
    const { header, events } = read(tempoMidi(grid, 10, { title: "Song – ü" })!)
    expect(header).toEqual({ format: 1, tracks: 1, ppq: PPQ })
    expect(texts(events, 0x03)).toEqual([{ tick: 0, text: "Song – ü" }])
    expect(events.at(-1)?.type).toBe(0x2f)
  })

  it("gives a manual stretch one tempo and one signature", () => {
    const { events } = expectAligned([manual(0, 120)], 10)
    expect(tempos(events)).toEqual([{ tick: 0, us: 500_000 }])
    expect(signatures(events)).toEqual([{ tick: 0, sig: "4/4", cc: 24 }])
  })

  it("counts BPM in the denominator note: 6/8 at 120 is 60 quarters a minute", () => {
    const { events } = expectAligned([manual(0, 120, 6, 8)], 10)
    expect(tempos(events)).toEqual([{ tick: 0, us: 1_000_000 }])
    expect(signatures(events)).toEqual([{ tick: 0, sig: "6/8", cc: 12 }])
    // A bar of 6/8 is three quarters.
    expect(events.at(-1)!.tick % (PPQ * 3)).toBe(0)
  })

  it("writes a short bar where a locked marker cuts one", () => {
    // 4/4 at 120 for 6 beats (a bar and a half), then 3/4 at 90.
    const { events } = expectAligned([manual(0, 120), manual(3, 90, 3, 4)], 20)
    expect(signatures(events)).toEqual([
      { tick: 0, sig: "4/4", cc: 24 },
      { tick: PPQ * 4, sig: "2/4", cc: 24 },
      { tick: PPQ * 6, sig: "3/4", cc: 24 },
    ])
    expect(tempos(events)).toEqual([{ tick: 0, us: 500_000 }, { tick: PPQ * 6, us: 666_667 }])
  })

  it("follows detected beats without drifting, the lead-in joining the pickup", () => {
    const { grid, events } = expectAligned([auto(0)], 31)
    // Detected beats start at 0.3 s on a downbeat: the 0.3 s before it is a one-beat pickup.
    expect(grid.bars[0].bar).toBe(1)
    expect(signatures(events)).toEqual([{ tick: 0, sig: "1/4", cc: 24 }, { tick: PPQ, sig: "4/4", cc: 24 }])
    expect(tempos(events)[0]).toEqual({ tick: 0, us: 300_000 })
  })

  it("mixes manual and detected stretches", () => {
    expectAligned([manual(0, 100, 7, 8), auto(8.4), manual(20, 140, 5, 16)], 29)
  })

  it("splits a long silence before the first beat into beats Set Tempo can hold", () => {
    const late = parseAnalysis({ version: 1, bpm: 120, beats_per_bar: 4, beats: [40, 40.5, 41, 41.5, 42], downbeats: [40], chords: [] })!
    const grid = buildGrid([auto(0)], late, 43)
    const { events } = read(tempoMidi(grid, 43)!)
    expect(signatures(events)[0]).toEqual({ tick: 0, sig: "3/4", cc: 24 })
    expect(Math.abs(secondsAt(events, PPQ * 3) - 40)).toBeLessThan(1e-4)
    expect(tempos(events).every((t) => t.us <= 0xffffff)).toBe(true)
  })

  it("marks sections inside their beat, leaving out silence", () => {
    const sections: Section[] = [
      { start: 0, end: 2, kind: "silence", name: "Silence" },
      { start: 2, end: 5, kind: "verse", name: "Verse" },
      { start: 5.25, end: 10, kind: "chorus", name: "Chorus" },
    ]
    const grid = buildGrid([manual(0, 120)], analysis, 10)
    const { events } = read(tempoMidi(grid, 10, { sections })!)
    expect(texts(events, 0x06)).toEqual([{ tick: PPQ * 4, text: "Verse" }, { tick: PPQ * 10 + PPQ / 2, text: "Chorus" }])
  })

  it("has nothing to export without beats", () => {
    expect(tempoMidi({ beats: [], bars: [] }, 10)).toBeNull()
  })
})
