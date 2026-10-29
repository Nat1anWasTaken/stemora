/**
 * Framework-free multitrack engine on the Web Audio API.
 *
 * Sync strategy: all stems decode to AudioBuffers of the same sample rate (the context rate). Playback starts every
 * AudioBufferSourceNode with the same `when` (a shared ctx.currentTime) and the same `offset`, so they stay sample
 * accurate. Seeking/restarting stops and recreates all sources together. A-B looping uses the sources' own
 * loopStart/loopEnd (sample-accurate wrap, no timers); position is derived from the audio clock.
 *
 * Tempo and key: at the original speed and key the stems play straight from their AudioBuffers as above. Otherwise they
 * play through one Signalsmith Stretch AudioWorklet that reads its own copy of the PCM (every stem as a pair of its
 * channels, so they share one time map and stay in sync) and changes speed and key in a single pass, without first
 * resampling through playbackRate. Its output is split back into the per-stem gains, so the mixer stays live. The node
 * and its copy are only built the first time the speed or key leaves the original. Where it cannot run, playbackRate
 * changes the speed and the pitch moves with it. The metronome never goes through it.
 */
import type { StretchNode } from "signalsmith-stretch"
import type { StemName } from "@/lib/api"
import { defaultMixer, effectiveGain, loopedPosition, clampLoop, type LoopRegion, type MixerState } from "@/player/mixer"

export type StemSource = { name: StemName; url: string }
export type Metronome = { enabled: boolean; bpm: number }

type StemNode = { name: StemName; buffer: AudioBuffer; gain: GainNode; source: AudioBufferSourceNode | null }

type AudioContextCtor = typeof AudioContext

export class StemEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private stretch: StretchNode | null = null
  private stretchBuild: Promise<void> | null = null
  private stretchLatency = 0
  private stretching = false // the stretch node, not the buffer sources, is the path playing
  private shifterModule: Promise<boolean> | null = null
  private canShift = false
  private speed = 1
  private semitones = 0
  private stems: StemNode[] = []
  private mixer: MixerState = defaultMixer()
  private loop: LoopRegion | null = null
  private activeLoop: { a: number; b: number } | null = null
  private playing = false
  private startedAt = 0 // ctx time at which `offset` was (or will be) heard
  private offset = 0 // song position at startedAt (the song then advances `speed` seconds per second)
  private endClock: ConstantSourceNode | null = null
  private metro: Metronome = { enabled: false, bpm: 100 }
  private metroTimer: ReturnType<typeof setInterval> | null = null
  private metroNext = 0
  private metroBeat = 0
  private metroGain: GainNode | null = null
  duration = 0
  onEnded: (() => void) | null = null
  /** Called if the stretcher fails to start after loadShifter reported it available. */
  onShiftUnavailable: (() => void) | null = null

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
      this.metroGain = this.ctx.createGain()
      this.metroGain.gain.value = 0.5
      this.metroGain.connect(this.master)
    }
    return this.ctx
  }

  /** Fetches the stretcher's code once; resolves false where AudioWorklet or WebAssembly is missing or it fails to load. */
  loadShifter(): Promise<boolean> {
    const ctx = this.ensureContext()
    this.shifterModule ??= (ctx.audioWorklet && typeof WebAssembly === "object" ? import("signalsmith-stretch").then(() => true) : Promise.resolve(false))
      .catch(() => false)
      .then((ok) => {
        this.canShift = ok
        this.update()
        return ok
      })
    return this.shifterModule
  }

  /** Builds the stretch node and hands it a copy of every stem, the first time the speed or key needs it. */
  private ensureStretch() {
    const ctx = this.ctx
    if (this.stretchBuild || !ctx || !this.canShift || !this.wantsStretch || this.stems.length === 0) return
    const stems = this.stems
    this.stretchBuild = (async () => {
      const { default: SignalsmithStretch } = await import("signalsmith-stretch")
      const channels = stems.length * 2
      // The node never answers if its WASM fails to start inside the worklet.
      const node = await withTimeout(SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels] }), 15000)
      this.stretchLatency = await node.latency()
      const length = Math.max(...stems.map((s) => s.buffer.length))
      const pcm = stems.flatMap((s) =>
        [0, 1].map((c) => {
          const data = new Float32Array(length)
          s.buffer.copyFromChannel(data, Math.min(c, s.buffer.numberOfChannels - 1))
          return data
        }),
      )
      await node.addBuffers(pcm, pcm.map((d) => d.buffer))
      if (this.ctx !== ctx) return
      const split = ctx.createChannelSplitter(channels)
      node.connect(split)
      stems.forEach((s, i) => {
        const merge = ctx.createChannelMerger(2)
        split.connect(merge, 2 * i, 0)
        split.connect(merge, 2 * i + 1, 1)
        merge.connect(s.gain)
      })
      this.stretch = node
      this.update()
    })().catch(() => {
      this.canShift = false
      this.onShiftUnavailable?.()
    })
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
      gain.connect(this.master!)
      return { name: s.name, buffer: buffers[i], gain, source: null }
    })
    this.duration = Math.max(...buffers.map((b) => b.duration))
    this.applyGains(true)
    this.ensureStretch()
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
    this.playing = true
    const origin = this.startSources(pos, ctx.currentTime + 0.08)
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

  /** Current song position in seconds as heard (derived from the audio clock). */
  get position(): number {
    if (!this.playing || !this.ctx) return this.offset
    return this.positionAt(this.ctx.currentTime)
  }

  private positionAt(t: number, speed = this.speed): number {
    const raw = this.offset + Math.max(0, t - this.startedAt) * speed
    return Math.min(this.duration, loopedPosition(raw, this.activeLoop))
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

  /** Playback speed (1 = original tempo); the pitch stays put once the stretcher is available. */
  setSpeed(speed: number) {
    if (speed === this.speed) return
    const previous = this.speed
    this.speed = speed
    this.update(previous)
  }

  /** Key change in semitones; needs the stretcher (see loadShifter). */
  setPitch(semitones: number) {
    if (semitones === this.semitones) return
    this.semitones = semitones
    this.update()
  }

  private get wantsStretch() {
    return this.speed !== 1 || this.semitones !== 0
  }
  private get useStretch() {
    return !!this.stretch && this.wantsStretch
  }

  /** Applies a new speed or key: retimes the playing path in place, or restarts on the other one when that changes. */
  private update(previousSpeed = this.speed) {
    this.ensureStretch()
    const ctx = this.ctx
    if (!this.playing || !ctx) return
    const when = Math.max(ctx.currentTime, this.startedAt)
    const pos = this.positionAt(when, previousSpeed)
    if (this.useStretch !== this.stretching) {
      this.startSources(pos, ctx.currentTime + 0.03)
      return
    }
    this.offset = pos
    this.startedAt = when
    if (this.stretching) this.scheduleStretch()
    else for (const s of this.stems) s.source?.playbackRate.setValueAtTime(this.speed, when)
    this.armEnd()
  }

  /** Points the stretcher at `offset` from `startedAt` on, with the current speed, key and loop. */
  private scheduleStretch() {
    const loop = this.activeLoop
    void this.stretch!.schedule({ active: true, output: this.startedAt, input: this.offset, rate: this.speed, semitones: this.semitones, loopStart: loop?.a ?? 0, loopEnd: loop?.b ?? 0 })
  }

  setMetronome(m: Metronome) {
    const wasOn = this.metro.enabled
    this.metro = m
    if (!this.playing || !this.ctx) return
    if (m.enabled && !wasOn) this.startMetronome(this.ctx.currentTime + 0.05)
    if (!m.enabled) this.stopMetronome()
  }

  /** Starts playing from `offset`, heard from `when` or later if the stretcher needs time; returns when it is heard. */
  private startSources(offset: number, when: number): number {
    const ctx = this.ctx!
    const wasStretching = this.stretching
    this.stopSources()
    this.stretching = this.useStretch
    // The stretcher takes its latency to fill before the first sample and leaves that long a tail when it stops.
    if (this.stretching || wasStretching) when = Math.max(when, ctx.currentTime + this.stretchLatency)
    const looping = this.loop?.enabled && this.loop.b > this.loop.a && offset < this.loop.b
    this.activeLoop = looping ? { a: this.loop!.a, b: this.loop!.b } : null
    this.startedAt = when
    this.offset = offset
    if (this.stretching) this.scheduleStretch()
    else {
      for (const s of this.stems) {
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
        s.source = src
      }
    }
    this.armEnd()
    return when
  }

  private stopSources() {
    this.disarmEnd()
    for (const s of this.stems) {
      if (s.source) {
        try {
          s.source.stop()
        } catch {
          /* already stopped */
        }
        s.source.disconnect()
        s.source = null
      }
    }
    if (this.stretching) void this.stretch?.stop()
    this.stretching = false
  }

  /**
   * Marks the end of the song on the audio clock with a silent source, so `ended` fires on time on either path (the
   * stretcher just plays silence past the end) and in a throttled background tab. A loop never ends.
   */
  private armEnd() {
    this.disarmEnd()
    const ctx = this.ctx
    if (!ctx || !this.playing || this.activeLoop) return
    const clock = ctx.createConstantSource()
    clock.offset.value = 0
    clock.connect(this.master!)
    clock.onended = () => {
      if (clock !== this.endClock || !this.playing) return
      this.playing = false
      this.offset = 0
      this.stopSources()
      this.stopMetronome()
      this.onEnded?.()
    }
    clock.start()
    clock.stop(this.startedAt + Math.max(0, this.duration - this.offset) / this.speed)
    this.endClock = clock
  }
  private disarmEnd() {
    if (!this.endClock) return
    this.endClock.onended = null
    this.endClock.disconnect()
    this.endClock = null
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
    this.onShiftUnavailable = null
    this.stretch = null
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms))])
}
