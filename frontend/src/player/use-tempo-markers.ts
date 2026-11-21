import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"
import { createSyncedSaver } from "@/lib/synced-saver"
import { usePlayer } from "@/player/store"
import { normalizeMarkers, type TempoMarker } from "@/player/tempo-map"

const same = (a: TempoMarker[], b: TempoMarker[]) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Saves the player's tempo map to the server whenever it changes (not while it is a drag preview), behind the UI. A failed
 * save puts the last confirmed map back. Mount once per song, next to the player.
 */
export function useTempoMarkers(songId: string, initial: TempoMarker[] | undefined) {
  const qc = useQueryClient()
  const [saver] = useState(() =>
    createSyncedSaver<TempoMarker[]>({
      initial: normalizeMarkers(initial ?? []),
      same,
      save: (markers) => api.setTempoMarkers(songId, markers).then((r) => normalizeMarkers(r.markers)),
      beacon: { url: `/api/songs/${songId}/tempo-markers`, body: (markers) => ({ markers }) },
      onError: (e) => toast.error(e instanceof Error ? `Could not save the tempo map: ${e.message}` : "Could not save the tempo map"),
    }),
  )

  useEffect(() => {
    saver.listen((markers) => usePlayer.getState().setMarkers(markers))
    const unsub = usePlayer.subscribe((s, prev) => {
      if (s.songId !== songId || s.markersDraft || (s.markers === prev.markers && !prev.markersDraft)) return
      saver.set(s.markers)
      qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, tempo_markers: s.markers } : d))
    })
    const onHide = () => saver.beacon()
    window.addEventListener("pagehide", onHide)
    return () => {
      unsub()
      window.removeEventListener("pagehide", onHide)
      saver.flush()
    }
  }, [saver, qc, songId])
}
