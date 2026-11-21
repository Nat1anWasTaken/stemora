import type { ClickVolume } from "@/player/clicks"

/**
 * Metronome sounds. Each one plays a click of a level at a context time into `dest` and returns the node to stop if
 * the click is cancelled (a seek or a pattern change). A sound made from audio files can decode them in `load`, which
 * the engine awaits before it first uses the sound.
 */
export type ClickSound = {
  id: string
  label: string
  load?: (ctx: BaseAudioContext) => Promise<void>
  play: (ctx: BaseAudioContext, when: number, level: ClickVolume, dest: AudioNode) => AudioScheduledSourceNode
}

/** A short sine blip: higher on accents. */
const classic: ClickSound = {
  id: "classic",
  label: "Classic",
  play(ctx, when, level, dest) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = level === "accent" ? 1600 : 1000
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(1, when + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    osc.connect(env).connect(dest)
    osc.start(when)
    osc.stop(when + 0.06)
    return osc
  },
}

export const CLICK_SOUNDS: readonly ClickSound[] = [classic]
export const DEFAULT_CLICK_SOUND = classic.id

export const clickSound = (id: string): ClickSound => CLICK_SOUNDS.find((s) => s.id === id) ?? classic

const KEY = "stemora:click-sound"

/** The sound chosen in this browser (the default when none is, or it no longer exists). */
export function loadClickSound(): string {
  try {
    const id = localStorage.getItem(KEY)
    return id && CLICK_SOUNDS.some((s) => s.id === id) ? id : DEFAULT_CLICK_SOUND
  } catch {
    return DEFAULT_CLICK_SOUND
  }
}

export function saveClickSound(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable (private mode / quota): ignore */
  }
}
