import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { CloudDownload, Hash, Loader2, Lock, LockOpen, Metronome, Pause, Play, SkipBack, SkipForward, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCommands } from "@/hooks/use-commands"
import { useThemeColor } from "@/hooks/use-theme-color"
import { formatClock } from "@/lib/format"
import { useSetlist } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { transposeChord } from "@/player/analysis"
import { countInClicks } from "@/player/count-in"
import { isOfflineSetlist } from "@/player/offline"
import { getPosition, usePlayer } from "@/player/store"
import { heardSemitones, signed } from "@/player/transpose"
import { MetronomePanel } from "@/player/ui/metronome/metronome-panel"
import { usePlayerEnvironment } from "@/player/ui/player"
import { KeyPanel } from "@/player/ui/practice-sheets"
import { SOURCE_LABEL, useEffectiveSource } from "@/player/ui/settings-source"
import { usePlayheadTempo } from "@/player/ui/use-playhead-tempo"
import { usePosition } from "@/player/ui/use-position"
import { upNext, useUpNext } from "@/player/up-next"

const COUNT_IN_KEY = "stemora:count-in"
function useCountIn(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(COUNT_IN_KEY) === "1"
    } catch {
      return false
    }
  })
  return [on, (v) => {
    setOn(v)
    try {
      localStorage.setItem(COUNT_IN_KEY, v ? "1" : "0")
    } catch {
      /* this visit only */
    }
  }]
}

/** Keeps the screen on while the stage view is open (re-taken when the page comes back; browsers drop it when hidden). */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    let live = true
    const take = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }
        if (document.visibilityState === "visible" && nav.wakeLock) {
          const l = await nav.wakeLock.request("screen")
          if (live) lock = l
          else void l.release()
        }
      } catch {
        /* not allowed (battery saver, unsupported): the screen may sleep */
      }
    }
    void take()
    document.addEventListener("visibilitychange", take)
    return () => {
      live = false
      document.removeEventListener("visibilitychange", take)
      void lock?.release().catch(() => {})
    }
  }, [])
}

/** Press and hold to unlock, so a brushed screen never does it; a keyboard press counts at once. */
function HoldToUnlock({ onUnlock }: { onUnlock: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [holding, setHolding] = useState(false)
  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
  }
  return (
    <Button
      variant="toggle"
      size="lg"
      aria-pressed
      aria-label="Locked. Press and hold to unlock"
      data-holding={holding || undefined}
      onPointerDown={() => {
        setHolding(true)
        timer.current = setTimeout(() => {
          stop()
          onUnlock()
        }, 800)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={(e) => e.detail === 0 && onUnlock()}
    >
      <Lock />{holding ? "Keep holding…" : "Hold to unlock"}
    </Button>
  )
}

function Clock() {
  const duration = usePlayer((s) => s.duration)
  const pos = usePosition(true, 1)
  return <span className="tabular-nums">{formatClock(Math.min(pos, duration))} / {formatClock(duration)}</span>
}

/**
 * Stage view (docs/playback.md): a setlist on stage. Large type, the next song, a touch lock, the screen kept on and
 * page-turner pedals (PageDown / PageUp, or the arrow keys) for next and previous; an optional count-in before a song.
 * Plays through Up Next like everywhere else, so leaving keeps the set going in the mini player.
 */
export function StagePage() {
  const { id = "" } = useParams()
  const nav = useNavigate()
  const { data: d, error } = useSetlist(id)
  const items = useUpNext((s) => s.items)
  const index = useUpNext((s) => s.index)
  const setlistId = useUpNext((s) => s.setlist?.id)
  const status = usePlayer((s) => s.status)
  const playing = usePlayer((s) => s.playing)
  const semitones = usePlayer((s) => heardSemitones(s.semitones, s.keyEnabled))
  const key = usePlayer((s) => s.analysis?.key ?? null)
  const speed = usePlayer((s) => s.speed)
  const metronome = usePlayer((s) => s.metronome)
  const tempo = usePlayheadTempo()
  const { source } = useEffectiveSource()
  const [locked, setLocked] = useState(false)
  const [countIn, setCountIn] = useCountIn()
  usePlayerEnvironment()
  useThemeColor("--sheet-top")
  useWakeLock()

  // Start the set unless it is already the one playing.
  const started = useRef(false)
  useEffect(() => {
    if (!d || started.current) return
    started.current = true
    if (setlistId !== d.setlist.id) upNext.playSetlist(d, 0)
  }, [d, setlistId])

  const here = setlistId === d?.setlist.id
  const item = here ? items[index] : undefined
  const next = here ? items[index + 1] : undefined
  const entry = d?.entries.find((e) => e.id === item?.entryId)
  const nextEntry = d?.entries.find((e) => e.id === next?.entryId)
  const ready = status === "ready"

  const toggle = () => {
    const p = usePlayer.getState()
    if (p.playing) return p.pause()
    p.play(countIn ? countInClicks(p.grid, getPosition(), p.speed) : [])
  }
  useCommands(() => [
    { id: "stage.toggle", title: "Play / pause", group: "Stage", keywords: ["start", "stop"], shortcut: "Space", enabled: () => usePlayer.getState().status === "ready", run: toggle },
    { id: "stage.next", title: "Next song", group: "Stage", keywords: ["pedal", "skip"], shortcut: "PageDown", run: upNext.next },
    { id: "stage.next-arrow", title: "Next song (arrow)", group: "Stage", keywords: ["pedal"], shortcut: "ArrowRight", run: upNext.next },
    { id: "stage.previous", title: "Previous song", group: "Stage", keywords: ["pedal", "back"], shortcut: "PageUp", run: upNext.previous },
    { id: "stage.previous-arrow", title: "Previous song (arrow)", group: "Stage", keywords: ["pedal"], shortcut: "ArrowLeft", run: upNext.previous },
    { id: "stage.lock", title: locked ? "Unlock the screen" : "Lock the screen", group: "Stage", keywords: ["touch"], run: () => setLocked((l) => !l) },
    { id: "stage.count-in", title: countIn ? "Turn count-in off" : "Turn count-in on", group: "Stage", keywords: ["click", "metronome"], run: () => setCountIn(!countIn) },
    { id: "stage.exit", title: "Leave stage view", group: "Stage", keywords: ["exit", "close"], shortcut: "Escape", run: () => nav(`/setlists/${id}`) },
  ], "view")

  if (error && !d) {
    return (
      <div className="player-sheet flex min-h-app flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Setlist not found</h1>
        <Button render={<Link to="/?tab=setlists" />}>Back to setlists</Button>
      </div>
    )
  }
  const heardKey = key ? transposeChord(key, semitones) : null

  return (
    <div className="player-sheet fixed inset-0 z-40 flex h-app flex-col gap-4 overflow-hidden px-4 pt-safe pb-safe md:px-10">
      <header className="flex items-center gap-2 pt-2">
        <Button variant="secondary" size="icon-lg" aria-label="Leave stage view" disabled={locked} render={<Link to={`/setlists/${id}`} />}><X /></Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{d?.setlist.name ?? "Setlist"}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {here && items.length > 0 ? `Song ${index + 1} of ${items.length}` : "Loading"} · {SOURCE_LABEL[source]}
            {isOfflineSetlist(id) && <><CloudDownload className="size-3.5" aria-label="Available offline" /></>}
          </span>
        </div>
        {locked ? <HoldToUnlock onUnlock={() => setLocked(false)} /> : <Button variant="toggle" size="lg" aria-pressed={false} onClick={() => setLocked(true)}><LockOpen />Lock</Button>}
      </header>

      <main className="flex min-h-0 flex-1 flex-col justify-center gap-6">
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl leading-tight font-semibold md:text-6xl">{item?.title ?? "…"}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xl text-muted-foreground md:text-2xl">
            {heardKey && <span>Key <span className="font-semibold text-foreground">{heardKey}</span>{semitones !== 0 && <span className="text-primary"> ({signed(semitones)})</span>}</span>}
            {tempo.bpm !== null && <span><span className="font-semibold text-foreground tabular-nums">{Math.round(tempo.bpm * speed)}</span> BPM{speed !== 1 && <span className="text-primary"> ({Math.round(speed * 100)}%)</span>}</span>}
            {tempo.num > 0 && <span className="tabular-nums">{tempo.num}/{tempo.den}</span>}
            {ready ? <Clock /> : status === "loading" ? <Loader2 className="size-5 animate-spin" /> : null}
          </p>
          {entry?.notes && <p className="text-2xl font-medium text-primary md:text-3xl">{entry.notes}</p>}
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-4">
          <span className="text-sm text-muted-foreground">Next</span>
          <span className="truncate text-2xl font-semibold md:text-3xl">{next?.title ?? "End of the set"}</span>
          {nextEntry?.notes && <span className="truncate text-lg text-muted-foreground">{nextEntry.notes}</span>}
        </div>
      </main>

      <footer className={cn("flex flex-col gap-4 pb-4", locked && "opacity-60")}>
        <div className="flex items-center justify-center gap-6">
          <Button variant="ghost" size="icon-xl" aria-label="Previous song" disabled={locked} onClick={upNext.previous}><SkipBack /></Button>
          <Button variant="play" size="icon-xl" aria-label={playing ? "Pause" : "Play"} disabled={locked || !ready} onClick={toggle}>
            {status === "loading" ? <Loader2 className="animate-spin" /> : playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <Button variant="ghost" size="icon-xl" aria-label="Next song" disabled={locked || !next} onClick={upNext.next}><SkipForward /></Button>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="toggle" size="lg" aria-pressed={countIn} disabled={locked} onClick={() => setCountIn(!countIn)}>Count-in</Button>
          <MetronomePanel trigger={<Button variant="toggle" size="icon-lg" aria-label="Metronome and tempo" aria-pressed={metronome || speed !== 1} disabled={locked}><Metronome /></Button>} />
          <KeyPanel trigger={<Button variant="toggle" size="icon-lg" aria-label="Key" aria-pressed={semitones !== 0} disabled={locked}><Hash /></Button>} />
        </div>
      </footer>
    </div>
  )
}
