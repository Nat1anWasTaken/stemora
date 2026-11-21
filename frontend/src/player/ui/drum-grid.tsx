import { memo, useEffect, useMemo, useRef, useState } from "react"
import { LocateFixed } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buildBars, buildCells, buildDrumBeats, describeDrumBeat, DRUM_KINDS, DRUM_NAMES, lastAtOrBefore, splitChord, stepTimes, transposeChord, type Bar, type DrumBeat } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { cn } from "@/lib/utils"

const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7" }
const STEPS: Record<number, string> = { 3: "grid-cols-3", 4: "grid-cols-4" }
const CYMBALS = new Set(["cymbal", "hihat"])

type DrumBar = { bar: Bar; beats: DrumBeat[]; first: number }

/**
 * Drum chart: one card per bar, one tappable column per beat with a lane per drum (cymbal, hi-hat, tom, snare,
 * kick), following the playhead step by step. Tap a beat to seek there, tap a bar number to loop that bar.
 * Scrolling by hand pauses following.
 */
export function DrumGrid() {
  const analysis = usePlayer((s) => s.analysis)
  const duration = usePlayer((s) => s.duration)
  const playing = usePlayer((s) => s.playing)
  const loop = usePlayer((s) => s.loop)
  const cells = useMemo(() => (analysis ? buildCells(analysis) : []), [analysis])
  const bars = useMemo<DrumBar[]>(() => {
    if (!analysis) return []
    const beats = buildDrumBeats(analysis)
    let first = 0
    return buildBars(cells, duration).map((bar) => {
      const out = { bar, beats: beats.slice(first, first + bar.cells.length), first }
      first += bar.cells.length
      return out
    })
  }, [analysis, cells, duration])
  const times = useMemo(() => cells.map((c) => c.time), [cells])
  // 16ths at 180 BPM are ~83ms apart: refresh finer than the default 0.1s so the step highlight keeps up.
  const pos = usePosition(true, 0.02)
  const active = lastAtOrBefore(times, pos + 0.02)
  const activeBar = active >= 0 ? cells[active].bar : null
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = scroller.current
    const row = box?.querySelector<HTMLElement>(`[data-bar="${activeBar ?? bars[0]?.bar.bar}"]`)
    if (!follow || !box || !row) return
    box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 4), behavior: playing ? "smooth" : "auto" })
  }, [activeBar, bars, follow, playing])

  if (!analysis?.drums) {
    return (
      <section aria-label="Drum chart" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-3xl border border-border bg-surface/70 p-6 text-center text-sm text-muted-foreground">
          {analysis ? (
            <>
              <p className="font-medium text-foreground">No drums detected</p>
              <p>Songs processed before drum charts existed can be reprocessed from the menu to get one.</p>
            </>
          ) : (
            <p>No beat analysis for this song.</p>
          )}
        </div>
      </section>
    )
  }

  // Step within the active beat, as an index into that bar's beats/steps.
  let activeBeat = -1
  let activeStep = -1
  if (active >= 0) {
    const b = bars.find((x) => x.bar.bar === activeBar)
    if (b) {
      activeBeat = active - b.first
      activeStep = lastAtOrBefore(stepTimes(b.beats[activeBeat]), pos + 0.02)
    }
  }

  return (
    <section aria-label="Drum chart" data-stem="drums" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-none"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        <ol className="grid grid-cols-1 gap-x-3 gap-y-3 pb-20 md:grid-cols-2 xl:grid-cols-3">
          {bars.map((b) => {
            const looped = !!loop && Math.abs(loop.a - b.bar.start) < 0.05 && Math.abs(loop.b - b.bar.end) < 0.05
            const on = b.bar.bar === activeBar
            return <DrumBarCard key={b.bar.start} b={b} beatsPerBar={analysis.beatsPerBar} looped={looped} activeBeat={on ? activeBeat : -1} activeStep={on ? activeStep : -1} />
          })}
        </ol>
      </div>
      {!follow && (
        <Button variant="secondary" size="icon-lg" aria-label="Follow playback" className="absolute right-2 bottom-2" onClick={() => setFollow(true)}>
          <LocateFixed />
        </Button>
      )}
    </section>
  )
}

/** Memoised so only the bar under the playhead re-renders while playing. */
const DrumBarCard = memo(function DrumBarCard({ b, beatsPerBar, looped, activeBeat, activeStep }: { b: DrumBar; beatsPerBar: number; looped: boolean; activeBeat: number; activeStep: number }) {
  const { seek, setLoop, clearLoop } = usePlayer.getState()
  const semitones = usePlayer((s) => s.semitones)
  const raw = b.bar.cells[0]?.chord
  const chord = raw && raw !== "N" ? transposeChord(raw, semitones) : null
  const shown = chord ? splitChord(chord) : null
  const name = b.bar.bar === 0 ? "pickup" : `bar ${b.bar.bar}`

  return (
    <li data-bar={b.bar.bar} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-pressed={looped}
          aria-label={`${looped ? "Stop looping" : "Loop"} ${name}`}
          onClick={() => {
            if (looped) return clearLoop()
            setLoop(b.bar.start, b.bar.end)
            seek(b.bar.start)
          }}
          className={cn("pressable rounded-md px-1.5 text-sm tabular-nums", looped ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {b.bar.bar === 0 ? "Pickup" : b.bar.bar}
        </button>
        {shown && (
          <span className="truncate px-1.5 text-sm text-muted-foreground" aria-label={`Chord ${chord}`}>
            {shown.root}
            <sup className="text-xs">{shown.suffix}</sup>
          </span>
        )}
      </div>
      <div className={cn("flex gap-1 rounded-2xl", looped && "ring-2 ring-primary")}>
        <div aria-hidden className="flex shrink-0 flex-col justify-between gap-1 py-2 pr-0.5">
          {DRUM_KINDS.map((k) => (
            <span key={k} className="flex h-3.5 items-center justify-end text-xs leading-none text-muted-foreground">{DRUM_NAMES[k].short}</span>
          ))}
        </div>
        <div className={cn("grid min-w-0 flex-1 gap-0.5", COLS[beatsPerBar] ?? "grid-cols-4")}>
          {b.beats.map((beat, i) => {
            const on = i === activeBeat
            const cell = b.bar.cells[i]
            return (
              <button
                key={beat.time}
                type="button"
                aria-current={on}
                aria-label={`${name === "pickup" ? "Pickup" : `Bar ${b.bar.bar}`} beat ${cell?.beat ?? i + 1}${beat.grid === 3 ? " (triplet)" : ""}: ${describeDrumBeat(beat)}`}
                onClick={() => seek(beat.time)}
                className={cn(
                  "pressable grid min-w-0 px-0.5 py-2 first:rounded-l-2xl last:rounded-r-2xl",
                  STEPS[beat.grid],
                  cell?.beat === 1 && "border-l-4 border-l-border",
                  on ? "bg-secondary" : "bg-secondary/60 hover:bg-secondary",
                )}
              >
                {beat.hits.map((kinds, s) => (
                  <span key={s} aria-hidden className={cn("flex flex-col items-center justify-between gap-1 rounded-md", on && s === activeStep && "bg-foreground/15")}>
                    {DRUM_KINDS.map((k) => (
                      <span key={k} className="flex size-3.5 items-center justify-center">
                        {kinds.includes(k) ? (
                          <span className={cn("bg-stem", CYMBALS.has(k) ? "size-2.5 rotate-45 rounded-xs" : "size-3 rounded-full", on && s === activeStep && "scale-125")} />
                        ) : (
                          <span className="size-1 rounded-full bg-muted-foreground/25" />
                        )}
                      </span>
                    ))}
                  </span>
                ))}
              </button>
            )
          })}
        </div>
      </div>
    </li>
  )
})
