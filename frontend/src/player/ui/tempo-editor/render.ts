import { STEM_NAMES } from "@/player/mixer"
import type { Peaks } from "@/player/peaks"
import { lastAtOrBefore } from "@/player/analysis"
import { isImplicitStart, visibleMarkerCount, type BeatGrid, type TempoMarker } from "@/player/tempo-map"
import { formatBpm } from "@/player/ui/use-playhead-tempo"
import { rangeOf, type Wave } from "@/player/waveform-data"
import { timeToX, xToTime, type Viewport } from "@/player/ui/tempo-editor/viewport"

/** Rows above the stem lanes, in CSS px: the loop strip and bar numbers (the ruler), then the tempo lane. */
export const LOOP_H = 14
export const RULER_H = 32
export const TEMPO_H = 28
/** Everything above the lanes; the desktop track headers leave this much room (`h-15`). */
export const HEADER_H = RULER_H + TEMPO_H
const FLAG_H = 20
const FONT = "600 11px Geist Variable, system-ui, sans-serif"

export type Colors = Record<"vocals" | "drums" | "bass" | "other" | "fg" | "muted" | "primary" | "onPrimary" | "surface" | "secondary" | "border", string>

export function readColors(el: Element): Colors {
  const cs = getComputedStyle(el)
  const g = (n: string) => cs.getPropertyValue(n).trim()
  return {
    vocals: g("--stem-vocals"), drums: g("--stem-drums"), bass: g("--stem-bass"), other: g("--stem-other"),
    fg: g("--foreground"), muted: g("--muted-foreground"), primary: g("--primary"), onPrimary: g("--primary-foreground"),
    surface: g("--surface"), secondary: g("--secondary"), border: g("--border"),
  }
}

export type Scene = {
  vp: Viewport
  height: number
  duration: number
  waves: (Wave | null)[]
  peaks: Peaks | null
  gains: number[]
  grid: BeatGrid
  markers: TempoMarker[]
  selected: number | null
  loop: { a: number; b: number } | null
  pendingA: number | null
  amp: number
}

/** Where each marker's flag was drawn, for hit testing (CSS px). */
export type FlagBox = { index: number; x0: number; x1: number }

export const flagLabel = (m: TempoMarker) => (m.kind === "manual" ? `${formatBpm(m.bpm)}  ${m.num}/${m.den}` : "Auto")

/** What the tempo lane says while the song has no markers of its own. */
const EMPTY_HINT = "Detected beats"

const laneHeight = (height: number) => Math.max(1, (height - HEADER_H) / STEM_NAMES.length)

/** Index of the lane under `y`, or -1 above the lanes. */
export const laneAt = (height: number, y: number) => (y < HEADER_H ? -1 : Math.min(STEM_NAMES.length - 1, Math.floor((y - HEADER_H) / laneHeight(height))))

/** Paints everything but the playhead; returns the flag boxes. */
export function drawScene(ctx: CanvasRenderingContext2D, s: Scene, c: Colors): FlagBox[] {
  const { vp, height } = s
  const width = vp.width
  ctx.clearRect(0, 0, width, height)
  const laneH = laneHeight(height)
  const t0 = xToTime(vp, 0)
  const t1 = xToTime(vp, width)
  const inSong = (x: number) => Math.min(width, Math.max(0, x))
  const songX0 = inSong(timeToX(vp, 0))
  const songX1 = inSong(timeToX(vp, s.duration))

  // Lanes: alternating backgrounds, then the outside of the song dimmed.
  STEM_NAMES.forEach((_, i) => {
    ctx.globalAlpha = i % 2 ? 0.35 : 0.2
    ctx.fillStyle = c.secondary
    ctx.fillRect(songX0, HEADER_H + i * laneH, songX1 - songX0, laneH)
  })
  ctx.globalAlpha = 1
  ctx.fillStyle = c.surface
  ctx.fillRect(0, 0, width, RULER_H)

  // Loop range: shaded across the lanes, solid in the loop strip.
  if (s.loop) {
    const ax = timeToX(vp, s.loop.a)
    const bx = timeToX(vp, s.loop.b)
    ctx.fillStyle = c.primary
    ctx.globalAlpha = 0.1
    ctx.fillRect(ax, RULER_H, bx - ax, height - RULER_H)
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.roundRect(ax, 3, Math.max(2, bx - ax), LOOP_H - 6, 4)
    ctx.fill()
    ctx.globalAlpha = 0.7
    ctx.fillRect(ax - 0.5, RULER_H, 1, height - RULER_H)
    ctx.fillRect(bx - 0.5, RULER_H, 1, height - RULER_H)
    ctx.globalAlpha = 1
  } else if (s.pendingA !== null) {
    ctx.fillStyle = c.primary
    ctx.fillRect(timeToX(vp, s.pendingA) - 0.5, 0, 1, height)
  }

  drawTimes(ctx, s, c, t0, t1)
  drawGrid(ctx, s, c, t0, t1)
  STEM_NAMES.forEach((name, i) => drawWave(ctx, s, c[name], i, laneH))
  return drawMarkers(ctx, s, c)
}

/** Nice time steps for the ruler's clock labels, in seconds. */
const TIME_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]

const clock = (t: number, step: number) => {
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0
  return `${m}:${sec.toFixed(digits).padStart(digits ? 3 + digits : 2, "0")}`
}

/** Clock time along the loop strip, so the ruler still reads when zoomed in between beats. */
function drawTimes(ctx: CanvasRenderingContext2D, s: Scene, c: Colors, t0: number, t1: number) {
  const step = TIME_STEPS.find((x) => x * s.vp.pps >= 90) ?? 60
  ctx.font = "500 10px Geist Variable, system-ui, sans-serif"
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"
  ctx.fillStyle = c.muted
  ctx.globalAlpha = 0.7
  for (let k = Math.max(0, Math.ceil(t0 / step)); k * step <= Math.min(t1, s.duration); k++) {
    const t = k * step
    const x = Math.round(timeToX(s.vp, t)) + 0.5
    ctx.fillRect(x - 0.5, 0, 1, 4)
    ctx.fillText(clock(t, step), x + 3, LOOP_H / 2 + 1)
  }
  ctx.globalAlpha = 1
}

function drawGrid(ctx: CanvasRenderingContext2D, s: Scene, c: Colors, t0: number, t1: number) {
  const { vp, height, grid } = s
  const beats = grid.beats
  if (beats.length === 0) return
  const times = beats.map((b) => b.time)
  const from = Math.max(0, lastAtOrBefore(times, t0))
  // Thin beat lines once they are far enough apart; bar lines always (thinned when bars get tiny).
  const beatPx = beats.length > 1 ? ((times[times.length - 1] - times[0]) / (beats.length - 1)) * vp.pps : 0
  const showBeats = beatPx >= 7
  let lastBarX = -Infinity
  let lastLabelX = -Infinity
  ctx.font = FONT
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"
  for (let i = from; i < beats.length && times[i] <= t1; i++) {
    const b = beats[i]
    const x = Math.round(timeToX(vp, b.time)) + 0.5
    const bar = b.beat === 1
    if (!bar && !showBeats) continue
    if (bar && x - lastBarX < 3) continue
    if (bar) lastBarX = x
    ctx.strokeStyle = c.fg
    ctx.globalAlpha = (bar ? 0.3 : 0.1) * (b.auto ? 0.6 : 1)
    ctx.setLineDash(b.auto ? [3, 3] : [])
    ctx.beginPath()
    ctx.moveTo(x, bar ? LOOP_H : RULER_H - 6)
    ctx.lineTo(x, height)
    ctx.stroke()
    // Bar numbers (and beat numbers when roomy) in the ruler.
    const label = bar ? (b.bar === 0 ? "0" : String(b.bar)) : beatPx >= 34 ? `${b.bar}.${b.beat}` : null
    if (label && x - lastLabelX >= (bar ? 22 : 30)) {
      ctx.setLineDash([])
      ctx.globalAlpha = bar ? 0.9 : 0.5
      ctx.fillStyle = bar ? c.fg : c.muted
      ctx.fillText(label, x + 3, LOOP_H + (RULER_H - LOOP_H) / 2)
      lastLabelX = x
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

function drawWave(ctx: CanvasRenderingContext2D, s: Scene, color: string, lane: number, laneH: number) {
  const { vp } = s
  const wave = s.waves[lane]
  const mid = HEADER_H + lane * laneH + laneH / 2
  const half = (laneH / 2 - 3) * s.amp
  const clampY = (v: number) => Math.max(-laneH / 2 + 1, Math.min(laneH / 2 - 1, v))
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.globalAlpha = s.gains[lane] === 0 ? 0.25 : 0.9
  const x0 = Math.max(0, Math.floor(timeToX(vp, 0)))
  const x1 = Math.min(vp.width, Math.ceil(timeToX(vp, s.duration)))
  if (wave) {
    const perPx = wave.sampleRate / vp.pps
    if (perPx < 1.5) {
      // Closer than a sample per pixel or two: draw the samples themselves.
      const ch = wave.channels[0]
      const first = Math.max(0, Math.floor(xToTime(vp, x0) * wave.sampleRate) - 1)
      const last = Math.min(wave.length - 1, Math.ceil(xToTime(vp, x1) * wave.sampleRate) + 1)
      ctx.lineWidth = 1.25
      ctx.beginPath()
      for (let i = first; i <= last; i++) {
        const x = timeToX(vp, i / wave.sampleRate)
        const y = mid - clampY(ch[i] * half)
        if (i === first) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      if (perPx < 0.25) for (let i = first; i <= last; i++) ctx.fillRect(timeToX(vp, i / wave.sampleRate) - 1.5, mid - clampY(ch[i] * half) - 1.5, 3, 3)
      ctx.globalAlpha = 1
      return
    }
    if (wave.ready || perPx < 256) {
      ctx.beginPath()
      for (let x = x0; x < x1; x++) {
        const [lo, hi] = rangeOf(wave, xToTime(vp, x) * wave.sampleRate, xToTime(vp, x + 1) * wave.sampleRate)
        const top = mid - clampY(hi * half)
        const bottom = mid - clampY(lo * half)
        ctx.rect(x, top, 1, Math.max(1, bottom - top))
      }
      ctx.fill()
      ctx.globalAlpha = 1
      return
    }
  }
  // Until the real waveform is ready: the coarse peaks (max-abs, 20 per second), mirrored.
  const p = s.peaks?.stems[STEM_NAMES[lane]]
  if (p && s.peaks) {
    const sps = s.peaks.samplesPerSecond
    ctx.beginPath()
    for (let x = x0; x < x1; x++) {
      const a = Math.floor(xToTime(vp, x) * sps)
      const b = Math.max(a + 1, Math.ceil(xToTime(vp, x + 1) * sps))
      let m = 0
      for (let i = Math.max(0, a); i < Math.min(p.length, b); i++) m = Math.max(m, p[i])
      const h = Math.max(1, clampY(m * half))
      ctx.rect(x, mid - h, 1, h * 2)
    }
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawMarkers(ctx: CanvasRenderingContext2D, s: Scene, c: Colors): FlagBox[] {
  const { vp, height, markers } = s
  const boxes: FlagBox[] = []
  ctx.font = FONT
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"
  // The auto marker at 0:00 is the song's default, not a marker the user placed: no flag for it.
  const order = markers.map((_, i) => i).filter((i) => i !== s.selected && !isImplicitStart(markers, i))
  if (s.selected !== null && markers[s.selected] && !isImplicitStart(markers, s.selected)) order.push(s.selected)
  const y = RULER_H + (TEMPO_H - FLAG_H) / 2
  if (visibleMarkerCount(markers) === 0) {
    ctx.fillStyle = c.muted
    ctx.fillText(EMPTY_HINT, Math.max(0, timeToX(vp, 0)) + 8, y + FLAG_H / 2 + 0.5)
  }
  for (const i of order) {
    const m = markers[i]
    const x = Math.round(timeToX(vp, m.time)) + 0.5
    const label = flagLabel(m)
    const w = Math.ceil(ctx.measureText(label).width) + 14
    if (x + w < 0 || x > vp.width) continue
    const on = i === s.selected
    const manual = m.kind === "manual"
    // The marker line runs through the lanes.
    ctx.globalAlpha = on ? 0.95 : 0.6
    ctx.strokeStyle = manual || on ? c.primary : c.muted
    ctx.lineWidth = on ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.lineWidth = 1
    ctx.globalAlpha = 1
    ctx.fillStyle = on ? c.primary : c.secondary
    ctx.beginPath()
    ctx.roundRect(x, y, w, FLAG_H, [0, 6, 6, 0])
    ctx.fill()
    if (!on) {
      ctx.strokeStyle = manual ? c.primary : c.border
      ctx.globalAlpha = manual ? 0.6 : 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = on ? c.onPrimary : manual ? c.fg : c.muted
    ctx.fillText(label, x + 7, y + FLAG_H / 2 + 0.5)
    boxes.push({ index: i, x0: x - 4, x1: x + w })
  }
  return boxes
}

/** Playhead (and a ghost marker where one would be added), on the overlay canvas. */
export function drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport, height: number, c: Colors, playhead: number, ghost: number | null) {
  ctx.clearRect(0, 0, vp.width, height)
  if (ghost !== null) {
    const gx = Math.round(timeToX(vp, ghost)) + 0.5
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = c.primary
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(gx, RULER_H)
    ctx.lineTo(gx, height)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  const x = Math.round(timeToX(vp, playhead))
  if (x < -8 || x > vp.width + 8) return
  ctx.fillStyle = c.fg
  ctx.fillRect(x - 1, LOOP_H, 2, height - LOOP_H)
  ctx.beginPath()
  ctx.moveTo(x - 6, LOOP_H)
  ctx.lineTo(x + 6, LOOP_H)
  ctx.lineTo(x, LOOP_H + 7)
  ctx.closePath()
  ctx.fill()
}
