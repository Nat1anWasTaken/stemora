/**
 * What part of the song the editor shows: `start` (seconds at the left edge) and `pps` (CSS pixels per second) over
 * a `width` in CSS pixels. In `centered` mode (phones) the playhead stays in the middle, so the view may reach half a
 * screen past either end of the song.
 */
export type Viewport = { start: number; pps: number; width: number }

/** Closest zoom: a little over two pixels per sample at 44.1 kHz (the drawing shows samples below 1.5 per pixel). */
export const MAX_PPS = 100000
/** Share of the width kept ahead of the playhead when a page turns. */
const PAGE_LEAD = 0.05

export const timeToX = (v: Viewport, t: number) => (t - v.start) * v.pps
export const xToTime = (v: Viewport, x: number) => v.start + x / v.pps
export const visibleSeconds = (v: Viewport) => v.width / v.pps

/** Furthest out the view zooms: the whole song across the width. */
export const minPps = (width: number, duration: number) => Math.max(1e-3, width / Math.max(0.1, duration))

export function clampView(v: Viewport, duration: number, centered: boolean): Viewport {
  const pps = Math.min(MAX_PPS, Math.max(minPps(v.width, duration), v.pps))
  const span = v.width / pps
  const [lo, hi] = centered ? [-span / 2, duration - span / 2] : [0, Math.max(0, duration - span)]
  return { ...v, pps, start: Math.min(hi, Math.max(lo, v.start)) }
}

/** Zoom by `factor` keeping the time under `anchorX` where it is. */
export function zoomAt(v: Viewport, factor: number, anchorX: number, duration: number, centered: boolean): Viewport {
  const t = xToTime(v, anchorX)
  const pps = Math.min(MAX_PPS, Math.max(minPps(v.width, duration), v.pps * factor))
  return clampView({ ...v, pps, start: t - anchorX / pps }, duration, centered)
}

/** The whole song. */
export const fitView = (width: number, duration: number): Viewport => ({ width, pps: minPps(width, duration), start: 0 })

/** The view with the playhead in the middle. */
export const centerOn = (v: Viewport, t: number, duration: number): Viewport => clampView({ ...v, start: t - v.width / 2 / v.pps }, duration, true)

/** Page-style auto-scroll: once the playhead leaves the view (or reaches its right edge), turn to the page it is on. */
export function follow(v: Viewport, t: number, duration: number): Viewport {
  const span = visibleSeconds(v)
  if (t >= v.start && t < v.start + span * (1 - PAGE_LEAD / 2)) return v
  return clampView({ ...v, start: t - span * PAGE_LEAD }, duration, false)
}
