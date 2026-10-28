import { FastForward, Loader2, Metronome, Pause, Play, Repeat, Rewind } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { formatClock, formatRemaining } from "@/lib/format"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { useState } from "react"

export function SeekBar() {
  const duration = usePlayer((s) => s.duration)
  const ready = usePlayer((s) => s.status === "ready")
  const { seek } = usePlayer.getState()
  const [drag, setDrag] = useState<number | null>(null)
  const pos = usePosition(drag === null)
  const shown = drag ?? pos
  return (
    <div className="flex flex-col gap-0.5">
      <Slider
        aria-label="Seek"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        disabled={!ready}
        value={Math.min(shown, duration)}
        onValueChange={(v) => setDrag(Array.isArray(v) ? v[0] : v)}
        onValueCommitted={(v) => {
          seek(Array.isArray(v) ? v[0] : v)
          setDrag(null)
        }}
      />
      <div className="flex justify-between px-0.5 text-sm text-muted-foreground tabular-nums">
        <time>{formatClock(shown)}</time>
        <time>{formatRemaining(shown, duration)}</time>
      </div>
    </div>
  )
}

export function Transport() {
  const playing = usePlayer((s) => s.playing)
  const status = usePlayer((s) => s.status)
  const metro = usePlayer((s) => s.metronome)
  const loop = usePlayer((s) => s.loop)
  const pendingA = usePlayer((s) => s.pendingA)
  const { toggle, skip, setMetronome, cycleLoop } = usePlayer.getState()
  const ready = status === "ready"
  const loopLabel = loop ? "Clear loop" : pendingA !== null ? "Set loop end (B)" : "Set loop start (A)"
  return (
    <div className="flex items-center justify-between gap-1">
      <Button variant="toggle" size="icon-lg" aria-label="Metronome" aria-pressed={metro.enabled} onClick={() => setMetronome({ enabled: !metro.enabled })}>
        <Metronome />
      </Button>
      <Button variant="ghost" size="icon-lg" aria-label="Back 10 seconds" disabled={!ready} onClick={() => skip(-10)}><Rewind /></Button>
      <Button variant="play" size="icon-xl" aria-label={playing ? "Pause" : "Play"} disabled={!ready} onClick={toggle}>
        {status === "loading" ? <Loader2 className="animate-spin" /> : playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </Button>
      <Button variant="ghost" size="icon-lg" aria-label="Forward 10 seconds" disabled={!ready} onClick={() => skip(10)}><FastForward /></Button>
      <Button variant="toggle" size="icon-lg" aria-label={loopLabel} aria-pressed={!!loop || pendingA !== null} disabled={!ready} onClick={cycleLoop}>
        {pendingA !== null && !loop ? <span className="text-base font-bold">A</span> : <Repeat />}
      </Button>
    </div>
  )
}
