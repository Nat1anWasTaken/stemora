import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { effectiveGain, STEM_NAMES } from "@/player/mixer"
import { getBuffers, getPosition, usePlayer } from "@/player/store"
import { canDeleteMarker, markerIndexAt, moveMarker, snapTime, type TempoMarker } from "@/player/tempo-map"
import { waveOf, type Wave } from "@/player/waveform-data"
import { useCommands } from "@/hooks/use-commands"
import type { Command } from "@/lib/commands"
import { addMarker, deleteMarker, locateMarker, moveMarkerTo, nudgeMarker } from "@/player/ui/tempo-editor/actions"
import { DesktopToolbar, MobileToolbar, type EditorControls } from "@/player/ui/tempo-editor/marker-inspector"
import { drawOverlay, drawScene, LOOP_H, readColors, RULER_H, TEMPO_H, type Colors, type FlagBox } from "@/player/ui/tempo-editor/render"
import { centerOn, clampView, fitView, follow, timeToX, xToTime, zoomAt, type Viewport } from "@/player/ui/tempo-editor/viewport"

/** Seconds shown across the editor when it opens. */
const START_SPAN = { desktop: 30, phone: 8 }
/** Px within which a loop edge can be grabbed. */
const EDGE_HIT = 6
/** Px a press may move and still count as a click / tap. */
const SLOP = 4
const MIN_AMP = 0.5
const MAX_AMP = 8

type Gesture =
  | { kind: "marker"; index: number; from: TempoMarker[]; x0: number; moved: boolean; last: TempoMarker[] | null }
  | { kind: "loop"; anchor: number; a: number; b: number; x0: number }
  | { kind: "edge"; which: "a" | "b"; a: number; b: number }
  | { kind: "seek" }
  | { kind: "scrub"; x0: number; pos0: number; moved: boolean; resume: boolean; samples: { x: number; t: number }[]; down: number }
  | { kind: "pinch"; d0: number; pps0: number }

/**
 * The tempo editor: bar ruler (drag its top strip to set the loop), tempo lane with the markers, and the four stems'
 * real waveforms on the beat grid. Desktop works like a DAW (wheel scrolls, Ctrl/⌘+wheel zooms at the pointer, drag
 * markers, double-click to add, keys in `onKey`). `centered` (phones) keeps the cursor in the middle: drag the song
 * under it, pinch to zoom around it, and edit markers with the toolbar.
 * Its tools render into `toolbar`, the player's shared workspace toolbar, so every view keeps them in one place.
 */
export function TempoEditor({ centered, toolbar }: { centered: boolean; toolbar: HTMLElement | null }) {
  const wrap = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const bpmRef = useRef<HTMLInputElement>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [atPlayhead, setAtPlayhead] = useState(0)
  const [following, setFollowing] = useState(true)
  const markerCount = usePlayer((s) => s.markers.length)
  const atPlayheadRef = useRef(0)
  const live = useRef({ pinned, following })
  /** Imperative handles the toolbar and keys use, set up by the drawing effect. */
  const view = useRef<{ zoom: (f: number) => void; fit: () => void } | null>(null)
  const active = pinned !== null && pinned < markerCount ? pinned : Math.min(atPlayhead, markerCount - 1)

  useEffect(() => {
    live.current = { pinned: pinned !== null && pinned < markerCount ? pinned : null, following }
  }, [pinned, following, markerCount])

  // Pressing play brings the view back to the playhead.
  useEffect(() => usePlayer.subscribe((s, p) => {
    if (s.playing && !p.playing) setFollowing(true)
  }), [])

  useEffect(() => {
    const box = wrap.current!
    const cv = base.current!
    const ov = over.current!
    const ctx = cv.getContext("2d")!
    const octx = ov.getContext("2d")!
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let vp: Viewport = { start: 0, pps: 0, width: 1 }
    let colors: Colors | null = null
    let flags: FlagBox[] = []
    let baseSig = ""
    let overSig = ""
    let amp = 1
    let gesture: Gesture | null = null
    let dragPos: number | null = null
    let ghost: number | null = null
    let lastSeek = 0
    let inertia = 0
    let waves: (Wave | null)[] = []
    let waveSrc: unknown[] = []
    let wavesReady = 0
    const pointers = new Map<number, { x: number; y: number }>()
    // Pointer events carry no click count in Chromium, so double clicks are counted here.
    let lastDown = { t: 0, x: 0, y: 0 }
    const isDouble = (x: number, y: number) => {
      const now = performance.now()
      const double = now - lastDown.t < 400 && Math.hypot(x - lastDown.x, y - lastDown.y) < 6
      lastDown = double ? { t: 0, x, y } : { t: now, x, y }
      return double
    }

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      w = box.clientWidth
      h = box.clientHeight
      for (const c of [cv, ov]) {
        c.width = Math.max(1, Math.round(w * dpr))
        c.height = Math.max(1, Math.round(h * dpr))
      }
      vp = { ...vp, width: Math.max(1, w) }
      baseSig = ""
      overSig = ""
    }
    const ro = new ResizeObserver(resize)
    ro.observe(box)
    resize()

    const dur = () => usePlayer.getState().duration
    const setView = (next: Viewport) => {
      vp = clampView(next, dur(), centered)
    }
    const stopFollowing = () => {
      if (!centered && live.current.following) setFollowing(false)
    }
    const anchorX = () => {
      const x = timeToX(vp, dragPos ?? getPosition())
      return centered ? vp.width / 2 : x >= 0 && x <= vp.width ? x : vp.width / 2
    }
    view.current = {
      zoom: (f) => setView(zoomAt(vp, f, anchorX(), dur(), centered)),
      fit: () => {
        stopFollowing()
        setView(fitView(vp.width, dur()))
      },
    }

    const syncWaves = () => {
      const bufs = getBuffers()
      if (bufs.length === waveSrc.length && bufs.every((b, i) => b.buffer === waveSrc[i])) return
      waveSrc = bufs.map((b) => b.buffer)
      waves = STEM_NAMES.map((name) => {
        const b = bufs.find((x) => x.name === name)
        return b ? waveOf(b.buffer, () => wavesReady++) : null
      })
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const st = usePlayer.getState()
      const duration = st.duration
      if (!colors) colors = readColors(cv)
      if (st.status !== "ready" || duration <= 0) {
        if (baseSig !== "empty") {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, w, h)
          octx.setTransform(dpr, 0, 0, dpr, 0, 0)
          octx.clearRect(0, 0, w, h)
          baseSig = "empty"
        }
        return
      }
      syncWaves()
      if (vp.pps === 0) vp = { start: 0, width: vp.width, pps: vp.width / Math.min(duration, centered ? START_SPAN.phone : START_SPAN.desktop) }
      const pos = dragPos ?? getPosition()
      if (centered) vp = centerOn(vp, pos, duration)
      else if (live.current.following && !gesture) vp = follow(vp, pos, duration)
      vp = clampView(vp, duration, centered)

      const at = markerIndexAt(st.markers, pos)
      if (at !== atPlayheadRef.current) {
        atPlayheadRef.current = at
        setAtPlayhead(at)
      }
      const selected = live.current.pinned ?? at
      const loop = gesture?.kind === "loop" || gesture?.kind === "edge" ? { a: gesture.a, b: gesture.b } : st.loop ? { a: st.loop.a, b: st.loop.b } : null
      const gains = STEM_NAMES.map((n) => effectiveGain(n, st.mixer))
      const sig = [w, h, vp.start, vp.pps, ids(st.grid), ids(st.markers), selected, loop?.a, loop?.b, st.pendingA, gains.join(), amp, wavesReady, st.peaks ? 1 : 0].join("|")
      if (sig !== baseSig) {
        baseSig = sig
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        flags = drawScene(ctx, { vp, height: h, duration, waves, peaks: st.peaks, gains, grid: st.grid, markers: st.markers, selected, loop, pendingA: st.pendingA, amp }, colors)
      }
      const osig = `${sig}|${pos}|${ghost}`
      if (osig !== overSig) {
        overSig = osig
        octx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawOverlay(octx, vp, h, colors, pos, ghost)
      }
    }
    raf = requestAnimationFrame(frame)

    const local = (e: PointerEvent | WheelEvent) => {
      const r = ov.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const flagAt = (x: number, y: number) => (y >= RULER_H - 2 && y < RULER_H + TEMPO_H + 2 ? flags.findLast((f) => x >= f.x0 && x <= f.x1)?.index ?? null : null)
    const seekThrottled = (t: number, force = false) => {
      if (force || performance.now() - lastSeek > 90) {
        usePlayer.getState().seek(t)
        lastSeek = performance.now()
      }
    }
    const clampT = (t: number) => Math.min(dur(), Math.max(0, t))

    // --- Desktop: mouse and pen ---
    const onDownDesktop = (e: PointerEvent) => {
      const st = usePlayer.getState()
      if (st.status !== "ready" || e.button !== 0) return
      const { x, y } = local(e)
      const t = clampT(xToTime(vp, x))
      ov.setPointerCapture(e.pointerId)
      const double = isDouble(x, y)
      const flag = flagAt(x, y)
      if (flag !== null) {
        setPinned(flag)
        if (double) {
          window.setTimeout(() => bpmRef.current?.focus(), 0)
          return
        }
        if (flag > 0) gesture = { kind: "marker", index: flag, from: st.markers, x0: x, moved: false, last: null }
        return
      }
      if (y >= RULER_H && y < RULER_H + TEMPO_H) {
        if (double) {
          const i = addMarker(t)
          if (i !== false) setPinned(i)
        } else setPinned(null)
        return
      }
      if (st.loop && y >= LOOP_H) {
        const da = Math.abs(x - timeToX(vp, st.loop.a))
        const db = Math.abs(x - timeToX(vp, st.loop.b))
        if (Math.min(da, db) <= EDGE_HIT) {
          gesture = { kind: "edge", which: da <= db ? "a" : "b", a: st.loop.a, b: st.loop.b }
          return
        }
      }
      if (y < LOOP_H) {
        gesture = { kind: "loop", anchor: t, a: t, b: t, x0: x }
        return
      }
      gesture = { kind: "seek" }
      dragPos = t
      seekThrottled(t, true)
    }
    const onMoveDesktop = (e: PointerEvent) => {
      const { x, y } = local(e)
      const st = usePlayer.getState()
      const t = clampT(xToTime(vp, x))
      if (!gesture) {
        // Hover: what a press would do.
        const flag = flagAt(x, y)
        const lane = y >= RULER_H && y < RULER_H + TEMPO_H
        const edge = st.loop && y >= LOOP_H && Math.min(Math.abs(x - timeToX(vp, st.loop.a)), Math.abs(x - timeToX(vp, st.loop.b))) <= EDGE_HIT
        ov.style.cursor = flag !== null ? (flag > 0 ? "grab" : "pointer") : edge ? "ew-resize" : lane ? "copy" : y < LOOP_H ? "col-resize" : "text"
        ghost = lane && flag === null ? snapTime(st.markers, t) : null
        return
      }
      if (gesture.kind === "marker") {
        if (!gesture.moved && Math.abs(x - gesture.x0) < SLOP) return
        gesture.moved = true
        ov.style.cursor = "grabbing"
        const next = moveMarker(gesture.from, gesture.index, t, dur())
        if (next) {
          gesture.last = next
          st.setMarkers(next, { draft: true })
        }
      } else if (gesture.kind === "loop") {
        gesture.a = Math.min(gesture.anchor, t)
        gesture.b = Math.max(gesture.anchor, t)
      } else if (gesture.kind === "edge") {
        if (gesture.which === "a") gesture.a = Math.min(t, gesture.b - 0.25)
        else gesture.b = Math.max(t, gesture.a + 0.25)
      } else if (gesture.kind === "seek") {
        dragPos = t
        seekThrottled(t)
      }
    }
    const onUpDesktop = (e: PointerEvent) => {
      const st = usePlayer.getState()
      const g = gesture
      gesture = null
      if (!g) return
      if (g.kind === "marker") {
        if (g.moved && g.last) st.setMarkers(g.last, { from: g.from })
        else if (g.moved) st.setMarkers(g.from)
      } else if (g.kind === "loop") {
        const { x } = local(e)
        if (Math.abs(x - g.x0) < SLOP) st.seek(g.anchor)
        else st.setLoop(g.a, g.b)
      } else if (g.kind === "edge") st.setLoop(g.a, g.b)
      else if (g.kind === "seek" && dragPos !== null) st.seek(dragPos)
      dragPos = null
    }
    const onLeave = () => {
      ghost = null
    }
    const onWheel = (e: WheelEvent) => {
      if (usePlayer.getState().status !== "ready") return
      e.preventDefault()
      const { x } = local(e)
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/⌘ + wheel, and trackpad pinch (which browsers report as ctrl + wheel).
        if (!centered) stopFollowing()
        setView(zoomAt(vp, Math.exp(-delta * 0.01), centered ? vp.width / 2 : x, dur(), centered))
        return
      }
      if (e.altKey) {
        amp = Math.min(MAX_AMP, Math.max(MIN_AMP, amp * Math.exp(-delta * 0.002)))
        return
      }
      if (centered) return
      const dx = e.shiftKey ? delta : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : delta
      stopFollowing()
      setView({ ...vp, start: vp.start + dx / vp.pps })
    }

    // --- Phone: the song moves under a fixed cursor ---
    const startInertia = (velocity: number) => {
      // velocity in seconds per ms; decays like native scrolling.
      let v = velocity
      let last = performance.now()
      const step = (now: number) => {
        const dt = now - last
        last = now
        v *= Math.exp(-dt / 325)
        dragPos = clampT((dragPos ?? getPosition()) + v * dt)
        seekThrottled(dragPos)
        if (Math.abs(v * vp.pps) < 0.02 || dragPos <= 0 || dragPos >= dur()) {
          usePlayer.getState().seek(dragPos)
          dragPos = null
          inertia = 0
          return
        }
        inertia = requestAnimationFrame(step)
      }
      inertia = requestAnimationFrame(step)
    }
    const stopInertia = () => {
      if (!inertia) return
      cancelAnimationFrame(inertia)
      inertia = 0
      if (dragPos !== null) usePlayer.getState().seek(dragPos)
      dragPos = null
    }
    const pinchDist = () => {
      const [a, b] = [...pointers.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const onDownPhone = (e: PointerEvent) => {
      const st = usePlayer.getState()
      if (st.status !== "ready") return
      ov.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, local(e))
      stopInertia()
      if (pointers.size === 2) {
        if (gesture?.kind === "scrub" && gesture.moved) st.seek(dragPos ?? getPosition())
        if (gesture?.kind === "scrub" && gesture.resume) st.play()
        dragPos = null
        gesture = { kind: "pinch", d0: pinchDist(), pps0: vp.pps }
        return
      }
      if (pointers.size > 2) return
      const { x } = local(e)
      gesture = { kind: "scrub", x0: x, pos0: getPosition(), moved: false, resume: false, samples: [{ x, t: performance.now() }], down: performance.now() }
    }
    const onMovePhone = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, local(e))
      const st = usePlayer.getState()
      if (gesture?.kind === "pinch" && pointers.size >= 2) {
        setView({ ...vp, pps: gesture.pps0 * (pinchDist() / Math.max(1, gesture.d0)) })
        return
      }
      if (gesture?.kind !== "scrub") return
      const { x } = local(e)
      if (!gesture.moved) {
        if (Math.abs(x - gesture.x0) < SLOP) return
        gesture.moved = true
        gesture.x0 = x
        gesture.pos0 = getPosition()
        if (st.playing) {
          gesture.resume = true
          st.pause()
        }
      }
      dragPos = clampT(gesture.pos0 - (x - gesture.x0) / vp.pps)
      gesture.samples.push({ x, t: performance.now() })
      if (gesture.samples.length > 6) gesture.samples.shift()
      seekThrottled(dragPos)
    }
    const onUpPhone = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      const at = local(e)
      pointers.delete(e.pointerId)
      const st = usePlayer.getState()
      const g = gesture
      if (g?.kind === "pinch") {
        if (pointers.size === 0) gesture = null
        return
      }
      gesture = null
      if (g?.kind !== "scrub") return
      if (!g.moved) {
        if (performance.now() - g.down < 400) setPinned(flagAt(at.x, at.y))
        return
      }
      const first = g.samples[0]
      const last = g.samples[g.samples.length - 1]
      const dt = last.t - first.t
      const v = dt > 0 && performance.now() - last.t < 80 ? -((last.x - first.x) / dt) / vp.pps : 0
      if (g.resume) {
        st.seek(dragPos ?? getPosition())
        dragPos = null
        st.play()
      } else if (Math.abs(v * vp.pps) > 0.3) startInertia(v)
      else {
        st.seek(dragPos ?? getPosition())
        dragPos = null
      }
    }

    const down = centered ? onDownPhone : onDownDesktop
    const move = centered ? onMovePhone : onMoveDesktop
    const up = centered ? onUpPhone : onUpDesktop
    ov.addEventListener("pointerdown", down)
    ov.addEventListener("pointermove", move)
    ov.addEventListener("pointerup", up)
    ov.addEventListener("pointercancel", up)
    ov.addEventListener("pointerleave", onLeave)
    ov.addEventListener("wheel", onWheel, { passive: false })
    // Safari's own pinch would zoom the page.
    const noGesture = (e: Event) => e.preventDefault()
    ov.addEventListener("gesturestart", noGesture)
    return () => {
      // Settle a marker drag the cleanup interrupts, as pointerup would.
      if (gesture?.kind === "marker" && gesture.moved && gesture.last) usePlayer.getState().setMarkers(gesture.last, { from: gesture.from })
      cancelAnimationFrame(raf)
      cancelAnimationFrame(inertia)
      ro.disconnect()
      view.current = null
      ov.removeEventListener("pointerdown", down)
      ov.removeEventListener("pointermove", move)
      ov.removeEventListener("pointerup", up)
      ov.removeEventListener("pointercancel", up)
      ov.removeEventListener("pointerleave", onLeave)
      ov.removeEventListener("wheel", onWheel)
      ov.removeEventListener("gesturestart", noGesture)
    }
  }, [centered])

  const locate = useCallback((dir: -1 | 1) => {
    const i = locateMarker(dir)
    if (i !== null) setPinned(i)
  }, [])
  const add = useCallback(() => {
    const i = addMarker(getPosition())
    if (i !== false) setPinned(i)
  }, [])

  // Desktop keys and palette commands (the transport's are in use-player-commands).
  const markerIndex = () => live.current.pinned ?? markerIndexAt(usePlayer.getState().markers, getPosition())
  const ready = () => usePlayer.getState().status === "ready"
  const G = "Tempo editor"
  const nudge = (dir: -1 | 1, step: number): Command => ({
    id: `tempo.nudge-${dir < 0 ? "left" : "right"}${step > 0.001 ? "-10" : ""}`,
    title: `Nudge marker ${dir < 0 ? "earlier" : "later"} (${step * 1000} ms, a beat when locked)`,
    group: G,
    keywords: ["move", "marker"],
    shortcut: `${step > 0.001 ? "Mod+Shift" : "Mod"}+${dir < 0 ? "ArrowLeft" : "ArrowRight"}`,
    repeat: true,
    enabled: ready,
    run: () => nudgeMarker(markerIndex(), dir, step),
  })
  useCommands(!centered && (() => [
    { id: "tempo.undo", title: "Undo tempo edit", group: G, shortcut: "Mod+Z", repeat: true, enabled: () => ready() && usePlayer.getState().canUndo, run: () => usePlayer.getState().undo() },
    { id: "tempo.redo", title: "Redo tempo edit", group: G, shortcut: ["Mod+Shift+Z", "Mod+Y"], repeat: true, enabled: () => ready() && usePlayer.getState().canRedo, run: () => usePlayer.getState().redo() },
    { id: "tempo.add-marker", title: "Add tempo marker at the playhead", group: G, keywords: ["new", "bpm"], shortcut: "T", enabled: ready, run: add },
    { id: "tempo.edit-bpm", title: "Edit marker BPM", group: G, keywords: ["tempo"], shortcut: "Enter", enabled: () => ready() && usePlayer.getState().markers[markerIndex()]?.kind === "manual", run: () => bpmRef.current?.focus() },
    { id: "tempo.delete-marker", title: "Delete tempo marker", group: G, keywords: ["remove"], shortcut: ["Delete", "Backspace"], enabled: () => ready() && canDeleteMarker(usePlayer.getState().markers, markerIndex()), run: () => { if (deleteMarker(markerIndex())) setPinned(null) } },
    { id: "tempo.next-marker", title: "Next tempo marker", group: G, keywords: ["go to", "locate"], shortcut: "Shift+N", enabled: ready, run: () => locate(1) },
    { id: "tempo.previous-marker", title: "Previous tempo marker", group: G, keywords: ["go to", "locate"], shortcut: "Shift+B", enabled: ready, run: () => locate(-1) },
    { id: "tempo.release", title: "Release marker selection", group: G, keywords: ["deselect", "unpin"], shortcut: "Escape", enabled: () => live.current.pinned !== null, run: () => setPinned(null) },
    nudge(-1, 0.001),
    nudge(1, 0.001),
    nudge(-1, 0.01),
    nudge(1, 0.01),
    { id: "tempo.zoom-out", title: "Zoom out", group: G, shortcut: "G", repeat: true, enabled: ready, run: () => view.current?.zoom(1 / 1.6) },
    { id: "tempo.zoom-in", title: "Zoom in", group: G, shortcut: "H", repeat: true, enabled: ready, run: () => view.current?.zoom(1.6) },
    { id: "tempo.fit", title: "Show the whole song", group: G, keywords: ["zoom", "fit"], shortcut: "Shift+F", enabled: ready, run: () => view.current?.fit() },
    { id: "tempo.follow", title: following ? "Stop following playback" : "Follow playback", group: G, keywords: ["scroll", "playhead"], shortcut: "F", enabled: ready, run: () => setFollowing((f) => !f) },
  ]), "view")

  const controls: EditorControls = useMemo(() => ({
    active,
    onLocate: locate,
    onAdd: add,
    onZoom: (f: number) => view.current?.zoom(f),
    onFit: () => view.current?.fit(),
    following,
    onFollow: () => setFollowing((f) => !f),
    bpmRef,
  }), [active, locate, add, following])

  const moveHere = () => {
    if (moveMarkerTo(active, getPosition())) usePlayer.getState().seek(usePlayer.getState().markers[active].time)
  }

  return (
    <section aria-label="Tempo map" className="flex min-h-0 flex-1 flex-col">
      {toolbar && createPortal(centered ? <MobileToolbar c={controls} onMoveHere={moveHere} /> : <DesktopToolbar c={controls} />, toolbar)}
      <div ref={wrap} className="no-gestures relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-surface/70">
        <canvas ref={base} className="absolute inset-0 size-full" aria-hidden />
        <canvas
          ref={over}
          className="absolute inset-0 size-full"
          role="img"
          aria-label="Tempo map and waveforms. Drag to move through the song; markers set the beat grid."
        />
      </div>
    </section>
  )
}

/** A small id per object (grid, marker list) so the draw signature notices a new one cheaply. */
const objectIds = new WeakMap<object, number>()
let nextId = 0
function ids(o: object): number {
  let id = objectIds.get(o)
  if (id === undefined) {
    id = ++nextId
    objectIds.set(o, id)
  }
  return id
}
