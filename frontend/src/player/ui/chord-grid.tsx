import { useEffect, useRef, useState } from "react"
import { LocateFixed, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePlayer } from "@/player/store"
import { BarBeats, useBeats } from "@/player/ui/beats"
import { cn } from "@/lib/utils"

/**
 * Expanded chord chart: one row per bar, one cell per beat, following the playhead.
 * Tap a beat to seek there, tap a bar number to loop that bar. Scrolling by hand pauses following.
 */
export function ChordGrid({ onCollapse }: { onCollapse?: () => void }) {
  const analysis = usePlayer((s) => s.analysis)
  const playing = usePlayer((s) => s.playing)
  const loop = usePlayer((s) => s.loop)
  const { seek, setLoop, clearLoop } = usePlayer.getState()
  const { cells, bars, active } = useBeats(analysis)
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
                <BarBeats bar={b} activeTime={activeTime} beatsPerBar={analysis.beatsPerBar} looped={looped} onSeek={seek} />
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
