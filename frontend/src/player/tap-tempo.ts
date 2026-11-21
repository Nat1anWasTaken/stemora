import { clampBpm } from "@/player/tempo-map"

/** A pause longer than this (ms) starts a new tap sequence. */
export const TAP_RESET_MS = 2000
/** How many of the latest intervals the tempo averages over. */
const WINDOW = 8
/** An interval this far off the running average (as a ratio) starts over from the last tap. */
const JUMP = 0.4

/**
 * Tap tempo: give it the time of each tap (ms) and it returns the BPM of the taps so far, to the whole beat (null until two taps).
 * It averages the latest intervals, starts over after a long pause, and on a sudden change of pace
 * (the user switching to a new tempo) keeps only the newest taps.
 */
export function tapTempo(taps: readonly number[], now: number): { taps: number[]; bpm: number | null } {
  const last = taps[taps.length - 1]
  let next = last === undefined || now - last > TAP_RESET_MS || now <= last ? [now] : [...taps, now]
  if (next.length >= 3) {
    const avg = (next[next.length - 2] - next[0]) / (next.length - 2)
    const gap = now - next[next.length - 2]
    if (Math.abs(gap - avg) > avg * JUMP) next = next.slice(-2)
  }
  next = next.slice(-(WINDOW + 1))
  if (next.length < 2) return { taps: next, bpm: null }
  const interval = (next[next.length - 1] - next[0]) / (next.length - 1)
  return { taps: next, bpm: clampBpm(Math.round(60000 / interval)) }
}
