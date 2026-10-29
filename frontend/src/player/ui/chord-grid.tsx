import { useEffect, useMemo, useRef, useState } from "react"
import { LocateFixed, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buildBars, buildCells, lastAtOrBefore, splitChord, transposeChord } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { cn } from "@/lib/utils"

const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7" }

/**
 * Expanded chord chart: one row per bar, one cell per beat, following the playhead.
 * Tap a beat to seek there, tap a bar number to loop that bar. Scrolling by hand pauses following.
 */
export function ChordGrid({ onCollapse }: { onCollapse?: () => void }) {
  const analysis = usePlayer((s) => s.analysis)
  const duration = usePlayer((s) => s.duration)
  const playing = usePlayer((s) => s.playing)
  const loop = usePlayer((s) => s.loop)
  const semitones = usePlayer((s) => s.semitones)
  const { seek, setLoop, clearLoop } = usePlayer.getState()
  const cells = useMemo(() => (analysis ? buildCells(analysis) : []), [analysis])
  const bars = useMemo(() => buildBars(cells, duration), [cells, duration])
  const times = useMemo(() => cells.map((c) => c.time), [cells])
  const pos = usePosition()
  const active = lastAtOrBefore(times, pos + 0.02)
  const activeBar = active >= 0 ? cells[active].bar : null
  const activeTime = active >= 0 ? cells[active].time : null
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = scroller.current
    const row = box?.querySelector<HTMLElement>(`[data-bar="${activeBar ?? bars[0]?.bar}"]`)
    if (!follow || !box || !row) return
    box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 4), behavior: playing ? "smooth" : "auto" })
  }, [activeBar, bars, follow, playing])

  const header = onCollapse && (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Chords</span>
        {analysis?.bpm ? ` · ${Math.round(analysis.bpm)} BPM` : ""}
        {analysis ? ` · ${analysis.beatsPerBar}/4` : ""}
      </p>
      <Button variant="ghost" size="sm" onClick={onCollapse}><Minimize2 />Collapse</Button>
    </div>
  )

  if (!analysis) {
    return (
      <section aria-label="Chord chart" className="flex min-h-0 flex-1 flex-col gap-3">
        {header}
        <div className="flex flex-1 items-center justify-center rounded-3xl border border-border bg-surface/70 p-6 text-center text-sm text-muted-foreground">
          No beat or chord analysis for this song.
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Chord chart" className="relative flex min-h-0 flex-1 flex-col gap-3">
      {header}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-none"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        <ol className="grid grid-cols-1 gap-x-3 gap-y-2 pb-20 md:grid-cols-2 xl:grid-cols-4">
          {bars.map((b) => {
            const looped = !!loop && Math.abs(loop.a - b.start) < 0.05 && Math.abs(loop.b - b.end) < 0.05
            return (
              <li key={b.start} data-bar={b.bar} className="flex flex-col gap-1">
                <button
                  type="button"
                  aria-pressed={looped}
                  aria-label={`${looped ? "Stop looping" : "Loop"} ${b.bar === 0 ? "pickup" : `bar ${b.bar}`}`}
                  onClick={() => {
                    if (looped) return clearLoop()
                    setLoop(b.start, b.end)
                    seek(b.start)
                  }}
                  className={cn("pressable self-start rounded-md px-1.5 text-sm tabular-nums", looped ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {b.bar === 0 ? "Pickup" : b.bar}
                </button>
                <div className={cn("grid gap-0.5 rounded-2xl", COLS[analysis.beatsPerBar] ?? "grid-cols-4", looped && "ring-2 ring-primary")}>
                  {b.cells.map((c) => {
                    const on = c.time === activeTime
                    const chord = c.chord && c.chord !== "N" ? splitChord(transposeChord(c.chord, semitones)) : null
                    return (
                      <button
                        key={c.time}
                        type="button"
                        aria-current={on}
                        aria-label={`Bar ${c.bar} beat ${c.beat}${c.chord ? `, ${c.chord === "N" ? "no chord" : transposeChord(c.chord, semitones)}` : ""}`}
                        onClick={() => seek(c.time)}
                        className={cn(
                          "pressable flex min-h-16 items-center justify-center px-1 text-lg font-semibold first:rounded-l-2xl last:rounded-r-2xl",
                          c.beat === 1 && "border-l-4 border-l-border",
                          on ? "bg-foreground text-background" : "bg-secondary/60 hover:bg-secondary",
                          !on && c.held && "text-muted-foreground",
                        )}
                      >
                        {chord && (
                          <span className="whitespace-nowrap">
                            {chord.root}
                            <sup className="text-xs font-medium">{chord.suffix}</sup>
                          </span>
                        )}
                        {c.chord === "N" && <span className={cn("text-sm font-medium", !on && "text-muted-foreground")}>N.C.</span>}
                      </button>
                    )
                  })}
                </div>
              </li>
            )
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
