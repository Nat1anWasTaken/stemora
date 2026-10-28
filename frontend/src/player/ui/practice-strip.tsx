import { useEffect, useRef } from "react"
import { Metronome } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatClock } from "@/lib/format"
import { usePlayer } from "@/player/store"
import { ChordStrip } from "@/player/ui/chord-strip"
import { TempoPanel } from "@/player/ui/practice-sheets"
import { cn } from "@/lib/utils"

const SECTION_SECONDS = 15

/** Metronome/tempo cell + the beat/chord strip (tap to expand), or fixed-length sections to loop when there is no analysis. */
export function PracticeStrip({ onExpand }: { onExpand: () => void }) {
  const duration = usePlayer((s) => s.duration)
  const loop = usePlayer((s) => s.loop)
  const metro = usePlayer((s) => s.metronome)
  const analysis = usePlayer((s) => s.analysis)
  const { setLoop, clearLoop, seek } = usePlayer.getState()
  const count = Math.max(1, Math.ceil(duration / SECTION_SECONDS))
  const strip = useRef<HTMLDivElement>(null)

  // Keep the looped section in view (e.g. after a loop was set from the waveform or the L key).
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })
  }, [loop])

  const sections = Array.from({ length: count }, (_, i) => ({ a: i * SECTION_SECONDS, b: Math.min(duration, (i + 1) * SECTION_SECONDS) }))

  return (
    <div className="flex items-stretch gap-2">
      <TempoPanel
        trigger={
          <Button variant="cell" size="cell" aria-pressed={metro.enabled} aria-label="Metronome and tempo">
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><Metronome className="size-3.5" />Metronome</span>
            <span className="font-heading text-lg leading-tight font-semibold tabular-nums">{metro.bpm} <span className="text-xs font-normal text-muted-foreground">BPM</span></span>
          </Button>
        }
      />

      {analysis ? <ChordStrip analysis={analysis} onExpand={onExpand} /> : <div ref={strip} className="fade-x flex min-w-0 flex-1 snap-x snap-mandatory scroll-px-5 gap-2 overflow-x-auto overscroll-x-contain scrollbar-none" role="group" aria-label="Loop a section">
        {sections.map((s) => {
          const active = !!loop && Math.abs(loop.a - s.a) < 0.05 && Math.abs(loop.b - s.b) < 0.05
          return (
            <button
              key={s.a}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (active) return clearLoop()
                setLoop(s.a, s.b)
                seek(s.a)
              }}
              className={cn("pressable flex min-h-14 min-w-20 shrink-0 snap-start flex-col items-start justify-center rounded-2xl border px-3", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/60")}
            >
              <span className={cn("text-xs", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{active ? "Looping" : "Section"}</span>
              <span className="text-sm font-semibold tabular-nums">{formatClock(s.a)}</span>
            </button>
          )
        })}
      </div>}
    </div>
  )
}
