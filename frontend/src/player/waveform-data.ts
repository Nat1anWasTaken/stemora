/**
 * The real waveform of a decoded stem, for drawing at any zoom: min/max per block of samples in a pyramid of levels
 * (BASE samples per block, then ×STEP per level). Built from the AudioBuffer the engine already holds, a slice at a
 * time on the main thread so it never blocks a frame for long and the PCM is never copied. Below BASE samples per
 * pixel the drawing reads the samples themselves.
 */
export const BASE = 128
const STEP = 4
/** Samples handled per slice before yielding to the browser. */
const SLICE = 1 << 20

export type Level = { block: number; min: Float32Array; max: Float32Array }
export type Wave = { sampleRate: number; length: number; channels: Float32Array[]; levels: Level[]; ready: boolean }

type Source = { sampleRate: number; length: number; numberOfChannels: number; getChannelData: (c: number) => Float32Array }

const cache = new WeakMap<object, Wave>()

/** The level a span of `samples` per pixel reads from: the coarsest whose blocks still fit in one pixel. */
export function levelFor(wave: Wave, samples: number): Level | null {
  let pick: Level | null = null
  for (const l of wave.levels) if (l.block <= samples) pick = l
  return pick
}

/** Lowest and highest sample in [from, to) (sample indices); [0, 0] outside the stem. */
export function rangeOf(wave: Wave, from: number, to: number): [number, number] {
  const a = Math.max(0, Math.floor(from))
  const b = Math.min(wave.length, Math.ceil(to))
  if (b <= a) return [0, 0]
  const level = wave.ready ? levelFor(wave, b - a) : null
  let lo = Infinity
  let hi = -Infinity
  if (!level) {
    for (const ch of wave.channels) {
      for (let i = a; i < b; i++) {
        const v = ch[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    return [lo, hi]
  }
  const i0 = Math.floor(a / level.block)
  const i1 = Math.min(level.min.length, Math.ceil(b / level.block))
  for (let i = i0; i < i1; i++) {
    if (level.min[i] < lo) lo = level.min[i]
    if (level.max[i] > hi) hi = level.max[i]
  }
  return lo === Infinity ? [0, 0] : [lo, hi]
}

/** Coarser level from a finer one (STEP blocks into one). */
function reduce(l: Level): Level {
  const n = Math.ceil(l.min.length / STEP)
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let lo = Infinity
    let hi = -Infinity
    for (let j = i * STEP; j < Math.min(l.min.length, (i + 1) * STEP); j++) {
      if (l.min[j] < lo) lo = l.min[j]
      if (l.max[j] > hi) hi = l.max[j]
    }
    min[i] = lo
    max[i] = hi
  }
  return { block: l.block * STEP, min, max }
}

/** Fills the base level for blocks [from, to). */
function fill(base: Level, channels: Float32Array[], length: number, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const a = i * BASE
    const b = Math.min(length, a + BASE)
    let lo = Infinity
    let hi = -Infinity
    for (const ch of channels) {
      for (let s = a; s < b; s++) {
        const v = ch[s]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    base.min[i] = lo === Infinity ? 0 : lo
    base.max[i] = hi === -Infinity ? 0 : hi
  }
}

/** Builds every level at once (tests, short buffers). */
export function buildWaveSync(src: Source): Wave {
  const wave = start(src)
  fill(wave.levels[0], wave.channels, wave.length, 0, wave.levels[0].min.length)
  finish(wave)
  return wave
}

function start(src: Source): Wave {
  const channels = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c))
  const n = Math.ceil(src.length / BASE)
  return { sampleRate: src.sampleRate, length: src.length, channels, levels: [{ block: BASE, min: new Float32Array(n), max: new Float32Array(n) }], ready: false }
}

function finish(wave: Wave) {
  let l = wave.levels[0]
  while (l.min.length > 64) {
    l = reduce(l)
    wave.levels.push(l)
  }
  wave.ready = true
}

/**
 * The wave of an AudioBuffer, cached per buffer; `onReady` runs once it is complete (until then `rangeOf` reads
 * samples, which is only fast when zoomed in, so callers draw a coarse fallback meanwhile).
 */
export function waveOf(src: Source & object, onReady: () => void): Wave {
  const hit = cache.get(src)
  if (hit) {
    if (!hit.ready) pending.get(hit)?.push(onReady)
    return hit
  }
  const wave = start(src)
  cache.set(src, wave)
  const waiting = [onReady]
  pending.set(wave, waiting)
  const total = wave.levels[0].min.length
  const per = Math.max(1, Math.floor(SLICE / BASE))
  let done = 0
  const step = () => {
    const to = Math.min(total, done + per)
    fill(wave.levels[0], wave.channels, wave.length, done, to)
    done = to
    if (done < total) return void setTimeout(step, 0)
    finish(wave)
    pending.delete(wave)
    for (const fn of waiting) fn()
  }
  setTimeout(step, 0)
  return wave
}
const pending = new WeakMap<Wave, (() => void)[]>()
