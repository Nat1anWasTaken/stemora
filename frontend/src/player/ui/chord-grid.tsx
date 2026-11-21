import { useEffect, useMemo, useRef, useState } from "react"
import { LocateFixed, Music } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sectionsByBar } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { BarBeats, useBeats } from "@/player/ui/beats"
import { cn } from "@/lib/utils"

/**
 * Expanded chord chart: one row per bar, one cell per beat, following the playhead.
 * Tap a beat to seek there, tap a bar number to loop that bar. Scrolling by hand pauses following. The bar where a
 * song part starts carries its name.
 */
export function ChordGrid() {
  const sections = usePlayer((s) => s.analysis?.sections)
  const playing = usePlayer((s) => s.playing)
  const loop = usePlayer((s) => s.loop)
  const { seek, setLoop, clearLoop } = usePlayer.getState()
  const { cells, bars, active } = useBeats()
  const partAt = useMemo(() => sectionsByBar(sections ?? [], bars), [sections, bars])
  // The grid can shrink (a tempo map undo) a frame before `active` catches up, so check it against the current cells.
  const current = active >= 0 && active < cells.length ? cells[active] : null
  const activeBar = current?.bar ?? null
  const activeTime = current?.time ?? null
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = scroller.current
    const row = box?.querySelector<HTMLElement>(`[data-bar="${activeBar ?? bars[0]?.bar}"]`)
    if (!follow || !box || !row) return
    box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 4), behavior: playing ? "smooth" : "auto" })
  }, [activeBar, bars, follow, playing])

  if (bars.length === 0) {
    return (
      <section aria-label="Chord chart" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface/70 p-6 text-sm text-muted-foreground">
          <Music className="size-6" />No beats
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Chord chart" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface/70 p-3 scrollbar-none"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        <ol className="grid grid-cols-1 gap-x-3 gap-y-2 pb-20 md:grid-cols-2 xl:grid-cols-4">
          {bars.map((b) => {
            const looped = !!loop && Math.abs(loop.a - b.start) < 0.05 && Math.abs(loop.b - b.end) < 0.05
            const part = partAt.get(b.start)
            return (
              <li key={b.start} data-bar={b.bar} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
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
                  {part && (
                    <span data-section={part.kind} className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-section">
                      <span aria-hidden className="size-2 shrink-0 rounded-full bg-section" />{part.name}
                    </span>
                  )}
                </div>
                <BarBeats bar={b} activeTime={activeTime} looped={looped} onSeek={seek} />
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
