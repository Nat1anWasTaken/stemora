import { useEffect, useRef } from "react"
import { binPeaks } from "@/player/peaks"
import { clampLoop, effectiveGain, STEM_NAMES } from "@/player/mixer"
import { getPosition, usePlayer } from "@/player/store"

type Drag = { kind: "seek" } | { kind: "a" | "b" }
const HANDLE_HIT = 22 // css px

/**
 * Canvas waveform of all stems (stacked lanes). Drag anywhere to seek; drag the A/B handles to move the loop.
 * Everything (playhead, loop, handles) is painted on the canvas so no per-frame inline styles are needed.
 */
export function Waveform() {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvas.current!
    const box = wrap.current!
    const ctx = cv.getContext("2d")!
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let sig = ""
    let drag: Drag | null = null
    let dragLoop: { a: number; b: number } | null = null
    let dragPos: number | null = null
    let lastSeek = 0
    let colors: Record<string, string> | null = null
    const binCache = new Map<string, number[]>()

    const readColors = () => {
      const cs = getComputedStyle(cv)
      const g = (n: string) => cs.getPropertyValue(n).trim()
      colors = { vocals: g("--stem-vocals"), drums: g("--stem-drums"), bass: g("--stem-bass"), other: g("--stem-other"), fg: g("--foreground"), primary: g("--primary"), onPrimary: g("--primary-foreground"), muted: g("--muted-foreground") }
    }
    const resize = () => {
      dpr = window.devicePixelRatio || 1
      w = box.clientWidth
      h = box.clientHeight
      cv.width = Math.max(1, Math.round(w * dpr))
      cv.height = Math.max(1, Math.round(h * dpr))
      binCache.clear()
      sig = ""
    }
    const ro = new ResizeObserver(resize)
    ro.observe(box)
    resize()

    const xToTime = (x: number, dur: number) => Math.min(dur, Math.max(0, (x / Math.max(1, w)) * dur))
    const timeToX = (t: number, dur: number) => (t / Math.max(0.001, dur)) * w

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const st = usePlayer.getState()
      if (!colors) readColors()
      const dur = st.duration
      const pos = dragPos ?? getPosition()
      const loop = dragLoop ?? (st.loop ? { a: st.loop.a, b: st.loop.b } : null)
      const gains = STEM_NAMES.map((n) => effectiveGain(n, st.mixer))
      const s = `${w}x${h}|${Math.round(pos * 30)}|${loop?.a}|${loop?.b}|${st.pendingA}|${gains.join()}|${st.peaks ? 1 : 0}`
      if (s === sig) return
      sig = s
      const c = colors!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!st.peaks || dur <= 0) return

      const laneH = h / STEM_NAMES.length
      const barW = 3
      const step = 4
      const bins = Math.max(1, Math.floor(w / step))
      const playX = timeToX(pos, dur)

      STEM_NAMES.forEach((name, li) => {
        const peaks = st.peaks!.stems[name]
        if (!peaks) return
        const key = `${name}:${bins}`
        let b = binCache.get(key)
        if (!b) {
          b = binPeaks(peaks, st.peaks!.samplesPerSecond, dur, bins)
          binCache.set(key, b)
        }
        const cy = li * laneH + laneH / 2
        ctx.fillStyle = c[name]
        const dim = gains[li] === 0
        for (let i = 0; i < bins; i++) {
          const x = i * step
          const amp = Math.max(1, b[i] * (laneH * 0.42))
          ctx.globalAlpha = (x < playX ? 0.95 : 0.4) * (dim ? 0.35 : 1)
          ctx.beginPath()
          ctx.roundRect(x, cy - amp, barW, amp * 2, 1.5)
          ctx.fill()
        }
      })
      ctx.globalAlpha = 1

      if (loop) {
        const ax = timeToX(loop.a, dur)
        const bx = timeToX(loop.b, dur)
        ctx.globalAlpha = 0.14
        ctx.fillStyle = c.primary
        ctx.fillRect(ax, 0, bx - ax, h)
        ctx.globalAlpha = 1
        for (const [x, label] of [[ax, "A"], [bx, "B"]] as const) {
          ctx.fillStyle = c.primary
          ctx.fillRect(x - 1, 0, 2, h)
          ctx.beginPath()
          ctx.roundRect(x - 12, 6, 24, 24, 8)
          ctx.fill()
          ctx.fillStyle = c.onPrimary
          ctx.font = "600 13px Geist Variable, system-ui, sans-serif"
          ctx.textAlign = "center"
          ctx.textBaseline = "middle"
          ctx.fillText(label, x, 18.5)
        }
      } else if (st.pendingA !== null) {
        const ax = timeToX(st.pendingA, dur)
        ctx.fillStyle = c.primary
        ctx.fillRect(ax - 1, 0, 2, h)
      }

      ctx.fillStyle = c.fg
      ctx.fillRect(playX - 1, 0, 2, h)
      ctx.beginPath()
      ctx.arc(playX, h - 8, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(draw)

    const local = (e: PointerEvent) => e.clientX - cv.getBoundingClientRect().left
    const onDown = (e: PointerEvent) => {
      const st = usePlayer.getState()
      if (st.status !== "ready") return
      const x = local(e)
      const dur = st.duration
      cv.setPointerCapture(e.pointerId)
      if (st.loop) {
        const da = Math.abs(x - timeToX(st.loop.a, dur))
        const db = Math.abs(x - timeToX(st.loop.b, dur))
        if (Math.min(da, db) <= HANDLE_HIT) {
          drag = { kind: da <= db ? "a" : "b" }
          dragLoop = { a: st.loop.a, b: st.loop.b }
          return
        }
      }
      drag = { kind: "seek" }
      dragPos = xToTime(x, dur)
      st.seek(dragPos)
      lastSeek = performance.now()
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      const st = usePlayer.getState()
      const t = xToTime(local(e), st.duration)
      if (drag.kind === "seek") {
        dragPos = t
        if (performance.now() - lastSeek > 120) {
          st.seek(t)
          lastSeek = performance.now()
        }
      } else if (dragLoop) {
        dragLoop = drag.kind === "a" ? { a: Math.min(t, dragLoop.b - 0.5), b: dragLoop.b } : { a: dragLoop.a, b: Math.max(t, dragLoop.a + 0.5) }
      }
    }
    const onUp = () => {
      const st = usePlayer.getState()
      if (drag?.kind === "seek" && dragPos !== null) st.seek(dragPos)
      if (drag && drag.kind !== "seek" && dragLoop) {
        const c2 = clampLoop(dragLoop.a, dragLoop.b, st.duration)
        st.setLoop(c2.a, c2.b)
      }
      drag = null
      dragLoop = null
      dragPos = null
    }
    cv.addEventListener("pointerdown", onDown)
    cv.addEventListener("pointermove", onMove)
    cv.addEventListener("pointerup", onUp)
    cv.addEventListener("pointercancel", onUp)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener("pointerdown", onDown)
      cv.removeEventListener("pointermove", onMove)
      cv.removeEventListener("pointerup", onUp)
      cv.removeEventListener("pointercancel", onUp)
    }
  }, [])

  return (
    <div ref={wrap} className="relative h-full min-h-64 w-full overflow-hidden rounded-3xl border border-border bg-surface/70">
      <canvas ref={canvas} className="no-gestures absolute inset-0 size-full cursor-pointer" aria-label="Waveform. Drag to seek; drag the A and B handles to adjust the loop." role="img" />
    </div>
  )
}
