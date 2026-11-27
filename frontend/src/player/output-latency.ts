/**
 * Output latency: the time between the audio clock reaching a sample and that sample being heard. Wired outputs add a
 * few tens of milliseconds; Bluetooth adds a few hundred. Every sound the engine makes goes through the same output,
 * so the delay never puts stems and clicks out of step with each other, but it does put them behind anything drawn
 * on screen from the audio clock. The engine takes it off the clock where it reports what is heard (`position`).
 *
 * The browser's own figure (`baseLatency` + `outputLatency`) is not always there (Safari lacks `outputLatency`) or
 * right (some Bluetooth stacks under-report), so the user can add a correction of their own, measured by tapping
 * along to clicks (`measureDelay`) or set by ear. The correction belongs to this browser and its output, so it is kept
 * in localStorage and not synced with the playback settings.
 */

/** The correction's range in milliseconds: negative when the browser over-reports. */
export const MIN_OFFSET_MS = -200
export const MAX_OFFSET_MS = 500

const KEY = "stemora:output-offset"

export const clampOffset = (ms: number) => Math.round(Math.min(MAX_OFFSET_MS, Math.max(MIN_OFFSET_MS, ms)))

/** The correction saved in this browser, in milliseconds (0 when none is). */
export function loadOutputOffset(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) ? clampOffset(v) : 0
  } catch {
    return 0
  }
}

export function saveOutputOffset(ms: number) {
  try {
    if (ms === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(ms))
  } catch {
    /* storage unavailable (private mode / quota): ignore */
  }
}

type LatencyInfo = Pick<AudioContext, "baseLatency"> & { outputLatency?: number }

/** The browser's figure for the context, in seconds (0 where it reports none). */
export function reportedLatency(ctx: LatencyInfo): number {
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0
  const output = typeof ctx.outputLatency === "number" && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0
  return Math.max(0, base + output)
}

/** How long after the clock a sample is heard, in seconds: the browser's figure plus the user's correction. */
export const heardDelay = (ctx: LatencyInfo, offsetMs: number) => Math.max(0, reportedLatency(ctx) + offsetMs / 1000)

/** Taps measured against clicks: the delay they show (seconds), how many taps it rests on, and their spread (seconds). */
export type DelayMeasurement = { delay: number; taps: number; spread: number }

/** Fewest taps a measurement needs, and how far a tap may land from the typical one before it is left out. */
export const MIN_TAPS = 6
const OUTLIER = 0.08
/** How far ahead of a click a tap may come: people tapping along to a steady beat tend to anticipate it a little. */
export const EARLY_TAP = 0.1

/**
 * The delay between clicks (when they left the clock) and the user's taps on hearing them, both in context seconds;
 * the clicks are `interval` apart. A tap belongs to the click it lags by between -EARLY_TAP and `interval` - EARLY_TAP, so the
 * delay this can measure stays under that. Taps more than OUTLIER from the median (a missed or doubled tap) are
 * dropped. Null when too few taps agree.
 */
export function measureDelay(clicks: readonly number[], taps: readonly number[], interval: number): DelayMeasurement | null {
  const lags: number[] = []
  for (const t of taps) {
    const click = clicks.find((c) => t - c >= -EARLY_TAP && t - c < interval - EARLY_TAP)
    if (click !== undefined) lags.push(t - click)
  }
  if (lags.length < MIN_TAPS) return null
  const mid = median(lags)
  const kept = lags.filter((l) => Math.abs(l - mid) <= OUTLIER)
  if (kept.length < MIN_TAPS) return null
  const delay = median(kept)
  const spread = Math.sqrt(kept.reduce((a, l) => a + (l - delay) ** 2, 0) / kept.length)
  return { delay, taps: kept.length, spread }
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
