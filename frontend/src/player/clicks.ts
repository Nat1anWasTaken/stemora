import { lastAtOrBefore } from "@/player/analysis"

/** One metronome click at a song position (seconds). */
export type Click = { time: number; accent: boolean }

/**
 * The clicks heard while the song plays from raw position `from` to `to` (seconds past `offset` at `speed`, before any
 * loop wraps), each with the context time it is heard at. Playback started at song position `offset` at context time
 * `startedAt`; inside an A-B loop the song wraps from `b` back to `a`. `clicks` is sorted by time.
 */
export function clicksBetween(
  clicks: Click[],
  times: number[],
  from: number,
  to: number,
  play: { offset: number; startedAt: number; speed: number; loop: { a: number; b: number } | null },
): { when: number; accent: boolean }[] {
  const out: { when: number; accent: boolean }[] = []
  const { offset, startedAt, speed, loop } = play
  const looping = !!loop && loop.b > loop.a
  const span = looping ? loop.b - loop.a : 0
  let raw = from
  for (let guard = 0; raw < to && guard < 10000; guard++) {
    // Song position at `raw`, and how far it runs before the loop wraps it.
    let pos = looping && raw >= loop.b ? loop.a + ((raw - loop.a) % span) : raw
    let room = looping && pos < loop.b ? loop.b - pos : Infinity
    // Less room before the wrap than `raw` can resolve: the song is at the loop end, so continue from its start.
    if (looping && raw + room === raw) {
      pos = loop.a
      room = span
    }
    const len = Math.min(to - raw, room)
    const end = pos + len
    for (let i = Math.max(0, lastAtOrBefore(times, pos - 1e-9) + 1); i < clicks.length && times[i] < end; i++) {
      if (times[i] < pos) continue
      out.push({ when: startedAt + (raw + (times[i] - pos) - offset) / speed, accent: clicks[i].accent })
    }
    raw += len
  }
  return out
}
