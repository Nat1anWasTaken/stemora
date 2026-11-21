import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"
import { createSyncedSaver } from "@/lib/synced-saver"

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The song's drum-notation line breaks (bars that start a new row), stored on the server. Toggles show at once (local
 * state and the song query cache) and are saved behind them; see `createSyncedSaver`. Mount once per song.
 */
export function useDrumBreaks(songId: string, initial: number[] | undefined) {
  const qc = useQueryClient()
  const [breaks, setBreaks] = useState(() => initial ?? [])
  const [saver] = useState(() =>
    createSyncedSaver<number[]>({
      initial: initial ?? [],
      same,
      save: (bars) => api.setDrumBreaks(songId, bars).then((r) => r.bars),
      beacon: { url: `/api/songs/${songId}/drum-breaks`, body: (bars) => ({ bars }) },
      onError: (e) => toast.error(e instanceof Error ? `Could not save the line breaks: ${e.message}` : "Could not save the line breaks"),
    }),
  )

  useEffect(() => {
    const show = (b: number[]) => {
      setBreaks(b)
      qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, drum_breaks: b } : d))
    }
    saver.listen(show)
    const onHide = () => saver.beacon()
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      // Closing the player: save what is left (a request in flight sends the rest when it ends).
      saver.flush()
    }
  }, [saver, qc, songId])

  const toggle = (bar: number) => {
    if (bar < 1) return
    const cur = saver.value
    const next = cur.includes(bar) ? cur.filter((b) => b !== bar) : [...cur, bar].sort((a, b) => a - b)
    setBreaks(next)
    qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, drum_breaks: next } : d))
    saver.set(next)
  }

  return { breaks, toggle }
}
