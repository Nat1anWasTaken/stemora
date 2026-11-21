import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"

/** Wait this long after the last toggle before saving, so a burst of toggles becomes one request. */
const SAVE_DELAY = 300

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Saves one song's line breaks behind the UI: debounced, whole set at a time, never more than one request in flight
 * (a newer state goes out once the current request ends, so an older response can never overwrite it). `show` puts a
 * state on screen; a failed save shows what the server last confirmed again.
 */
function createSaver(songId: string, initial: number[]) {
  let latest = initial
  let confirmed = initial
  let inFlight = false
  let timer = 0
  let show: (breaks: number[]) => void = () => {}
  const saver = {
    /** Where saved or rolled-back states are shown. */
    listen(fn: (breaks: number[]) => void) {
      show = fn
    },
    flush() {
      clearTimeout(timer)
      if (inFlight || same(latest, confirmed)) return
      const sent = latest
      inFlight = true
      api
        .setDrumBreaks(songId, sent)
        .then((r) => {
          confirmed = r.bars
          // The server normalises; adopt its answer unless the user changed something meanwhile.
          if (same(latest, sent) && !same(r.bars, sent)) {
            latest = r.bars
            show(r.bars)
          }
        })
        .catch((e: unknown) => {
          toast.error(e instanceof Error ? `Could not save the line breaks: ${e.message}` : "Could not save the line breaks")
          latest = confirmed
          show(confirmed)
        })
        .finally(() => {
          inFlight = false
          if (!same(latest, confirmed)) saver.flush()
        })
    },
    toggle(bar: number) {
      if (bar < 1) return
      latest = latest.includes(bar) ? latest.filter((b) => b !== bar) : [...latest, bar].sort((a, b) => a - b)
      show(latest)
      clearTimeout(timer)
      timer = window.setTimeout(saver.flush, SAVE_DELAY)
    },
    /** Page going away: a normal request may be cut off, so send the unsaved state with keepalive. */
    beacon() {
      clearTimeout(timer)
      if (same(latest, confirmed)) return
      void fetch(`/api/songs/${songId}/drum-breaks`, {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bars: latest }),
      }).catch(() => {})
    },
  }
  return saver
}

/**
 * The song's drum-notation line breaks (bars that start a new row), stored on the server. Toggles show at once (local
 * state and the song query cache) and are saved behind them; see `createSaver`. Mount once per song.
 */
export function useDrumBreaks(songId: string, initial: number[] | undefined) {
  const qc = useQueryClient()
  const [breaks, setBreaks] = useState(() => initial ?? [])
  const [saver] = useState(() => createSaver(songId, initial ?? []))

  useEffect(() => {
    saver.listen((b) => {
      setBreaks(b)
      qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, drum_breaks: b } : d))
    })
    const onHide = () => saver.beacon()
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      // Closing the player: save what is left (a request in flight sends the rest when it ends).
      saver.flush()
    }
  }, [saver, qc, songId])

  return { breaks, toggle: saver.toggle }
}
