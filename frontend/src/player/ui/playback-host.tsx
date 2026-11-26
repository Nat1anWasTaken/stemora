import { useEffect } from "react"
import type { SongDetail } from "@/lib/api"
import { useSong } from "@/lib/queries"
import { bindMediaHandlers, clearMediaSession, setMediaMetadata, setPlaybackState } from "@/player/mediaSession"
import { getPosition, usePlayer } from "@/player/store"
import { useSettingsSync } from "@/player/use-settings-sync"
import { useTempoMarkers } from "@/player/use-tempo-markers"

function useMediaSession(title: string) {
  const status = usePlayer((s) => s.status)
  const playing = usePlayer((s) => s.playing)
  const duration = usePlayer((s) => s.duration)
  useEffect(() => {
    if (status !== "ready") return
    const { play, pause, seek, skip } = usePlayer.getState()
    setMediaMetadata(title, "/icons/icon-512.png")
    bindMediaHandlers({ play, pause, seekTo: seek, seekBy: skip })
    return clearMediaSession
  }, [status, title])
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
  useSettingsSync(id, detail.settings)
  useMediaSession(title)
  return null
}

/**
 * Keeps the loaded song playing across pages: mounted once for a signed-in user, above the routes, so closing the
 * player sheet only hides it. Signing out (which unmounts it) stops playback.
 */
export function PlaybackHost() {
  const detail = usePlayer((s) => s.detail)
  useEffect(() => () => usePlayer.getState().unload(), [])
  return detail ? <LoadedSong key={detail.song.id} detail={detail} /> : null
}
