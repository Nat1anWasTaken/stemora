import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api, type PlaybackSettings, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"
import { createSyncedSaver } from "@/lib/synced-saver"
import { clearLegacy, clearPending, defaultSettings, parseSettings, sameSettings, savePending } from "@/player/settings"
import { settingsOf, usePlayer } from "@/player/store"

/**
 * Saves the song's playback settings (mixer, speed, key, click) to the server behind the UI, so nothing waits on the
 * network: the player changes at once, the set goes out debounced, and one that fails stays in localStorage (it never
 * rolls back what you hear) and goes out again with the next change, when the browser is back online, or the next
 * time the song opens. A song never saved on the server sends the set it opened with once, which moves the mixer older
 * versions kept in this browser to the server. Mount once per song, next to the player.
 */
export function useSettingsSync(songId: string, server: PlaybackSettings | null | undefined) {
  const qc = useQueryClient()
  const [saver] = useState(() =>
    createSyncedSaver<PlaybackSettings>({
      // Against defaults when the server has none, so opening such a song with anything else saves it.
      initial: server ? parseSettings(server) : defaultSettings(),
      same: sameSettings,
      save: async (s) => {
        const r = await api.setSongSettings(songId, s)
        const saved = parseSettings(r.settings)
        // Only clear the browser copy if nothing changed meanwhile; a newer state keeps it until that one is saved.
        if (sameSettings(saved, settingsOf(usePlayer.getState()))) clearPending({ kind: "song", id: songId })
        clearLegacy(songId)
        return saved
      },
      beacon: { url: `/api/songs/${songId}/settings`, body: (settings) => ({ settings }) },
      // Quiet: the change is kept and retried, and a toast for every slider move while offline would be noise.
      onError: () => {},
      keepOnError: true,
    }),
  )

  useEffect(() => {
    const scope = { kind: "song", id: songId } as const
    let last: PlaybackSettings | null = null
    const push = (s: PlaybackSettings) => {
      if (last && sameSettings(s, last)) return
      const initial = last === null
      last = s
      if (!initial) savePending(scope, s)
      // The set the song opened with: a browser copy the server already holds (a keepalive save that went through) is done.
      else if (sameSettings(s, saver.value)) clearPending(scope)
      saver.set(s)
      qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, settings: s } : d))
    }
    const st = usePlayer.getState()
    if (st.songId === songId) push(settingsOf(st))
    const unsub = usePlayer.subscribe((s) => {
      if (s.songId === songId) push(settingsOf(s))
    })
    const retry = () => saver.flush()
    const onHide = () => saver.beacon()
    window.addEventListener("online", retry)
    window.addEventListener("pagehide", onHide)
    return () => {
      unsub()
      window.removeEventListener("online", retry)
      window.removeEventListener("pagehide", onHide)
      saver.flush()
    }
  }, [saver, qc, songId])
}
