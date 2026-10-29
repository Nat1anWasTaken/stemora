/**
 * Framework-free multitrack engine on the Web Audio API.
 *
 * Sync strategy: all stems decode to AudioBuffers of the same sample rate (the context rate). Playback starts every
 * AudioBufferSourceNode with the same `when` (a shared ctx.currentTime) and the same `offset`, so they stay sample
 * accurate. Seeking/restarting stops and recreates all sources together. A-B looping uses the sources' own
 * loopStart/loopEnd (sample-accurate wrap, no timers); position is derived from the audio clock.
 *
 * Tempo and key: every source shares one playbackRate (speed), which keeps them in sync but also shifts the pitch. All
 * stems then pass through a single SoundTouch AudioWorklet on a common bus that undoes the speed's pitch change and
 * applies the key change. It is bypassed at normal speed and key, and the metronome never goes through it.
 */
import { SoundTouchNode } from "@soundtouchjs/audio-worklet"
import processorUrl from "@soundtouchjs/audio-worklet/processor?url"
import type { StemName } from "@/lib/api"
import { defaultMixer, effectiveGain, loopedPosition, clampLoop, type LoopRegion, type MixerState } from "@/player/mixer"

export type StemSource = { name: StemName; url: string }
export type Metronome = { enabled: boolean; bpm: number }

type StemNode = { name: StemName; buffer: AudioBuffer; gain: GainNode; source: AudioBufferSourceNode | null }

type AudioContextCtor = typeof AudioContext

/** Output delay of the SoundTouch worklet (measured at ~128 ms regardless of speed and key), in seconds. */
const SHIFTER_LATENCY = 0.128

export class StemEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private stemBus: GainNode | null = null
  private shifter: SoundTouchNode | null = null
  private shifterModule: Promise<boolean> | null = null
  private canShift = false
  private speed = 1
  private semitones = 0
  private stems: StemNode[] = []
  private mixer: MixerState = defaultMixer()
  private loop: LoopRegion | null = null
  private activeLoop: { a: number; b: number } | null = null
  private playing = false
  private startedAt = 0 // ctx time at which `offset` was (or will be) reached
  private offset = 0 // song position at startedAt (the song then advances `speed` seconds per second)
  private floor = 0 // position never reads below this while the shifter's delay is still filling after a start
  private gen = 0
  private metro: Metronome = { enabled: false, bpm: 100 }
  private metroTimer: ReturnType<typeof setInterval> | null = null
  private metroNext = 0
  private metroBeat = 0
  private metroGain: GainNode | null = null
  duration = 0
  onEnded: (() => void) | null = null

  get isPlaying() {
    return this.playing
  }
  get sampleRate() {
    return this.ctx?.sampleRate ?? 44100
  }
  get buffers() {
    return this.stems.map((s) => ({ name: s.name, buffer: s.buffer }))
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext
      this.ctx = new Ctor({ latencyHint: "playback" })
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      this.stemBus = this.ctx.createGain()
      this.stemBus.connect(this.master)
      this.metroGain = this.ctx.createGain()
      this.metroGain.gain.value = 0.5
      this.metroGain.connect(this.master)
    }
    return this.ctx
  }

  /** Registers the SoundTouch worklet once; resolves false where AudioWorklet is missing or the module fails to load. */
  loadShifter(): Promise<boolean> {
    const ctx = this.ensureContext()
    this.shifterModule ??= (ctx.audioWorklet ? SoundTouchNode.register(ctx, processorUrl).then(() => true) : Promise.resolve(false))
      .catch(() => false)
      .then((ok) => {
        this.canShift = ok
        this.route()
        return ok
      })
    return this.shifterModule
  }

  /** Fetch + decode every stem. `onProgress` gets 0..1 across all downloads (decode counts for the last 10%). */
  async load(sources: StemSource[], onProgress: (p: number) => void = () => {}, signal?: AbortSignal) {
    const ctx = this.ensureContext()
    const loaded = new Array<number>(sources.length).fill(0)
    const totals = new Array<number>(sources.length).fill(0)
    const report = () => {
      const t = totals.reduce((a, b) => a + b, 0)
      onProgress(t > 0 ? (loaded.reduce((a, b) => a + b, 0) / t) * 0.9 : 0)
    }
    const raw = await Promise.all(
      sources.map((s, i) =>
        fetchWithProgress(s.url, signal, (l, t) => {
          loaded[i] = l
          totals[i] = t || Math.max(t, l)
          report()
        }),
      ),
    )
    let decoded = 0
    const buffers = await Promise.all(
      raw.map(async (ab) => {
        const b = await ctx.decodeAudioData(ab)
        onProgress(0.9 + (++decoded / sources.length) * 0.1)
        return b
      }),
    )
    this.stems.forEach((s) => s.gain.disconnect())
    this.stems = sources.map((s, i) => {
      const gain = ctx.createGain()
      gain.connect(this.stemBus!)
      return { name: s.name, buffer: buffers[i], gain, source: null }
    })
    this.duration = Math.max(...buffers.map((b) => b.duration))
    this.applyGains(true)
  }

  setMixer(m: MixerState) {
    this.mixer = m
    this.applyGains(false)
  }
  private applyGains(immediate: boolean) {
    const ctx = this.ctx
    if (!ctx) return
    for (const s of this.stems) {
      const g = effectiveGain(s.name, this.mixer)
      if (immediate) s.gain.gain.value = g
      else s.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.015)
    }
  }

  /** Must be called from a user gesture the first time (iOS). */
  async play() {
    const ctx = this.ensureContext()
    if (this.playing || this.stems.length === 0) return
    if (ctx.state !== "running") await ctx.resume()
    let pos = this.offset >= this.duration - 0.05 ? 0 : this.offset
    if (this.loop?.enabled && pos >= this.loop.b) pos = this.loop.a
    const origin = ctx.currentTime + 0.08
    this.playing = true
    this.startSources(pos, origin)
    this.startMetronome(origin)
  }

  pause() {
    if (!this.playing) return
    this.offset = this.position
    this.playing = false
    this.stopSources()
    this.stopMetronome()
  }

  toggle() {
    return this.playing ? this.pause() : this.play()
  }

  seek(t: number) {
    const pos = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.01))
    if (!this.playing) {
      this.offset = pos
      return
    }
    const ctx = this.ctx!
    this.startSources(pos, ctx.currentTime + 0.03)
  }

  /** Current song position in seconds as heard (derived from the audio clock, minus the shifter's delay). */
  get position(): number {
    if (!this.playing || !this.ctx) return this.offset
    const raw = this.offset + Math.max(0, this.ctx.currentTime - this.startedAt) * this.speed
    const heard = Math.max(this.floor, raw - (this.shifter ? SHIFTER_LATENCY * this.speed : 0))
    return Math.min(this.duration, loopedPosition(heard, this.activeLoop))
  }

  setLoop(loop: LoopRegion | null) {
    if (loop) {
      const { a, b } = clampLoop(loop.a, loop.b, this.duration)
      this.loop = { a, b, enabled: loop.enabled }
    } else this.loop = null
    if (!this.playing) {
      if (this.loop?.enabled && (this.offset < this.loop.a || this.offset >= this.loop.b)) this.offset = this.loop.a
      return
    }
    let pos = this.position
    if (this.loop?.enabled && pos >= this.loop.b) pos = this.loop.a
    this.startSources(pos, this.ctx!.currentTime + 0.03)
  }

  /** Playback speed (1 = original tempo); the pitch stays put once the shifter is loaded. */
  setSpeed(speed: number) {
    if (speed === this.speed) return
    const ctx = this.ctx
    const live = this.playing && !!ctx && ctx.currentTime >= this.startedAt
    const heard = this.position
    const hadShifter = !!this.shifter
    const raw = ctx ? this.offset + Math.max(0, ctx.currentTime - this.startedAt) * this.speed : this.offset
    this.speed = speed
    for (const s of this.stems) if (s.source) s.source.playbackRate.setValueAtTime(speed, ctx!.currentTime)
    this.route()
    if (!live) return
    // Re-anchor the clock instead of restarting the sources, so the change is seamless. While the shifter stays in
    // the path, keep the heard position continuous; when it is added or removed the audio itself jumps by its delay.
    this.offset = hadShifter && this.shifter ? heard + SHIFTER_LATENCY * speed : Math.min(this.duration, loopedPosition(raw, this.activeLoop))
    this.floor = 0
    this.startedAt = ctx.currentTime
  }

  /** Key change in semitones; needs the shifter (see loadShifter). */
  setPitch(semitones: number) {
    this.semitones = semitones
    this.route()
  }

  /** Put the shifter between the stem bus and the master only while speed or key differ from the original. */
  private route() {
    const ctx = this.ctx
    if (!ctx || !this.stemBus || !this.master) return
    const want = this.canShift && (this.speed !== 1 || this.semitones !== 0)
    if (want && !this.shifter) {
      this.shifter = new SoundTouchNode({ context: ctx })
      this.shifter.connect(this.master)
      this.stemBus.disconnect()
      this.stemBus.connect(this.shifter)
    } else if (!want && this.shifter) {
      this.stemBus.disconnect()
      this.stemBus.connect(this.master)
      this.shifter.disconnect()
      this.shifter = null
    }
    if (this.shifter) {
      this.shifter.playbackRate.value = this.speed
      this.shifter.pitchSemitones.value = this.semitones
    }
  }

  /** A new shifter, so audio buffered from before a seek or pause does not play first. */
  private resetShifter() {
    if (!this.shifter) return
    this.shifter.disconnect()
    this.shifter = null
    this.stemBus!.disconnect()
    this.stemBus!.connect(this.master!)
    this.route()
  }

  setMetronome(m: Metronome) {
    const wasOn = this.metro.enabled
    this.metro = m
    if (!this.playing || !this.ctx) return
    if (m.enabled && !wasOn) this.startMetronome(this.ctx.currentTime + 0.05)
    if (!m.enabled) this.stopMetronome()
  }

  private startSources(offset: number, when: number) {
    const ctx = this.ctx!
    this.stopSources()
    this.resetShifter()
    const gen = ++this.gen
    const looping = this.loop?.enabled && this.loop.b > this.loop.a && offset < this.loop.b
    this.activeLoop = looping ? { a: this.loop!.a, b: this.loop!.b } : null
    this.stems.forEach((s, i) => {
      const src = ctx.createBufferSource()
      src.buffer = s.buffer
      src.playbackRate.value = this.speed
      if (looping) {
        src.loop = true
        src.loopStart = this.loop!.a
        src.loopEnd = this.loop!.b
      }
      src.connect(s.gain)
      src.start(when, offset)
      if (i === 0) {
        src.onended = () => {
          if (gen === this.gen && this.playing) {
            this.playing = false
            this.offset = 0
            this.stopMetronome()
            this.onEnded?.()
          }
        }
      }
      s.source = src
    })
    this.startedAt = when
    this.offset = offset
    this.floor = offset
  }

  private stopSources() {
    this.gen++
    for (const s of this.stems) {
      if (s.source) {
        s.source.onended = null
        try {
          s.source.stop()
        } catch {
          /* already stopped */
        }
        s.source.disconnect()
        s.source = null
      }
    }
  }

  private startMetronome(origin: number) {
    this.stopMetronome()
    if (!this.metro.enabled || !this.ctx) return
    this.metroNext = origin
    this.metroBeat = 0
    const pump = () => {
      const ctx = this.ctx
      if (!ctx) return
      while (this.metroNext < ctx.currentTime + 0.15) {
        this.click(this.metroNext, this.metroBeat % 4 === 0)
        this.metroNext += 60 / this.metro.bpm
        this.metroBeat++
      }
    }
    pump()
    this.metroTimer = setInterval(pump, 25)
  }
  private stopMetronome() {
    if (this.metroTimer) clearInterval(this.metroTimer)
    this.metroTimer = null
  }
  private click(when: number, accent: boolean) {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = accent ? 1600 : 1000
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(1, when + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    osc.connect(env).connect(this.metroGain!)
    osc.start(when)
    osc.stop(when + 0.06)
  }

  dispose() {
    this.stopSources()
    this.stopMetronome()
    this.playing = false
    this.onEnded = null
    this.shifter = null
    void this.ctx?.close()
    this.ctx = null
    this.stems = []
  }
}

async function fetchWithProgress(url: string, signal: AbortSignal | undefined, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Failed to download audio (HTTP ${res.status})`)
  const total = Number(res.headers.get("content-length") ?? 0)
  if (!res.body) {
    const ab = await res.arrayBuffer()
    onProgress(ab.byteLength, ab.byteLength)
    return ab
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  onProgress(loaded, loaded)
  return out.buffer
}
