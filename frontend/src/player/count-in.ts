import type { CountInClick } from "@/player/engine"
import type { BeatGrid } from "@/player/tempo-map"

/**
 * One bar of clicks before the song starts at `pos`, in the meter and tempo of the bar being started (heard at
 * `speed`): beat 1 accented. Empty when the song has no beat grid to take them from.
 */
export function countInClicks(grid: BeatGrid, pos: number, speed: number): CountInClick[] {
  const bar = grid.bars.find((b) => pos >= b.start && pos < b.end) ?? grid.bars.find((b) => b.start >= pos)
  if (!bar || bar.count < 1 || !(bar.end > bar.start)) return []
  const count = Math.min(12, bar.count)
  const beat = Math.min(2, Math.max(0.2, (bar.end - bar.start) / bar.count / speed))
  return Array.from({ length: count }, (_, i) => ({ before: (count - i) * beat, level: i === 0 ? "accent" : "normal" }))
}
