import { useEffect, useMemo, useRef } from "react"
import { Repeat } from "lucide-react"
import { revealInline, useEdgeFade } from "@/hooks/use-edge-fade"
import { useIsDesktop } from "@/hooks/use-media"
import { formatClock } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Section } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { useActiveBeat } from "@/player/ui/beats"
import { PresetChips } from "@/player/ui/preset-chips"

const isLooped = (loop: { a: number; b: number } | null, s: Section) => !!loop && Math.abs(loop.a - s.start) < 0.05 && Math.abs(loop.b - s.end) < 0.05

/**
 * Song parts (Intro, Verse 1, Chorus 1, ...) with the one playing highlighted. Tap a part to jump to it; tap the part
 * that is playing to loop it (again to stop). While a part loops, tapping another part moves the loop there.
 * Songs without detected parts keep the mix presets in this row.
 */
export function SectionBar() {
  const sections = usePlayer((s) => s.analysis?.sections)
  if (!sections?.length) return <PresetChips />
  return <Sections sections={sections} />
}

function Sections({ sections }: { sections: Section[] }) {
  const loop = usePlayer((s) => s.loop)
  const desktop = useIsDesktop()
  const { seek, setLoop, clearLoop } = usePlayer.getState()
  const starts = useMemo(() => sections.map((s) => s.start), [sections])
  const active = useActiveBeat(starts)
  const looping = sections.findIndex((s) => isLooped(loop, s))
  const row = useRef<HTMLDivElement>(null)
  useEdgeFade(row)

  // Keep the part that is playing (or looping) in view.
  const shown = looping >= 0 ? looping : active
  useEffect(() => {
    const box = row.current
    const chip = box?.querySelector<HTMLElement>(`[data-index="${shown}"]`)
    if (box && chip) revealInline(box, chip)
  }, [shown])

  const pick = (i: number) => {
    const s = sections[i]
    if (looping === i) return clearLoop()
    if (looping >= 0 || active === i) setLoop(s.start, s.end)
    seek(s.start)
  }

  return (
    <div ref={row} className="fade-x -mx-4 overflow-x-auto scrollbar-none md:mx-0" role="group" aria-label="Song parts">
      <div className="flex w-max gap-2 px-4 md:px-0">
        {sections.map((s, i) => {
          const playing = active === i
          const looped = looping === i
          return (
            <button
              key={s.start}
              type="button"
              data-index={i}
              data-section={s.kind}
              aria-current={playing || undefined}
              aria-pressed={looped}
              aria-label={`${s.name} at ${formatClock(s.start)}${looped ? ", looping" : playing ? ", playing: tap to loop" : ""}`}
              onClick={() => pick(i)}
              className={cn(
                "pressable flex shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium",
                desktop ? "min-h-11" : "min-h-9",
                looped ? "border-section bg-section text-background" : playing ? "border-section bg-section/15 text-foreground" : "border-border bg-secondary/60 text-foreground hover:bg-secondary",
              )}
            >
              {looped ? <Repeat className="size-3.5" /> : <span aria-hidden className="size-2 rounded-full bg-section" />}
              {s.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
