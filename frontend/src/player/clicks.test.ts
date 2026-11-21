import { describe, expect, it } from "vitest"
import { clicksBetween, type Click } from "@/player/clicks"

const clicks: Click[] = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((time, i) => ({ time, accent: i % 4 === 0 }))
const times = clicks.map((c) => c.time)
const at = (r: { when: number }[]) => r.map((x) => Math.round(x.when * 1000) / 1000)

describe("clicksBetween", () => {
  it("maps song beats to the audio clock at the playback speed", () => {
    const play = { offset: 0.9, startedAt: 10, speed: 2, loop: null }
    expect(at(clicksBetween(clicks, times, 0.9, 2.1, play))).toEqual([10.05, 10.3, 10.55])
  })

  it("wraps inside a loop", () => {
    const play = { offset: 1.2, startedAt: 0, speed: 1, loop: { a: 1, b: 2 } }
    // Raw 1.2 .. 3.2 plays 1.2-2, then 1-2, then 1-1.2.
    expect(at(clicksBetween(clicks, times, 1.2, 3.2, play))).toEqual([0.3, 0.8, 1.3, 1.8])
  })

  it("moves on when the room before the loop end is below float resolution", () => {
    // Loop 0.1-0.7 s: raw 1.9 maps to one float step under 0.7, too little for raw to advance by.
    const play = { offset: 1.9, startedAt: 0, speed: 1, loop: { a: 0.1, b: 0.7 } }
    // The wrap continues from 0.1, so the beat at 0.5 sounds 0.4 s later.
    expect(at(clicksBetween(clicks, times, 1.9, 2.5, play))).toEqual([0.4])
  })

  it("is empty without beats", () => {
    expect(clicksBetween([], [], 0, 10, { offset: 0, startedAt: 0, speed: 1, loop: null })).toEqual([])
  })
})
