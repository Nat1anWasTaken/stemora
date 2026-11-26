import { Loader2, Pause, Play, SkipForward, X } from "lucide-react"
import { useNavigate } from "react-router"
import { SongArtwork } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { useCommands } from "@/hooks/use-commands"
import { formatClock } from "@/lib/format"
import { useSong } from "@/lib/queries"
import { usePlayer } from "@/player/store"
import { usePosition } from "@/player/ui/use-position"
import { SOURCE_LABEL, useEffectiveSource } from "@/player/ui/settings-source"
import { upNext, useUpNext } from "@/player/up-next"

function Clock() {
  const duration = usePlayer((s) => s.duration)
  const pos = usePosition(true, 1)
  return <>{formatClock(Math.min(pos, duration))} / {formatClock(duration)}</>
}

/**
 * The loaded song while the player sheet is closed: tap it to open the player again. Floats above the bottom nav on
 * phones and at the bottom of the main area on desktop, in the nav's glass. Rendered by the app shell.
 */
export function MiniPlayer() {
  const nav = useNavigate()
  const detail = usePlayer((s) => s.detail)
  const status = usePlayer((s) => s.status)
  const playing = usePlayer((s) => s.playing)
  const loadProgress = usePlayer((s) => s.loadProgress)
  const id = detail?.song.id ?? ""
  const cached = useSong(id).data
  const title = cached?.song.title ?? detail?.song.title ?? ""
  const ready = status === "ready"
  const hasNext = useUpNext((s) => s.index + 1 < s.items.length)
  const { source } = useEffectiveSource()
  const open = () => nav(`/songs/${id}`)
  const stop = () => usePlayer.getState().unload()

  useCommands(() => detail ? [
    { id: "mini.toggle-play", title: "Play / pause", group: "Playback", keywords: ["start", "stop"], shortcut: "Space", enabled: () => usePlayer.getState().status === "ready", run: () => usePlayer.getState().toggle() },
    { id: "mini.open", title: `Open player: ${title}`, group: "Playback", keywords: ["now playing", "song"], run: open },
    { id: "mini.stop", title: "Stop and close the player", group: "Playback", keywords: ["now playing", "dismiss"], run: stop },
  ] : [])

  if (!detail) return null
  return (
    <div role="region" aria-label="Now playing" className="glass fixed inset-x-4 bottom-mini z-30 mx-auto flex max-w-sm animate-in items-center gap-1 rounded-full border border-border p-1.5 duration-300 ease-spring fade-in slide-in-from-bottom-4 md:right-8 md:bottom-6 md:left-72 md:max-w-xl">
      <button type="button" onClick={open} aria-label={`Open player: ${title}`} className="pressable flex min-w-0 flex-1 items-center gap-3 rounded-full pr-2 text-left">
        <SongArtwork id={id} size="xs" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">
            {status === "error" ? "Could not load the stems" : ready ? <Clock /> : `Loading ${Math.round(loadProgress * 100)}%`}
            {source !== "song" && <span className="text-primary"> · {SOURCE_LABEL[source]}</span>}
          </span>
        </span>
      </button>
      <Button variant="play" size="icon-lg" aria-label={playing ? "Pause" : "Play"} disabled={!ready} onClick={() => usePlayer.getState().toggle()}>
        {status === "loading" ? <Loader2 className="animate-spin" /> : playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </Button>
      {hasNext && <Button variant="ghost" size="icon-lg" aria-label="Next song" onClick={upNext.next}><SkipForward /></Button>}
      <Button variant="ghost" size="icon-lg" aria-label="Stop and close the player" onClick={stop}><X /></Button>
    </div>
  )
}
