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

/** Peak gain of a click per level: soft clicks sit well under normal ones. */
const LOUDNESS: Record<ClickVolume, number> = { accent: 1, normal: 1, soft: 0.3 }

/** A short sine blip: higher on accents, quieter on soft clicks. */
const classic: ClickSound = {
  id: "classic",
  label: "Classic",
  play(ctx, when, level, dest) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = level === "accent" ? 1600 : 1000
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(LOUDNESS[level], when + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    osc.connect(env).connect(dest)
    osc.start(when)
    osc.stop(when + 0.06)
    return osc
  },
}

/**
 * A sound made from one short audio file per level, served from `public/clicks/<dir>/`. The files are fetched and
 * decoded once (per context) the first time the sound is needed.
 */
function sampled(id: string, label: string, dir: string, files: Record<ClickVolume, string>): ClickSound {
  let buffers: Record<ClickVolume, AudioBuffer> | null = null
  let loadedFor: BaseAudioContext | null = null
  let pending: Promise<void> | null = null
  const decode = async (ctx: BaseAudioContext, file: string) => {
    const res = await fetch(`${import.meta.env.BASE_URL}clicks/${dir}/${file}`)
    if (!res.ok) throw new Error(`click sample ${file}: ${res.status}`)
    return ctx.decodeAudioData(await res.arrayBuffer())
  }
  return {
    id,
    label,
    load(ctx) {
      if (buffers && loadedFor === ctx) return Promise.resolve()
      if (pending && loadedFor === ctx) return pending
      loadedFor = ctx
      buffers = null
      const levels = Object.keys(files) as ClickVolume[]
      pending = Promise.all(levels.map((l) => decode(ctx, files[l]))).then(
        (decoded) => {
          if (loadedFor === ctx) buffers = Object.fromEntries(levels.map((l, i) => [l, decoded[i]])) as Record<ClickVolume, AudioBuffer>
          pending = null
        },
        (err: unknown) => {
          if (loadedFor === ctx) loadedFor = null
          pending = null
          throw err
        },
      )
      return pending
    },
    play(ctx, when, level, dest) {
      const src = ctx.createBufferSource()
      // The engine only plays a sound once `load` has resolved for its context.
      if (buffers && loadedFor === ctx) src.buffer = buffers[level]
      src.connect(dest)
      src.start(when)
      return src
    },
  }
}

/** Square-wave beeps: 999 Hz on accents, 499 Hz on normal clicks, 699 Hz on soft ones. */
const square = sampled("square", "Square", "square", { accent: "hi.wav", normal: "lo.wav", soft: "mid-lo.wav" })

export const CLICK_SOUNDS: readonly ClickSound[] = [classic, square]
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
