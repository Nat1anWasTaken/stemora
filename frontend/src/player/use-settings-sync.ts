import { useEffect, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, type PlaybackSettings, type SetlistDetail, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"
import { createSyncedSaver } from "@/lib/synced-saver"
import { clearLegacy, clearPending, defaultSettings, parseSettings, sameSettings, savePending, scopeKey, type SettingsScope } from "@/player/settings"
import { settingsOf, usePlayer } from "@/player/store"

/** Sends a set to where `scope` keeps it, and puts the saved copy in the query cache so a reopened page shows it. */
async function saveTo(qc: QueryClient, scope: SettingsScope, s: PlaybackSettings): Promise<PlaybackSettings> {
  switch (scope.kind) {
    case "song": {
      const saved = parseSettings((await api.setSongSettings(scope.id, s)).settings)
      clearLegacy(scope.id)
      qc.setQueryData<SongDetail>(keys.song(scope.id), (d) => (d ? { ...d, settings: saved } : d))
      return saved
    }
    case "listening": {
      const saved = parseSettings((await api.setListeningSettings(s)).settings)
      qc.setQueryData(keys.listening, { settings: saved })
      return saved
    }
    case "entry": {
      const saved = parseSettings((await api.setEntrySettings(scope.setlistId, scope.entryId, s)).settings)
      qc.setQueryData<SetlistDetail>(keys.setlist(scope.setlistId), (d) =>
        d ? { ...d, entries: d.entries.map((e) => (e.id === scope.entryId ? { ...e, settings: saved } : e)) } : d,
      )
      return saved
    }
  }
}

const beaconUrl = (scope: SettingsScope) =>
  scope.kind === "song" ? `/api/songs/${scope.id}/settings` : scope.kind === "entry" ? `/api/setlists/${scope.setlistId}/entries/${scope.entryId}/settings` : "/api/me/listening-settings"

/**
 * Saves the settings being heard to where they come from (a song, the listening set or a setlist entry; see
 * docs/playback.md) behind the UI, so nothing waits on the network: the player changes at once, the set goes out
 * debounced, and one that fails stays in localStorage (it never rolls back what you hear) and goes out again with the
 * next change, when the browser is back online, or the next time that set is opened. A set the server does not hold
 * yet is sent as soon as it is opened (which moves the mixer older versions kept in this browser to the server, and
 * starts the listening set from what you hear). Mounted by PlaybackHost, keyed by the scope.
 */
export function useSettingsSync(scope: SettingsScope, server: PlaybackSettings | null) {
  const qc = useQueryClient()
  const key = scopeKey(scope)
  const [saver] = useState(() =>
    createSyncedSaver<PlaybackSettings>({
      // Against defaults when the server has none, so opening such a set with anything else saves it.
      initial: server ? parseSettings(server) : defaultSettings(),
      same: sameSettings,
      save: async (s) => {
        const saved = await saveTo(qc, scope, s)
        // Only clear the browser copy if nothing changed meanwhile; a newer state keeps it until that one is saved.
        if (sameSettings(saved, settingsOf(usePlayer.getState()))) clearPending(scope)
        return saved
      },
      beacon: { url: beaconUrl(scope), body: (settings) => ({ settings }) },
      // Quiet: the change is kept and retried, and a toast for every slider move while offline would be noise.
      onError: () => {},
      keepOnError: true,
    }),
  )

  useEffect(() => {
    let last: PlaybackSettings | null = null
    const push = (s: PlaybackSettings) => {
      if (last && sameSettings(s, last)) return
      const initial = last === null
      last = s
      if (!initial) savePending(scope, s)
      // The set as opened: a browser copy the server already holds (a keepalive save that went through) is done.
      else if (sameSettings(s, saver.value)) clearPending(scope)
      saver.set(s)
    }
    const current = (st: ReturnType<typeof usePlayer.getState>) => st.settingsScope !== null && scopeKey(st.settingsScope) === key
    if (current(usePlayer.getState())) push(settingsOf(usePlayer.getState()))
    const unsub = usePlayer.subscribe((st) => {
      if (current(st)) push(settingsOf(st))
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
    // `scope` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver, key])
}
