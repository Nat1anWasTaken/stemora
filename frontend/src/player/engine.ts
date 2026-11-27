/**
 * Framework-free multitrack engine on the Web Audio API.
 *
 * Sync strategy: all stems decode to AudioBuffers of the same sample rate (the context rate). Playback starts every
 * AudioBufferSourceNode with the same `when` (a shared ctx.currentTime) and the same `offset`, so they stay sample
 * accurate. Seeking/restarting stops and recreates all sources together. A-B looping uses the sources' own
 * loopStart/loopEnd (sample-accurate wrap, no timers); position is derived from the audio clock.
 *
 * Tempo and key: at the original speed and key the stems play straight from their AudioBuffers as above. Otherwise they
 * play through Signalsmith Stretch AudioWorklets, one per stem, each reading its own copy of that stem's PCM and
 * changing speed and key in a single pass, without first resampling through playbackRate. A stem can keep its original
 * key while the others are transposed (drums, by default), so each node has its own key. They stay in sync because
 * every node is given the same schedule and a node derives its read position from the audio clock through that
 * schedule, not from when the message reached it. Each node feeds its stem's gain, so the mixer stays live. The nodes
 * and their copies are only built the first time the speed or key leaves the original. Where they cannot run, playbackRate
 * changes the speed and the pitch moves with it. The metronome never goes through it: it clicks on the song's beat
 * grid (`setClicks`), mapped onto the audio clock through the same offset, speed and loop as the stems.
 *
 * Output latency (see output-latency.ts): everything is scheduled on the audio clock, and the output (Bluetooth most of
 * all) delays all of it alike, so stems and clicks stay together. Only what the engine reports as heard (`position`)
 * takes the delay off the clock, so the playhead and charts match the sound; restarts keep using the clock position
 * so they continue the sound without a jump.
 */
import type { StretchNode } from "signalsmith-stretch"
import type { StemName } from "@/lib/api"
import { stemSemitones } from "@/player/transpose"
import { clickSound, DEFAULT_CLICK_SOUND, type ClickSound } from "@/player/click-sounds"
import { clicksBetween, type Click, type ClickVolume } from "@/player/clicks"
import { defaultMixer, effectiveGain, loopedPosition, clampLoop, type LoopRegion, type MixerState } from "@/player/mixer"
import { heardDelay, reportedLatency } from "@/player/output-latency"

export type StemSource = { name: StemName; url: string }

/** How far ahead clicks are put on the audio clock, and how often the scheduler looks. */
const CLICK_AHEAD = 0.15
const CLICK_EVERY = 25
/**
 * Lookahead while the page is hidden. Desktop browsers keep page timers running in background tabs but may slow them
 * to about once a second, so this covers a throttled tick with room to spare. Runtimes that freeze timers instead
 * (Safari on iOS) are caught by the stall check in pumpClicks.
 */
const CLICK_AHEAD_HIDDEN = 1.5

type StemNode = { name: StemName; buffer: AudioBuffer; gain: GainNode; source: AudioBufferSourceNode | null }

type AudioContextCtor = typeof AudioContext

/**
 * One AudioContext for every engine. A new song gets a new engine, and on iOS a context only starts inside a tap, so
 * a context per song could not start the next song by itself (Up Next). An engine disconnects its nodes when disposed.
 */
let sharedContext: AudioContext | null = null
export function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    const Ctor: AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext
    sharedContext = new Ctor({ latencyHint: "playback" })
  }
  return sharedContext
}
/** The shared context if one is running, without creating one (outside a tap it would only start suspended). */
export const runningAudioContext = () => (sharedContext?.state === "running" ? sharedContext : null)

/** A click of a count-in: seconds before the song starts, and how loud. */
export type CountInClick = { before: number; level: ClickVolume }

export class StemEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** One stretch node per stem, in the order of `stems` (empty until built). */
  private stretches: StretchNode[] = []
  private stretchBuild: Promise<void> | null = null
  private stretchLatency = 0
  private stretching = false // the stretch node, not the buffer sources, is the path playing
  private shifterModule: Promise<boolean> | null = null
  private canShift = false
  private speed = 1
  private semitones = 0
  /** Stems that follow `semitones`; the rest keep their original key. */
  private transposed: readonly StemName[] = []
  private stems: StemNode[] = []
  private mixer: MixerState = defaultMixer()
  private loop: LoopRegion | null = null
  private activeLoop: { a: number; b: number } | null = null
  private playing = false
  private startedAt = 0 // ctx time at which `offset` was (or will be) heard
  private offset = 0 // song position at startedAt (the song then advances `speed` seconds per second)
  /**
   * The timings a speed change replaced in place, oldest first, kept while their sound may still be on its way out, so
   * `position` follows what is heard across the change instead of standing still for the output latency.
   */
  private retimed: { offset: number; startedAt: number; speed: number }[] = []
  private endClock: ConstantSourceNode | null = null
  private metroOn = false
  private clicks: Click[] = []
  private clickTimes: number[] = []
  private metroTimer: ReturnType<typeof setInterval> | null = null
  /** Context time up to which clicks are scheduled, and the clicks still to sound (so a seek can silence them). */
  private metroUntil = 0
  private scheduled: { osc: AudioScheduledSourceNode; when: number }[] = []
  private countIn: AudioScheduledSourceNode[] = []
  private sound: ClickSound = clickSound(DEFAULT_CLICK_SOUND)
  /** The user's correction to the browser's output latency, in milliseconds. */
  private outputOffset = 0
  private soundReady: Promise<void> | null = null
  private soundDone: () => boolean = () => false
  private metroGain: GainNode | null = null
  /**
   * Set when a hidden page's timers fell behind the clicks already planned. Some runtimes (Safari on iOS) keep the
   * audio clock running in the background (see keepAlive) but freeze or heavily throttle page timers, which would make
   * the clicks stutter; there the metronome stays silent until the page is visible again. Desktop browsers keep up, so
   * it keeps clicking. Decided from how the timers actually behave rather than from the user agent.
   */
  private timersStalled = false
  private onVisibility = () => {
    this.timersStalled = false
    this.rescheduleClicks()
  }
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
      this.ctx = audioContext()
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      this.metroGain = this.ctx.createGain()
      this.metroGain.gain.value = 0.5
      this.metroGain.connect(this.master)
      document.addEventListener("visibilitychange", this.onVisibility)
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

  /** Builds a stretch node per stem and hands each a copy of its stem, the first time the speed or key needs them. */
  private ensureStretch() {
    const ctx = this.ctx
    if (this.stretchBuild || !ctx || !this.canShift || !this.wantsStretch || this.stems.length === 0) return
    const stems = this.stems
    this.stretchBuild = (async () => {
      const { default: SignalsmithStretch } = await import("signalsmith-stretch")
      // Every stem is padded to the longest, so the nodes share one timeline.
      const length = Math.max(...stems.map((s) => s.buffer.length))
      const nodes = await Promise.all(
        stems.map(async (s) => {
          // A node never answers if its WASM fails to start inside the worklet.
          const node = await withTimeout(SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }), 15000)
          const pcm = [0, 1].map((c) => {
            const data = new Float32Array(length)
            s.buffer.copyFromChannel(data, Math.min(c, s.buffer.numberOfChannels - 1))
            return data
          })
          await node.addBuffers(pcm, pcm.map((d) => d.buffer))
          return node
        }),
      )
      // The nodes are configured alike, so their latencies match; the largest covers any rounding.
      this.stretchLatency = Math.max(...(await Promise.all(nodes.map((n) => n.latency()))))
      if (this.ctx !== ctx) return
      nodes.forEach((n, i) => n.connect(stems[i].gain))
      this.stretches = nodes
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

  /**
   * Must be called from a user gesture the first time (iOS). `countIn` clicks are played first (the metronome's sound,
   * whether or not the metronome is on), and the song starts after the earliest of them.
   */
  async play(countIn: CountInClick[] = []) {
    const ctx = this.ensureContext()
    if (this.playing || this.stems.length === 0) return
    if (ctx.state !== "running") await ctx.resume()
    let pos = this.offset >= this.duration - 0.05 ? 0 : this.offset
    if (this.loop?.enabled && pos >= this.loop.b) pos = this.loop.a
    this.playing = true
    const lead = Math.max(0, ...countIn.map((c) => c.before))
    const start = ctx.currentTime + 0.08 + lead
    if (countIn.length > 0 && this.soundLoaded()) {
      for (const c of countIn) this.countIn.push(this.sound.play(ctx, start - c.before, c.level, this.metroGain!))
    }
    this.startSources(pos, start)
  }

  private silenceCountIn() {
    for (const osc of this.countIn) {
      try {
        osc.stop()
      } catch {
        /* not started */
      }
    }
    this.countIn = []
  }

  pause() {
    this.silenceCountIn()
    if (!this.playing) return
    // Pausing stops at what is heard, so play resumes there (replaying what was still on its way to the speakers).
    this.offset = this.position
    this.playing = false
    this.stopSources()
    this.stopMetronome()
  }

  toggle() {
    return this.playing ? this.pause() : this.play()
  }

  seek(t: number) {
    this.silenceCountIn()
    const pos = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.01))
    if (!this.playing) {
      this.offset = pos
      return
    }
    const ctx = this.ctx!
    this.startSources(pos, ctx.currentTime + 0.03)
  }

  /** Current song position in seconds as heard: the audio clock less the output latency. */
  get position(): number {
    if (!this.playing || !this.ctx) return this.offset
    const t = this.ctx.currentTime - this.outputDelay
    if (t < this.startedAt) {
      const r = this.retimed.findLast((r) => r.startedAt <= t)
      if (r) return Math.min(this.duration, loopedPosition(r.offset + (t - r.startedAt) * r.speed, this.activeLoop))
    }
    return this.positionAt(t)
  }
  /** Song position the audio clock is at, ahead of what is heard by the output latency; for continuing the sound. */
  private get clockPosition(): number {
    if (!this.playing || !this.ctx) return this.offset
    return this.positionAt(this.ctx.currentTime)
  }

  /** Seconds between the audio clock and the sound being heard (the browser's figure plus `setOutputOffset`). */
  get outputDelay(): number {
    return this.ctx ? heardDelay(this.ctx, this.outputOffset) : 0
  }
  /** The browser's own figure for the output latency, in seconds. */
  get reportedLatency(): number {
    return this.ctx ? reportedLatency(this.ctx) : 0
  }
  /** The user's correction to the browser's output latency, in milliseconds (see output-latency.ts). */
  setOutputOffset(ms: number) {
    this.outputOffset = ms
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
    let pos = this.clockPosition
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

  /** Key change in semitones for the stems in `stems` (the others keep their key); needs the stretcher (see loadShifter). */
  setPitch(semitones: number, stems: readonly StemName[]) {
    if (semitones === this.semitones && stems.length === this.transposed.length && stems.every((n) => this.transposed.includes(n))) return
    this.semitones = semitones
    this.transposed = [...stems]
    this.update()
  }

  private get wantsStretch() {
    return this.speed !== 1 || (this.semitones !== 0 && this.transposed.length > 0)
  }
  private get useStretch() {
    return this.stretches.length > 0 && this.wantsStretch
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
    // Timings older than any output could still be playing are dropped.
    this.retimed = this.retimed.filter((r) => r.startedAt > ctx.currentTime - 2)
    this.retimed.push({ offset: this.offset, startedAt: this.startedAt, speed: previousSpeed })
    this.offset = pos
    this.startedAt = when
    if (this.stretching) this.scheduleStretch()
    else for (const s of this.stems) s.source?.playbackRate.setValueAtTime(this.speed, when)
    this.armEnd()
    this.rescheduleClicks()
  }

  /** Points every stretcher at `offset` from `startedAt` on, with the current speed and loop and its stem's key. */
  private scheduleStretch() {
    const loop = this.activeLoop
    this.stretches.forEach((node, i) => {
      const semitones = stemSemitones(this.stems[i].name, this.semitones, this.transposed)
      void node.schedule({ active: true, output: this.startedAt, input: this.offset, rate: this.speed, semitones, loopStart: loop?.a ?? 0, loopEnd: loop?.b ?? 0 })
    })
  }

  setMetronome(enabled: boolean) {
    if (enabled === this.metroOn) return
    this.metroOn = enabled
    if (!this.playing || !this.ctx) return
    if (enabled) this.startMetronome()
    else this.stopMetronome()
  }

  /** The metronome sound (an id from CLICK_SOUNDS); clicks already scheduled are played again with it. */
  setClickSound(id: string) {
    const sound = clickSound(id)
    if (sound === this.sound) return
    this.sound = sound
    this.soundReady = sound.load ? null : Promise.resolve()
    this.rescheduleClicks()
  }
  /**
   * Whether the sound can play now. A sound with files starts decoding them the first time it is needed (the context
   * exists by then); its clicks are scheduled once they are in, and one that fails falls back to the default sound.
   */
  private soundLoaded(): boolean {
    const sound = this.sound
    if (!sound.load) return true
    if (!this.soundReady && this.ctx) {
      let done = false
      this.soundReady = sound.load(this.ctx).then(
        () => {
          done = true
          if (this.sound === sound) this.rescheduleClicks()
        },
        () => {
          if (this.sound === sound) this.setClickSound(DEFAULT_CLICK_SOUND)
        },
      )
      this.soundDone = () => done
    }
    return this.soundDone()
  }

  /** The beats to click on (song seconds, sorted); takes effect at once, also mid-playback. */
  setClicks(clicks: Click[]) {
    this.clicks = clicks
    this.clickTimes = clicks.map((c) => c.time)
    this.rescheduleClicks()
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
    // A restart (seek, loop, path change) shows its new position at once rather than the old sound still playing out.
    this.retimed = []
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
    this.rescheduleClicks()
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
    if (this.stretching) for (const n of this.stretches) void n.stop()
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

  private startMetronome() {
    this.stopMetronome()
    if (!this.metroOn || !this.ctx || !this.playing) return
    this.metroUntil = Math.max(this.ctx.currentTime, this.startedAt)
    this.pumpClicks()
    this.metroTimer = setInterval(() => this.pumpClicks(), CLICK_EVERY)
  }
  /** Puts the clicks heard between `metroUntil` and a little ahead of now on the audio clock. */
  private pumpClicks() {
    const ctx = this.ctx
    if (!ctx || !this.playing || !this.metroOn || !this.soundLoaded()) return
    if (document.hidden) {
      if (this.timersStalled) return
      // The planned clicks ran out before this tick came: timers can't keep up in the background here.
      if (ctx.currentTime > this.metroUntil) {
        this.timersStalled = true
        return
      }
    }
    const until = ctx.currentTime + (document.hidden ? CLICK_AHEAD_HIDDEN : CLICK_AHEAD)
    if (until <= this.metroUntil) return
    const from = Math.max(this.metroUntil, this.startedAt)
    const raw = (t: number) => this.offset + (t - this.startedAt) * this.speed
    const due = clicksBetween(this.clicks, this.clickTimes, raw(from), raw(until), { offset: this.offset, startedAt: this.startedAt, speed: this.speed, loop: this.activeLoop })
    this.metroUntil = until
    this.scheduled = this.scheduled.filter((s) => s.when > ctx.currentTime - 0.1)
    for (const c of due) this.click(c.when, c.level)
  }
  /** Silences clicks already scheduled past now and schedules again from the current timing. */
  private rescheduleClicks() {
    const ctx = this.ctx
    if (!ctx) return
    for (const s of this.scheduled) {
      if (s.when <= ctx.currentTime) continue
      try {
        s.osc.stop()
      } catch {
        /* not started */
      }
    }
    this.scheduled = []
    if (!this.playing || !this.metroOn) return
    if (!this.metroTimer) return this.startMetronome()
    this.metroUntil = Math.max(ctx.currentTime, this.startedAt)
    this.pumpClicks()
  }
  private stopMetronome() {
    if (this.metroTimer) clearInterval(this.metroTimer)
    this.metroTimer = null
    const ctx = this.ctx
    for (const s of this.scheduled) {
      if (ctx && s.when <= ctx.currentTime) continue
      try {
        s.osc.stop()
      } catch {
        /* not started */
      }
    }
    this.scheduled = []
  }
  private click(when: number, level: ClickVolume) {
    const osc = this.sound.play(this.ctx!, when, level, this.metroGain!)
    this.scheduled.push({ osc, when })
  }

  dispose() {
    document.removeEventListener("visibilitychange", this.onVisibility)
    this.stopSources()
    this.stopMetronome()
    this.silenceCountIn()
    this.playing = false
    this.onEnded = null
    this.onShiftUnavailable = null
    // The context is shared with the next song's engine: disconnect this one's nodes instead of closing it.
    for (const n of this.stretches) n.disconnect()
    this.stretches = []
    for (const st of this.stems) st.gain.disconnect()
    this.metroGain?.disconnect()
    this.master?.disconnect()
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
