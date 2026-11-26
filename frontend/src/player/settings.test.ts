import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearPending, defaultSettings, initialSettings, legacySettings, parseSettings, sameSettings, savePending } from "@/player/settings"

describe("playback settings", () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
      clear: () => items.clear(),
    })
  })

  it("fills and clamps untrusted JSON", () => {
    expect(parseSettings(null)).toEqual(defaultSettings())
    const s = parseSettings({ speed: 9, semitones: -30.4, transposed: ["drums", "nope"], metronome: true, click_sound: "../x", mixer: { muted: ["bass"] } })
    expect(s.speed).toBe(1.5)
    expect(s.semitones).toBe(-12)
    expect(s.transposed).toEqual(["drums"])
    expect(s.metronome).toBe(true)
    expect(s.click_sound).toBe(defaultSettings().click_sound)
    expect(s.mixer.muted).toEqual(["bass"])
  })

  it("ignores the server's rounding when comparing", () => {
    const a = { ...defaultSettings(), speed: 0.9123 }
    const b = { ...defaultSettings(), speed: 0.912 }
    expect(sameSettings(a, b)).toBe(true)
    expect(sameSettings(a, { ...b, semitones: 1 })).toBe(false)
  })

  it("opens with unsent changes first, then the server, then the old browser mixer, then defaults", () => {
    const server = { ...defaultSettings(), semitones: -2 }
    expect(initialSettings("a", null)).toEqual(defaultSettings())
    localStorage.setItem("stemora:mixer:a", JSON.stringify({ volumes: { vocals: 0.4 }, muted: ["vocals"], soloed: [] }))
    expect(legacySettings("a")?.mixer.muted).toEqual(["vocals"])
    expect(initialSettings("a", null).mixer.volumes.vocals).toBe(0.4)
    expect(initialSettings("a", server).semitones).toBe(-2)
    savePending({ kind: "song", id: "a" }, { ...defaultSettings(), speed: 0.8 })
    expect(initialSettings("a", server).speed).toBe(0.8)
    clearPending({ kind: "song", id: "a" })
    expect(initialSettings("a", server).speed).toBe(1)
  })
})
