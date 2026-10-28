import { useEffect, useMemo, useRef } from "react"
import { buildCells, lastAtOrBefore, splitChord, type Analysis } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { cn } from "@/lib/utils"

/** Scrolling strip with one cell per beat: chord names on changes and downbeats, the current beat highlighted. */
export function ChordStrip({ analysis }: { analysis: Analysis }) {
  const cells = useMemo(() => buildCells(analysis), [analysis])
  const times = useMemo(() => cells.map((c) => c.time), [cells])
  const playing = usePlayer((s) => s.playing)
  const pos = usePosition()
  const active = lastAtOrBefore(times, pos + 0.02)
  const scroller = useRef<HTMLDivElement>(null)
  const { seek } = usePlayer.getState()

  useEffect(() => {
    const box = scroller.current
    const cell = box?.querySelector<HTMLElement>(`[data-beat="${Math.max(active, 0)}"]`)
    if (!box || !cell) return
    box.scrollTo({ left: Math.max(0, cell.offsetLeft - box.clientWidth / 4), behavior: playing ? "smooth" : "auto" })
  }, [active, playing])

  return (
    <div ref={scroller} className="fade-x flex min-w-0 flex-1 overflow-x-auto scrollbar-none" role="group" aria-label="Beats and chords">
      {cells.map((c, i) => {
        const chord = c.chord ? splitChord(c.chord) : null
        return (
          <button
            key={c.time}
            type="button"
            data-beat={i}
            aria-current={i === active}
            aria-label={`Bar ${c.bar} beat ${c.beat}${c.chord ? `, ${c.chord}` : ""}`}
            onClick={() => seek(c.time)}
            className={cn(
              "flex min-h-14 w-14 shrink-0 items-center justify-start border-y px-2 text-base font-semibold first:rounded-l-2xl last:rounded-r-2xl",
              c.beat === 1 ? "border-l border-l-border" : "border-l border-l-transparent",
              i === active ? "border-primary bg-primary text-primary-foreground" : "border-y-border bg-secondary/60",
            )}
          >
            {chord && (
              <span className="whitespace-nowrap">
                {chord.root}
                <sup className="text-xs font-medium">{chord.suffix}</sup>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
