import type { StemName } from "@/lib/api"

export const STEM_NAMES: StemName[] = ["vocals", "drums", "bass", "other"]

export type MixerState = {
  volumes: Record<StemName, number> // 0..1
  muted: StemName[]
  soloed: StemName[]
}

export const defaultMixer = (): MixerState => ({
  volumes: { vocals: 1, drums: 1, bass: 1, other: 1 },
  muted: [],
  soloed: [],
})

/** Solo takes precedence over mute: if anything is soloed only soloed stems sound. */
export function effectiveGain(name: StemName, m: MixerState): number {
  const v = m.volumes[name] ?? 1
  if (m.soloed.length > 0) return m.soloed.includes(name) ? v : 0
  return m.muted.includes(name) ? 0 : v
}

export function toggleIn(list: StemName[], name: StemName): StemName[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
}

export type Preset = { kind: "all" } | { kind: "solo"; stem: StemName } | { kind: "minus"; stem: StemName } | { kind: "custom" }

/** Which chip in the preset row (All / solo X / minus X) describes the current mixer, if any. */
export function currentPreset(m: MixerState): Preset {
  if (m.soloed.length === 0 && m.muted.length === 0) return { kind: "all" }
  if (m.soloed.length === 1 && m.muted.length === 0) return { kind: "solo", stem: m.soloed[0] }
  if (m.soloed.length === 0 && m.muted.length === 1) return { kind: "minus", stem: m.muted[0] }
  return { kind: "custom" }
}

/** Apply a preset chip. Tapping the active chip again returns to "all". */
export function applyPreset(m: MixerState, p: Preset): MixerState {
  const cur = currentPreset(m)
  if (p.kind === "all" || p.kind === "custom") return { ...m, muted: [], soloed: [] }
  if (cur.kind === p.kind && "stem" in cur && cur.stem === p.stem) return { ...m, muted: [], soloed: [] }
  return p.kind === "solo" ? { ...m, muted: [], soloed: [p.stem] } : { ...m, soloed: [], muted: [p.stem] }
}

export type LoopRegion = { a: number; b: number; enabled: boolean }

/** Keep a loop region inside [0, duration] with a minimum length. */
export function clampLoop(a: number, b: number, duration: number, minLen = 0.5): { a: number; b: number } {
  let lo = Math.max(0, Math.min(a, b))
  let hi = Math.min(duration, Math.max(a, b))
  if (hi - lo < minLen) {
    if (lo + minLen <= duration) hi = lo + minLen
    else {
      hi = duration
      lo = Math.max(0, duration - minLen)
    }
  }
  return { a: lo, b: hi }
}

/**
 * Song position for an un-wrapped elapsed position `raw` while a sample-accurate loop (loopStart/loopEnd on the
 * AudioBufferSourceNodes) is active. Before reaching `b` nothing wraps.
 */
export function loopedPosition(raw: number, loop: { a: number; b: number } | null): number {
  if (!loop || loop.b <= loop.a || raw < loop.b) return raw
  return loop.a + ((raw - loop.a) % (loop.b - loop.a))
}

/** Waveform-style ordering used for stem rows. */
export const STEM_LABEL: Record<StemName, string> = { vocals: "Vocals", drums: "Drums", bass: "Bass", other: "Other" }
