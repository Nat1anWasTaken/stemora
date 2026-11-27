import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Timer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import { clickSound, DEFAULT_CLICK_SOUND } from "@/player/click-sounds"
import { audioContext, runningAudioContext } from "@/player/engine"
import { clampOffset, EARLY_TAP, MAX_OFFSET_MS, measureDelay, MIN_OFFSET_MS, MIN_TAPS, reportedLatency, type DelayMeasurement } from "@/player/output-latency"
import { usePlayer } from "@/player/store"

/**
 * The test: CLICKS clicks at least MIN_INTERVAL s apart; the first WARMUP are for finding the beat and are not
 * measured. A tap is matched to a click it lags by less than the interval (less an allowance for early taps), so the
 * interval is widened when the delay the correction can cover would not fit.
 */
const CLICKS = 20
const WARMUP = 4
const MIN_INTERVAL = 0.75
const LEAD = 0.6
const clickInterval = (reported: number) => Math.max(MIN_INTERVAL, reported + MAX_OFFSET_MS / 1000 + EARLY_TAP + 0.05)

const ms = (s: number) => Math.round(s * 1000)
const signedMs = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)} ms`

type Run = { ctx: AudioContext; out: GainNode; nodes: AudioScheduledSourceNode[]; clicks: number[]; interval: number; taps: number[]; timer: ReturnType<typeof setTimeout> }
type Phase = { kind: "idle" } | { kind: "running"; taps: number } | { kind: "done"; result: DelayMeasurement | null; reported: number }

function stopRun(run: Run | null) {
  if (!run) return
  clearTimeout(run.timer)
  for (const n of run.nodes) {
    try {
      n.stop()
    } catch {
      /* not started */
    }
  }
  run.out.disconnect()
}

/**
 * Measures the output latency by ear: it plays a steady click and the user taps along. A tap lands when the click is
 * heard, so its lag behind the click's place on the audio clock is the delay the playhead has to allow for; what the
 * browser already reports is taken off to leave the correction. Touch and keyboard input lag are counted in too, which
 * suits the tempo editor, where markers are placed by tapping along to the music.
 */
function CalibrationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const run = useRef<Run | null>(null)
  /** Bumped on close and unmount, so a start still waiting for the context to resume gives up. */
  const attempt = useRef(0)
  const setOutputOffset = usePlayer((s) => s.setOutputOffset)

  useEffect(
    () => () => {
      attempt.current++
      stopRun(run.current)
    },
    [],
  )
  const changeOpen = (o: boolean) => {
    if (!o) {
      attempt.current++
      stopRun(run.current)
      run.current = null
      setPhase({ kind: "idle" })
    }
    onOpenChange(o)
  }

  const start = async () => {
    stopRun(run.current)
    usePlayer.getState().pause()
    const ctx = audioContext()
    const current = ++attempt.current
    if (ctx.state !== "running") await ctx.resume()
    if (current !== attempt.current) return
    const interval = clickInterval(reportedLatency(ctx))
    const out = ctx.createGain()
    out.gain.value = 0.6
    out.connect(ctx.destination)
    const sound = clickSound(DEFAULT_CLICK_SOUND)
    const first = ctx.currentTime + LEAD
    const clicks = Array.from({ length: CLICKS }, (_, i) => first + i * interval)
    const nodes = clicks.map((when, i) => sound.play(ctx, when, i % 4 === 0 ? "accent" : "normal", out))
    const end = clicks[CLICKS - 1] + interval - ctx.currentTime
    const timer = setTimeout(() => finish(), end * 1000)
    run.current = { ctx, out, nodes, clicks, interval, taps: [], timer }
    setPhase({ kind: "running", taps: 0 })
  }

  const finish = () => {
    const r = run.current
    if (!r) return
    const result = measureDelay(r.clicks.slice(WARMUP), r.taps, r.interval)
    const reported = reportedLatency(r.ctx)
    stopRun(r)
    run.current = null
    setPhase({ kind: "done", result, reported })
  }

  /** Records a tap at the audio clock time of the input event (not of this handler, which runs a little later). */
  const tap = (timeStamp: number) => {
    const r = run.current
    if (!r) return
    r.taps.push(r.ctx.currentTime - Math.max(0, performance.now() - timeStamp) / 1000)
    setPhase({ kind: "running", taps: r.taps.length })
  }
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    tap(e.timeStamp)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Enter") return
    e.preventDefault()
    if (!e.repeat) tap(e.timeStamp)
  }

  const correction = phase.kind === "done" && phase.result ? clampOffset(ms(phase.result.delay - phase.reported)) : null

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Calibrate audio sync</DialogTitle>
          <DialogDescription>
            Use the headphones or speakers you practise with. You'll hear {CLICKS} clicks: tap the button on each click you hear, keeping time with it rather than reacting to it.
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "running" ? (
          <div className="flex flex-col gap-3">
            <Button size="cell" className="w-full" autoFocus onPointerDown={onPointerDown} onKeyDown={onKeyDown} aria-label="Tap on each click">
              Tap
            </Button>
            <p className="text-center text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {phase.taps} {phase.taps === 1 ? "tap" : "taps"}
            </p>
          </div>
        ) : phase.kind === "done" ? (
          phase.result && correction !== null ? (
            <div className="flex flex-col gap-1 text-sm">
              <p>
                You heard the clicks <span className="font-semibold tabular-nums">{ms(phase.result.delay)} ms</span> after they were played (± {ms(phase.result.spread)} ms over {phase.result.taps} taps).
              </p>
              <p className="text-muted-foreground">
                The browser reports {ms(phase.reported)} ms, so the correction is <span className="font-medium text-foreground tabular-nums">{signedMs(correction)}</span>.
              </p>
              {phase.result.spread > 0.03 && <p className="text-muted-foreground">Your taps were uneven; another try may give a steadier result.</p>}
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              Not enough steady taps to measure (at least {MIN_TAPS} after the first {WARMUP} clicks). Try again, tapping along with every click.
            </p>
          )
        ) : null}
        <DialogFooter>
          {phase.kind === "running" ? (
            <Button variant="secondary" onClick={finish}>Stop</Button>
          ) : (
            <>
              <Button variant={correction !== null ? "secondary" : "default"} onClick={() => void start()}>{phase.kind === "done" ? "Try again" : "Start"}</Button>
              {correction !== null && (
                <Button
                  onClick={() => {
                    setOutputOffset(correction)
                    changeOpen(false)
                  }}
                >
                  Use {signedMs(correction)}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The browser's reported output latency in ms, followed while the page is open (it changes when the output does);
 * null until audio has played, as a context that is not running has nothing to report.
 */
function useDetectedLatency(): number | null {
  const read = () => {
    const ctx = runningAudioContext()
    return ctx ? ms(reportedLatency(ctx)) : null
  }
  const [value, setValue] = useState(read)
  useEffect(() => {
    const id = setInterval(() => setValue(read()), 1000)
    return () => clearInterval(id)
  }, [])
  return value
}

/**
 * The output latency correction (output-latency.ts): a slider to set it by eye against the playhead, and the tap test
 * to measure it. It belongs to this browser and output, so it sits with the other device settings.
 */
export function AudioSyncSettings() {
  const offset = usePlayer((s) => s.outputOffset)
  const setOutputOffset = usePlayer((s) => s.setOutputOffset)
  const [calibrating, setCalibrating] = useState(false)
  const detected = useDetectedLatency()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Detected latency</span>
          <span className="text-muted-foreground tabular-nums" aria-live="polite">{detected === null ? "Play a song to detect" : `${detected} ms`}</span>
        </div>
        <p className="text-xs text-muted-foreground">Reported by your browser for the current output and applied automatically.</p>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span id="audio-sync-label" className="font-medium">Extra correction</span>
          <span className="text-muted-foreground tabular-nums">{offset === 0 ? "None" : signedMs(offset)}</span>
        </div>
        <Slider aria-labelledby="audio-sync-label" min={MIN_OFFSET_MS} max={MAX_OFFSET_MS} step={5} value={offset} onValueChange={(v) => setOutputOffset(Array.isArray(v) ? v[0] : v)} />
        <p className="text-xs text-muted-foreground">
          Most devices need none. Some Bluetooth headphones play later than the browser reports: if the playhead still runs ahead of what you hear, calibrate or raise this; if it lags behind, lower it.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="lg" onClick={() => setCalibrating(true)}><Timer />Calibrate</Button>
        <Button variant="ghost" size="lg" disabled={offset === 0} onClick={() => setOutputOffset(0)}>Reset</Button>
      </div>
      <CalibrationDialog open={calibrating} onOpenChange={setCalibrating} />
    </div>
  )
}
