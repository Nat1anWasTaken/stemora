import { useEffect, useMemo, useState } from "react"
import { buildBars, buildCells, lastAtOrBefore, splitChord, transposeChord, type Analysis, type Bar } from "@/player/analysis"
import { getPosition, usePlayer } from "@/player/store"
import { cn } from "@/lib/utils"

/** Highlight a beat this many seconds early so it lands with the sound rather than just after it. */
const LOOKAHEAD = 0.02

const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7" }

/** Beat cells and bars of an analysis, plus the index of the beat under the playhead. */
export function useBeats(analysis: Analysis | null) {
  const duration = usePlayer((s) => s.duration)
  const cells = useMemo(() => (analysis ? buildCells(analysis) : []), [analysis])
  const bars = useMemo(() => buildBars(cells, duration), [cells, duration])
  const times = useMemo(() => cells.map((c) => c.time), [cells])
  const active = useActiveBeat(times)
  return { cells, bars, times, active }
}

/** Beat index under the playhead (-1 before the first beat), checked every frame so it changes exactly on the beat. */
export function useActiveBeat(times: number[]): number {
  const [active, setActive] = useState(() => beatAt(times, getPosition()))
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setActive(beatAt(times, getPosition()))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [times])
  return active
}

export const beatAt = (times: number[], pos: number) => lastAtOrBefore(times, pos + LOOKAHEAD)

/**
 * One bar of beat cells, shared by the chord strip (`compact`, a static row inside its own button) and the chord
 * chart (a grid of cells that seek when tapped).
 */
export function BarBeats({ bar, activeTime, beatsPerBar, compact, looped, onSeek }: {
  bar: Bar
  activeTime: number | null
  beatsPerBar: number
  compact?: boolean
  looped?: boolean
  onSeek?: (t: number) => void
}) {
  const semitones = usePlayer((s) => s.semitones)
  return (
    <div className={cn("gap-0.5 rounded-2xl", compact ? "flex shrink-0" : cn("grid", COLS[beatsPerBar] ?? "grid-cols-4"), looped && "ring-2 ring-primary")}>
      {bar.cells.map((c) => {
        const on = c.time === activeTime
        const label = c.chord && c.chord !== "N" ? transposeChord(c.chord, semitones) : null
        const chord = label ? splitChord(label) : null
        const className = cn(
          "flex items-center justify-center px-1 font-semibold first:rounded-l-2xl last:rounded-r-2xl",
          // No colour transition: a fading highlight leaves the previous beat lit while the next one lights up.
          compact ? "min-h-14 w-14 shrink-0 text-base" : "min-h-16 text-lg transition-transform duration-150 ease-spring active:scale-97",
          c.beat === 1 && "border-l-4 border-l-border",
          on ? "bg-foreground text-background" : cn("bg-secondary/60", onSeek && "hover:bg-secondary"),
          !on && c.held && "text-muted-foreground",
        )
        const content = (
          <>
            {chord && (
              <span className="whitespace-nowrap">
                {chord.root}
                <sup className="text-xs font-medium">{chord.suffix}</sup>
              </span>
            )}
            {c.chord === "N" && <span className={cn("text-sm font-medium", !on && "text-muted-foreground")}>N.C.</span>}
          </>
        )
        return onSeek ? (
          <button
            key={c.time}
            type="button"
            data-time={c.time}
            aria-current={on}
            aria-label={`Bar ${c.bar} beat ${c.beat}${c.chord ? `, ${c.chord === "N" ? "no chord" : label}` : ""}`}
            onClick={() => onSeek(c.time)}
            className={className}
          >
            {content}
          </button>
        ) : (
          <span key={c.time} data-time={c.time} className={className}>{content}</span>
        )
      })}
    </div>
  )
}
