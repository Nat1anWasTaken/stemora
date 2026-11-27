import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Timer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import { clickSound, DEFAULT_CLICK_SOUND } from "@/player/click-sounds"
import { audioContext } from "@/player/engine"
import { clampOffset, MAX_OFFSET_MS, measureDelay, MIN_OFFSET_MS, MIN_TAPS, reportedLatency, type DelayMeasurement } from "@/player/output-latency"
import { usePlayer } from "@/player/store"

/** The test: CLICKS clicks INTERVAL s apart; the first WARMUP are for finding the beat and are not measured. */
const CLICKS = 20
const WARMUP = 4
const INTERVAL = 0.75
const LEAD = 0.6

const ms = (s: number) => Math.round(s * 1000)
const signedMs = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)} ms`

type Run = { ctx: AudioContext; out: GainNode; nodes: AudioScheduledSourceNode[]; clicks: number[]; taps: number[]; timer: ReturnType<typeof setTimeout> }
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
  const setOutputOffset = usePlayer((s) => s.setOutputOffset)

  useEffect(() => () => stopRun(run.current), [])
  const changeOpen = (o: boolean) => {
    if (!o) {
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
    if (ctx.state !== "running") await ctx.resume()
    const out = ctx.createGain()
    out.gain.value = 0.6
    out.connect(ctx.destination)
    const sound = clickSound(DEFAULT_CLICK_SOUND)
    const first = ctx.currentTime + LEAD
    const clicks = Array.from({ length: CLICKS }, (_, i) => first + i * INTERVAL)
    const nodes = clicks.map((when, i) => sound.play(ctx, when, i % 4 === 0 ? "accent" : "normal", out))
    const end = clicks[CLICKS - 1] + INTERVAL - ctx.currentTime
    const timer = setTimeout(() => finish(), end * 1000)
    run.current = { ctx, out, nodes, clicks, taps: [], timer }
    setPhase({ kind: "running", taps: 0 })
  }

  const finish = () => {
    const r = run.current
    if (!r) return
    const result = measureDelay(r.clicks.slice(WARMUP), r.taps, INTERVAL)
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
 * The output latency correction (output-latency.ts): a slider to set it by eye against the playhead, and the tap test
 * to measure it. It belongs to this browser and output, so it sits with the other device settings.
 */
export function AudioSyncSettings() {
  const offset = usePlayer((s) => s.outputOffset)
  const setOutputOffset = usePlayer((s) => s.setOutputOffset)
  const [calibrating, setCalibrating] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span id="audio-sync-label" className="font-medium">Correction</span>
          <span className="text-muted-foreground tabular-nums">{offset === 0 ? "None" : signedMs(offset)}</span>
        </div>
        <Slider aria-labelledby="audio-sync-label" min={MIN_OFFSET_MS} max={MAX_OFFSET_MS} step={5} value={offset} onValueChange={(v) => setOutputOffset(Array.isArray(v) ? v[0] : v)} />
        <p className="text-xs text-muted-foreground">Raise it if the playhead runs ahead of what you hear, lower it if it lags behind.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="lg" onClick={() => setCalibrating(true)}><Timer />Calibrate</Button>
        <Button variant="ghost" size="lg" disabled={offset === 0} onClick={() => setOutputOffset(0)}>Reset</Button>
      </div>
      <CalibrationDialog open={calibrating} onOpenChange={setCalibrating} />
    </div>
  )
}
