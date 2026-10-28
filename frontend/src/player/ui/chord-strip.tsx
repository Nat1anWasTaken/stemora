import { useEffect, useMemo, useRef } from "react"
import { buildCells, lastAtOrBefore, splitChord, type Analysis } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { cn } from "@/lib/utils"

/** Scrolling strip with one cell per beat: chord names on changes and downbeats, the current beat highlighted. Tap to open the chord chart. */
export function ChordStrip({ analysis, onExpand }: { analysis: Analysis; onExpand: () => void }) {
  const cells = useMemo(() => buildCells(analysis), [analysis])
  const times = useMemo(() => cells.map((c) => c.time), [cells])
  const playing = usePlayer((s) => s.playing)
  const pos = usePosition()
  const active = lastAtOrBefore(times, pos + 0.02)
  const scroller = useRef<HTMLDivElement>(null)
  const current = active >= 0 ? cells[active] : null

  useEffect(() => {
    const box = scroller.current
    const cell = box?.querySelector<HTMLElement>(`[data-beat="${Math.max(active, 0)}"]`)
    if (!box || !cell) return
    box.scrollTo({ left: Math.max(0, cell.offsetLeft - box.clientWidth / 4), behavior: playing ? "smooth" : "auto" })
  }, [active, playing])

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Open chord chart${current ? `, bar ${current.bar} beat ${current.beat}` : ""}`}
      className="pressable flex min-w-0 flex-1 rounded-2xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div ref={scroller} className="fade-x relative flex min-w-0 flex-1 overflow-x-auto scrollbar-none" aria-hidden>
        {cells.map((c, i) => {
          const chord = c.chord && c.chord !== "N" ? splitChord(c.chord) : null
          return (
            <span
              key={c.time}
              data-beat={i}
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
            </span>
          )
        })}
      </div>
    </button>
  )
}
