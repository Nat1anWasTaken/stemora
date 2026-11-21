import type { model } from "@coderline/alphatab"

/**
 * Hide the rests that the other voice already explains: a rest is dropped when the other voice's notes sound for its
 * whole span, as drum charts do. Where both voices are silent the rests stay, so the bar still reads out.
 * alphaTab skips drawing an `isEmpty` beat but keeps its room, so the layout and tap-to-seek do not change.
 */
export function hideCoveredRests(score: model.Score) {
  for (const bar of score.tracks[0]?.staves[0]?.bars ?? []) {
    if (bar.voices.length < 2) continue
    const notes = bar.voices.map((v) =>
      v.beats.filter((b) => !b.isRest).map((b) => [b.displayStart, b.displayStart + b.displayDuration] as const),
    )
    for (const voice of bar.voices) {
      const others = notes.filter((_, i) => i !== voice.index).flat().sort((a, b) => a[0] - b[0])
      for (const beat of voice.beats) {
        if (beat.isRest && covered(beat.displayStart, beat.displayStart + beat.displayDuration, others)) beat.isEmpty = true
      }
    }
  }
}

/** Whether `[start, end)` lies inside the union of `spans` (sorted by start). */
function covered(start: number, end: number, spans: (readonly [number, number])[]): boolean {
  let at = start
  for (const [s, e] of spans) {
    if (s > at) break
    if (e > at) at = e
    if (at >= end) return true
  }
  return at >= end
}
