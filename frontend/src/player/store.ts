import { create } from "zustand"
import type { SongDetail, StemName } from "@/lib/api"
import { StemEngine, type Metronome } from "@/player/engine"
import { startKeepAlive, stopKeepAlive } from "@/player/keepAlive"
import { applyPreset, clampLoop, defaultMixer, toggleIn, type LoopRegion, type MixerState, type Preset } from "@/player/mixer"
import { loadMixer, saveMixer } from "@/player/mixerStorage"
import { computePeaks, fetchPeaks, type Peaks } from "@/player/peaks"

let engine: StemEngine | null = null
let abort: AbortController | null = null

/** Current playhead in seconds; read in rAF loops (not reactive). */
export const getPosition = () => engine?.position ?? 0

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
  metronome: Metronome
  peaks: Peaks | null

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
  setMetronome: (m: Partial<Metronome>) => void
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
    metronome: { enabled: false, bpm: 100, countIn: false },
    peaks: null,

    async load(detail) {
      get().unload()
      const e = new StemEngine()
      engine = e
      abort = new AbortController()
      const mixer = loadMixer(detail.song.id)
      set({ songId: detail.song.id, status: "loading", loadProgress: 0, error: null, mixer, loop: null, pendingA: null, playing: false, peaks: null })
      e.onEnded = () => {
        stopKeepAlive()
        set({ playing: false })
      }
      try {
        const peaksPromise = detail.peaks_url ? fetchPeaks(detail.peaks_url) : Promise.resolve(null)
        await e.load(detail.stems.map((s) => ({ name: s.name, url: s.url })), (p) => engine === e && set({ loadProgress: p }), abort.signal)
        if (engine !== e) return
        e.setMixer(mixer)
        let peaks = await peaksPromise
        if (!peaks) peaks = { samplesPerSecond: 20, stems: Object.fromEntries(e.buffers.map((b) => [b.name, computePeaks(Array.from({ length: b.buffer.numberOfChannels }, (_, c) => b.buffer.getChannelData(c)), b.buffer.sampleRate, 20)])) }
        if (engine !== e) return
        set({ status: "ready", duration: e.duration, peaks, loadProgress: 1 })
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
      set({ songId: null, status: "idle", playing: false, duration: 0, loop: null, pendingA: null, peaks: null })
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
    setMetronome(m) {
      const next = { ...get().metronome, ...m }
      next.bpm = Math.min(240, Math.max(30, Math.round(next.bpm)))
      set({ metronome: next })
      engine?.setMetronome(next)
    },
  }
})
