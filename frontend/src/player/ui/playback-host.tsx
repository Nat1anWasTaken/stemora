import { useEffect } from "react"
import type { PlaybackSettings, SettingsSource, SongDetail } from "@/lib/api"
import { useCommands } from "@/hooks/use-commands"
import { SOURCE_LABEL } from "@/player/ui/settings-source"
import { useSong } from "@/lib/queries"
import { bindMediaHandlers, clearMediaSession, setMediaMetadata, setPlaybackState } from "@/player/mediaSession"
import { scopeKey, type SettingsScope } from "@/player/settings"
import { getPosition, usePlayer } from "@/player/store"
import { upNext, useUpNext } from "@/player/up-next"
import { useSettingsSync } from "@/player/use-settings-sync"
import { useTempoMarkers } from "@/player/use-tempo-markers"

function useMediaSession(title: string) {
  const status = usePlayer((s) => s.status)
  const playing = usePlayer((s) => s.playing)
  const duration = usePlayer((s) => s.duration)
  const hasNext = useUpNext((s) => s.index + 1 < s.items.length)
  useEffect(() => {
    if (status !== "ready") return
    const { play, pause, seek, skip } = usePlayer.getState()
    setMediaMetadata(title, "/icons/icon-512.png")
    // Previous always works: it goes back to the start of the song when there is none before it.
    bindMediaHandlers({ play, pause, seekTo: seek, seekBy: skip, next: hasNext ? upNext.next : null, previous: upNext.previous })
    return clearMediaSession
  }, [status, title, hasNext])
  useEffect(() => {
    if (status !== "ready") return
    setPlaybackState(playing, getPosition(), duration)
    if (!playing) return
    const id = setInterval(() => setPlaybackState(true, getPosition(), duration), 1000)
    return () => clearInterval(id)
  }, [status, playing, duration])
}

/** What has to keep running for the loaded song while the player sheet is closed: saving its edits, lock-screen controls. */
function LoadedSong({ detail }: { detail: SongDetail }) {
  const id = detail.song.id
  // The cached song, so a rename shows on the lock screen too.
  const title = useSong(id).data?.song.title ?? detail.song.title
  useTempoMarkers(id, detail.tempo_markers)
  useMediaSession(title)
  return null
}

function SettingsSync({ scope, server }: { scope: SettingsScope; server: PlaybackSettings | null }) {
  useSettingsSync(scope, server)
  return null
}

/**
 * Keeps the loaded song playing across pages: mounted once for a signed-in user, above the routes, so closing the
 * player sheet only hides it. Signing out (which unmounts it) stops playback.
 */
/** Up Next and the settings source in the command palette, wherever the player is. */
function usePlaybackCommands() {
  useCommands(() => {
    const loaded = () => usePlayer.getState().songId !== null
    const { setlist } = useUpNext.getState()
    const sources: SettingsSource[] = ["song", ...(setlist ? (["setlist"] as const) : []), "listening"]
    return [
      { id: "upnext.next", title: "Next song", group: "Up next", keywords: ["skip", "queue", "track"], enabled: () => loaded() && upNext.hasNext(), run: upNext.next },
      { id: "upnext.previous", title: "Previous song", group: "Up next", keywords: ["back", "queue", "track"], enabled: loaded, run: upNext.previous },
      { id: "upnext.clear", title: "Clear Up Next", group: "Up next", keywords: ["queue"], enabled: () => useUpNext.getState().items.length > 1, run: upNext.clear },
      ...sources.map((v) => ({
        id: `settings.source.${v}`,
        title: `Play with ${SOURCE_LABEL[v].toLowerCase()}`,
        group: "Up next",
        keywords: ["settings", "source", "mixer", "listening", "setlist"],
        enabled: () => useUpNext.getState().source !== v,
        run: () => void upNext.setSource(v),
      })),
    ]
  })
}

export function PlaybackHost() {
  usePlaybackCommands()
  const detail = usePlayer((s) => s.detail)
  const scope = usePlayer((s) => s.settingsScope)
  const server = usePlayer((s) => s.settingsServer)
  useEffect(() => () => usePlayer.getState().unload(), [])
  return (
    <>
      {detail && <LoadedSong key={detail.song.id} detail={detail} />}
      {scope && <SettingsSync key={scopeKey(scope)} scope={scope} server={server} />}
    </>
  )
}
