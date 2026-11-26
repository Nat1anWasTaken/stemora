import { create } from "zustand"
import type { PlaybackSettings, SongDetail, StemName } from "@/lib/api"
import { StemEngine } from "@/player/engine"
import { startKeepAlive, stopKeepAlive } from "@/player/keepAlive"
import { applyPreset, clampLoop, defaultMixer, toggleIn, type LoopRegion, type MixerState, type Preset } from "@/player/mixer"
import { initialSettings } from "@/player/settings"
import { fetchAnalysis, type Analysis } from "@/player/analysis"
import { computePeaks, fetchPeaks, type Peaks } from "@/player/peaks"
import { MAX_SEMITONES, MAX_SPEED, MIN_SPEED } from "@/player/tempo"
import { loadClickSound, saveClickSound } from "@/player/click-sounds"
import { heardSemitones, loadTransposed, saveTransposed, toggleTransposed as toggleStem } from "@/player/transpose"
import { buildGrid, defaultMarkers, markerClicks, normalizeMarkers, type BeatGrid, type TempoMarker } from "@/player/tempo-map"

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
  /** Metronome sound (an id from CLICK_SOUNDS); this browser's last choice is the default for songs never set up. */
  clickSound: string
  /** Playback speed, 1 = original tempo. */
  speed: number
  /** Key change in semitones, as set on the dial (kept while the key switch is off). */
  semitones: number
  /** The key switch: whether `semitones` is heard. Off plays the original key, for comparing against the transposed one. */
  keyEnabled: boolean
  /** Stems that follow the key change (the rest keep their original key). Drums are left out by default. */
  transposed: StemName[]
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
  setClickSound: (id: string) => void
  setSpeed: (speed: number) => void
  /** Sets the dial; also turns the key switch on, so a turn of the dial is always heard. */
  setSemitones: (n: number) => void
  setKeyEnabled: (enabled: boolean) => void
  toggleTransposed: (name: StemName) => void
  /** Whether `markers` is a preview (mid-drag) rather than a state to keep. */
  markersDraft: boolean
  /** Counts the user's committed tempo map changes (edits, undo, redo), not loading or previews. */
  markerEdits: number
  /**
   * Shows a new tempo map. `from` (the state before the edit, e.g. before a drag began) goes on the undo stack;
   * `draft` marks a preview that is neither saved nor put in the history.
   */
  setMarkers: (markers: TempoMarker[], opts?: { from?: TempoMarker[]; draft?: boolean }) => void
  undo: () => void
  redo: () => void
}

/** The playback settings set the player is on now (what docs/playback.md calls a settings set). */
export const settingsOf = (s: Pick<PlayerState, "mixer" | "speed" | "semitones" | "keyEnabled" | "transposed" | "metronome" | "clickSound">): PlaybackSettings => ({
  mixer: s.mixer,
  speed: s.speed,
  semitones: s.semitones,
  key_enabled: s.keyEnabled,
  transposed: s.transposed,
  metronome: s.metronome,
  click_sound: s.clickSound,
})

export const usePlayer = create<PlayerState>((set, get) => {
  const updateMixer = (fn: (m: MixerState) => MixerState) => {
    const mixer = fn(get().mixer)
    set({ mixer })
    engine?.setMixer(mixer)
  }
  const applyKey = () => {
    const { semitones, keyEnabled, transposed } = get()
    engine?.setPitch(heardSemitones(semitones, keyEnabled), transposed)
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
    engine?.setClicks(markerClicks(grid, markers, duration))
  }
  /** A new tempo map and its grid in one update, so subscribers never see one without the other. */
  const showMarkers = (markers: TempoMarker[], draft: boolean) => {
    const { analysis, duration, markerEdits } = get()
    const grid = buildGrid(markers, analysis, duration)
    set({ markers, grid, markersDraft: draft, markerEdits: draft ? markerEdits : markerEdits + 1, canUndo: past.length > 0, canRedo: future.length > 0 })
    engine?.setClicks(markerClicks(grid, markers, duration))
  }

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
    clickSound: loadClickSound(),
    speed: 1,
    semitones: 0,
    keyEnabled: true,
    transposed: loadTransposed(),
    canShift: null,
    peaks: null,
    analysis: null,
    markers: defaultMarkers(),
    grid: { beats: [], bars: [] },
    canUndo: false,
    canRedo: false,
    markersDraft: false,
    markerEdits: 0,

    async load(detail) {
      get().unload()
      const e = new StemEngine()
      engine = e
      abort = new AbortController()
      const s = initialSettings(detail.song.id, detail.settings)
      const mixer = s.mixer
      past = []
      future = []
      // The song record's length lets the charts and tempo map show before the stems are decoded.
      set({ songId: detail.song.id, status: "loading", loadProgress: 0, error: null, mixer, duration: detail.song.duration_s ?? 0, loop: null, pendingA: null, playing: false, peaks: null, analysis: null, speed: s.speed, semitones: s.semitones, keyEnabled: s.key_enabled, transposed: s.transposed, metronome: s.metronome, clickSound: s.click_sound, canShift: null, markers: normalizeMarkers(detail.tempo_markers ?? defaultMarkers()), canUndo: false, canRedo: false })
      e.setSpeed(s.speed)
      e.setMetronome(get().metronome)
      e.setClickSound(get().clickSound)
      applyKey()
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
      set({ songId: null, status: "idle", playing: false, duration: 0, loop: null, pendingA: null, peaks: null, analysis: null, speed: 1, semitones: 0, keyEnabled: true, markers: defaultMarkers(), grid: { beats: [], bars: [] }, canUndo: false, canRedo: false })
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
    setClickSound(id) {
      set({ clickSound: id })
      saveClickSound(id)
      engine?.setClickSound(id)
    },
    setSpeed(speed) {
      const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
      set({ speed: s })
      engine?.setSpeed(s)
    },
    setSemitones(n) {
      const st = Math.min(MAX_SEMITONES, Math.max(-MAX_SEMITONES, Math.round(n)))
      set({ semitones: st, keyEnabled: true })
      applyKey()
    },
    setKeyEnabled(enabled) {
      set({ keyEnabled: enabled })
      applyKey()
    },
    toggleTransposed(name) {
      const transposed = toggleStem(get().transposed, name)
      set({ transposed })
      saveTransposed(transposed)
      applyKey()
    },
    setMarkers(markers, opts = {}) {
      // A drag that ends where it began (a locked marker snapping back) is no edit: just end the preview.
      if (opts.from && !opts.draft && JSON.stringify(markers) === JSON.stringify(opts.from)) {
        const grid = buildGrid(opts.from, get().analysis, get().duration)
        set({ markers: opts.from, grid, markersDraft: false })
        engine?.setClicks(markerClicks(grid, opts.from, get().duration))
        return
      }
      if (opts.from && !opts.draft) {
        past = [...past, opts.from].slice(-HISTORY)
        future = []
      }
      showMarkers(markers, !!opts.draft)
    },
    undo() {
      const prev = past.pop()
      if (!prev) return
      future.push(get().markers)
      showMarkers(prev, false)
    },
    redo() {
      const next = future.pop()
      if (!next) return
      past.push(get().markers)
      showMarkers(next, false)
    },
  }
})
