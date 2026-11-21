import { create } from "zustand"
import type { SongDetail, StemName } from "@/lib/api"
import { StemEngine } from "@/player/engine"
import { startKeepAlive, stopKeepAlive } from "@/player/keepAlive"
import { applyPreset, clampLoop, defaultMixer, toggleIn, type LoopRegion, type MixerState, type Preset } from "@/player/mixer"
import { loadMixer, saveMixer } from "@/player/mixerStorage"
import { fetchAnalysis, type Analysis } from "@/player/analysis"
import { computePeaks, fetchPeaks, type Peaks } from "@/player/peaks"
import { MAX_SEMITONES, MAX_SPEED, MIN_SPEED } from "@/player/tempo"
import { buildGrid, defaultMarkers, gridClicks, normalizeMarkers, type BeatGrid, type TempoMarker } from "@/player/tempo-map"

let engine: StemEngine | null = null
let abort: AbortController | null = null

/** Current playhead in seconds; read in rAF loops (not reactive). */
export const getPosition = () => engine?.position ?? 0
/** Decoded stems, for drawing the real waveform (empty until loaded). */
export const getBuffers = () => engine?.buffers ?? []

/** Undo and redo stacks of the tempo map (committed states only). */
let past: TempoMarker[][] = []
let future: TempoMarker[][] = []
const HISTORY = 200

type PlayerState = {
  songId: string | null
  status: "idle" | "loading" | "ready" | "error"
  loadProgress: number
  error: string | null
  playing: boolean
  duration: number
  mixer: MixerState
  loop: LoopRegion | null
  pendingA: number | null
  /** Metronome click on/off; it clicks on the beat grid. */
  metronome: boolean
  /** Playback speed, 1 = original tempo. */
  speed: number
  /** Key change in semitones. */
  semitones: number
  /** Whether the Signalsmith Stretch worklet can run (null while loading); without it speed changes also shift the pitch and the key cannot change. */
  canShift: boolean | null
  peaks: Peaks | null
  analysis: Analysis | null
  /** The song's tempo map and the beats it puts on the song (see tempo-map.ts). */
  markers: TempoMarker[]
  grid: BeatGrid
  canUndo: boolean
  canRedo: boolean

  load: (detail: SongDetail) => Promise<void>
  unload: () => void
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (t: number) => void
  skip: (delta: number) => void
  setVolume: (name: StemName, v: number) => void
  resetVolume: (name: StemName) => void
  toggleMute: (name: StemName) => void
  toggleSolo: (name: StemName) => void
  preset: (p: Preset) => void
  cycleLoop: () => void
  setLoop: (a: number, b: number) => void
  clearLoop: () => void
  setMetronome: (enabled: boolean) => void
  setSpeed: (speed: number) => void
  setSemitones: (n: number) => void
  /** Whether `markers` is a preview (mid-drag) rather than a state to keep. */
  markersDraft: boolean
  /**
   * Shows a new tempo map. `from` (the state before the edit, e.g. before a drag began) goes on the undo stack;
   * `draft` marks a preview that is neither saved nor put in the history.
   */
  setMarkers: (markers: TempoMarker[], opts?: { from?: TempoMarker[]; draft?: boolean }) => void
  undo: () => void
  redo: () => void
}

export const usePlayer = create<PlayerState>((set, get) => {
  const updateMixer = (fn: (m: MixerState) => MixerState) => {
    const mixer = fn(get().mixer)
    set({ mixer })
    engine?.setMixer(mixer)
    const id = get().songId
    if (id) saveMixer(id, mixer)
  }
  const applyLoop = (loop: LoopRegion | null) => {
    set({ loop })
    engine?.setLoop(loop)
  }
  // The click and every chart follow the beat grid, rebuilt whenever the markers, the analysis or the length change.
  const applyGrid = () => {
    const { markers, analysis, duration } = get()
    const grid = buildGrid(markers, analysis, duration)
    set({ grid })
    engine?.setClicks(gridClicks(grid))
  }
  const history = () => set({ canUndo: past.length > 0, canRedo: future.length > 0 })

  return {
    songId: null,
    status: "idle",
    loadProgress: 0,
    error: null,
    playing: false,
    duration: 0,
    mixer: defaultMixer(),
    loop: null,
    pendingA: null,
    metronome: false,
    speed: 1,
    semitones: 0,
    canShift: null,
    peaks: null,
    analysis: null,
    markers: defaultMarkers(),
    grid: { beats: [], bars: [] },
    canUndo: false,
    canRedo: false,
    markersDraft: false,

    async load(detail) {
      get().unload()
      const e = new StemEngine()
      engine = e
      abort = new AbortController()
      const mixer = loadMixer(detail.song.id)
      past = []
      future = []
      // The song record's length lets the charts and tempo map show before the stems are decoded.
      set({ songId: detail.song.id, status: "loading", loadProgress: 0, error: null, mixer, duration: detail.song.duration_s ?? 0, loop: null, pendingA: null, playing: false, peaks: null, analysis: null, speed: 1, semitones: 0, canShift: null, markers: normalizeMarkers(detail.tempo_markers ?? defaultMarkers()), canUndo: false, canRedo: false })
      e.setMetronome(get().metronome)
      applyGrid()
      void e.loadShifter().then((ok) => engine === e && set({ canShift: ok }))
      e.onShiftUnavailable = () => engine === e && set({ canShift: false })
      e.onEnded = () => {
        stopKeepAlive()
        set({ playing: false })
      }
      try {
        // Beat/chord analysis is optional and never blocks playback.
        if (detail.analysis_url) {
          void fetchAnalysis(detail.analysis_url).then((analysis) => {
            if (engine !== e || !analysis) return
            set({ analysis })
            applyGrid()
          })
        }
        const peaksPromise = detail.peaks_url ? fetchPeaks(detail.peaks_url) : Promise.resolve(null)
        await e.load(detail.stems.map((s) => ({ name: s.name, url: s.url })), (p) => engine === e && set({ loadProgress: p }), abort.signal)
        if (engine !== e) return
        e.setMixer(mixer)
        let peaks = await peaksPromise
        if (!peaks) peaks = { samplesPerSecond: 20, stems: Object.fromEntries(e.buffers.map((b) => [b.name, computePeaks(Array.from({ length: b.buffer.numberOfChannels }, (_, c) => b.buffer.getChannelData(c)), b.buffer.sampleRate, 20)])) }
        if (engine !== e) return
        set({ status: "ready", duration: e.duration, peaks, loadProgress: 1, markers: normalizeMarkers(get().markers, e.duration) })
        applyGrid()
      } catch (err) {
        if (engine !== e || (err instanceof DOMException && err.name === "AbortError")) return
        set({ status: "error", error: err instanceof Error ? err.message : "Could not load the stems" })
      }
    },
    unload() {
      abort?.abort()
      abort = null
      engine?.dispose()
      engine = null
      stopKeepAlive()
      past = []
      future = []
      set({ songId: null, status: "idle", playing: false, duration: 0, loop: null, pendingA: null, peaks: null, analysis: null, speed: 1, semitones: 0, markers: defaultMarkers(), grid: { beats: [], bars: [] }, canUndo: false, canRedo: false })
    },
    play() {
      if (!engine || get().status !== "ready") return
      startKeepAlive() // inside the user gesture
      set({ playing: true })
      engine.play().catch(() => set({ playing: false }))
    },
    pause() {
      engine?.pause()
      stopKeepAlive()
      set({ playing: false })
    },
    toggle() {
      if (get().playing) get().pause()
      else get().play()
    },
    seek(t) {
      engine?.seek(t)
    },
    skip(delta) {
      if (engine) engine.seek(engine.position + delta)
    },
    setVolume: (name, v) => updateMixer((m) => ({ ...m, volumes: { ...m.volumes, [name]: Math.min(1, Math.max(0, v)) } })),
    resetVolume: (name) => updateMixer((m) => ({ ...m, volumes: { ...m.volumes, [name]: 1 } })),
    toggleMute: (name) => updateMixer((m) => ({ ...m, muted: toggleIn(m.muted, name) })),
    toggleSolo: (name) => updateMixer((m) => ({ ...m, soloed: toggleIn(m.soloed, name) })),
    preset: (p) => updateMixer((m) => applyPreset(m, p)),
    cycleLoop() {
      const { loop, pendingA, duration } = get()
      const pos = getPosition()
      if (loop) return get().clearLoop()
      if (pendingA === null) return set({ pendingA: pos })
      const { a, b } = clampLoop(pendingA, pos, duration)
      set({ pendingA: null })
      applyLoop({ a, b, enabled: true })
    },
    setLoop(a, b) {
      const c = clampLoop(a, b, get().duration)
      set({ pendingA: null })
      applyLoop({ ...c, enabled: true })
    },
    clearLoop() {
      set({ pendingA: null })
      applyLoop(null)
    },
    setMetronome(enabled) {
      set({ metronome: enabled })
      engine?.setMetronome(enabled)
    },
    setSpeed(speed) {
      const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
      set({ speed: s })
      engine?.setSpeed(s)
    },
    setSemitones(n) {
      const st = Math.min(MAX_SEMITONES, Math.max(-MAX_SEMITONES, Math.round(n)))
      set({ semitones: st })
      engine?.setPitch(st)
    },
    setMarkers(markers, opts = {}) {
      if (opts.from && !opts.draft) {
        past = [...past, opts.from].slice(-HISTORY)
        future = []
      }
      set({ markers, markersDraft: !!opts.draft })
      applyGrid()
      history()
    },
    undo() {
      const prev = past.pop()
      if (!prev) return
      future.push(get().markers)
      set({ markers: prev, markersDraft: false })
      applyGrid()
      history()
    },
    redo() {
      const next = future.pop()
      if (!next) return
      past.push(get().markers)
      set({ markers: next, markersDraft: false })
      applyGrid()
      history()
    },
  }
})
