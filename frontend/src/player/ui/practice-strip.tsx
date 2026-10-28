import { Metronome, Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { formatClock } from "@/lib/format"
import { usePlayer } from "@/player/store"
import { ChordStrip } from "@/player/ui/chord-strip"
import { cn } from "@/lib/utils"

const SECTION_SECONDS = 15

/** Metronome settings cell + a scrolling strip of fixed-length sections; tap one to loop it. */
export function PracticeStrip() {
  const duration = usePlayer((s) => s.duration)
  const loop = usePlayer((s) => s.loop)
  const metro = usePlayer((s) => s.metronome)
  const analysis = usePlayer((s) => s.analysis)
  const { setLoop, clearLoop, seek, setMetronome } = usePlayer.getState()
  const count = Math.max(1, Math.ceil(duration / SECTION_SECONDS))
  const sections = Array.from({ length: count }, (_, i) => ({ a: i * SECTION_SECONDS, b: Math.min(duration, (i + 1) * SECTION_SECONDS) }))

  return (
    <div className="flex items-stretch gap-2">
      <Popover>
        <PopoverTrigger render={<Button variant="cell" size="cell" aria-pressed={metro.enabled} aria-label="Metronome settings" />}>
          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><Metronome className="size-3.5" />Metronome</span>
          <span className="font-heading text-lg leading-tight font-semibold tabular-nums">{metro.bpm} <span className="text-xs font-normal text-muted-foreground">BPM</span></span>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex w-64 flex-col gap-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="metro-on">Click track</Label>
            <Switch id="metro-on" checked={metro.enabled} onCheckedChange={(v) => setMetronome({ enabled: v })} />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon-lg" aria-label="Slower" onClick={() => setMetronome({ bpm: metro.bpm - 1 })}><Minus /></Button>
            <Slider aria-label="Tempo in BPM" min={30} max={240} step={1} value={metro.bpm} onValueChange={(v) => setMetronome({ bpm: Array.isArray(v) ? v[0] : v })} />
            <Button variant="secondary" size="icon-lg" aria-label="Faster" onClick={() => setMetronome({ bpm: metro.bpm + 1 })}><Plus /></Button>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="metro-count">Count-in (1 bar)</Label>
            <Switch id="metro-count" checked={metro.countIn} onCheckedChange={(v) => setMetronome({ countIn: v })} />
          </div>
          </div>
        </PopoverContent>
      </Popover>

      {analysis ? <ChordStrip analysis={analysis} /> : <div className="fade-x flex min-w-0 flex-1 gap-2 overflow-x-auto scrollbar-none" role="group" aria-label="Loop a section">
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
              className={cn("flex min-h-14 min-w-20 shrink-0 flex-col items-start justify-center rounded-2xl border px-3", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/60")}
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
