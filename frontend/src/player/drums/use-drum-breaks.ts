import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, type SongDetail } from "@/lib/api"
import { keys } from "@/lib/queries"
import { createSyncedSaver } from "@/lib/synced-saver"
import { breakBars, remapBreaks } from "@/player/drums/breaks"
import { usePlayer } from "@/player/store"
import type { TempoMarker } from "@/player/tempo-map"

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The song's drum-notation line breaks, stored on the server as the start times of the bars that begin a row (see
 * drums/breaks.ts), shown as bar indices. Changes show at once and are saved behind them (`createSyncedSaver`).
 *
 * When the tempo map changes, the breaks move to the bar lines now nearest them; any left without a bar line are
 * removed with an Undo toast, and undoing the tempo change (here or with Ctrl/⌘+Z) brings them back. Older songs
 * stored bar indices: those are converted once the bars are known. Mount once per song.
 */
export function useDrumBreaks(songId: string, detail: Pick<SongDetail, "drum_breaks" | "drum_break_times">) {
  const qc = useQueryClient()
  const grid = usePlayer((s) => s.grid)
  const hasAnalysis = usePlayer((s) => !!s.analysis)
  const initial = detail.drum_break_times ?? []
  const [times, setTimes] = useState(initial)
  const legacy = useRef(initial.length ? [] : (detail.drum_breaks ?? []))
  /** Older breaks still waiting to be saved as times: edits wait too, or they would save an incomplete set. */
  const [pending, setPending] = useState(() => !initial.length && !!detail.drum_breaks?.length)
  const [saver] = useState(() =>
    createSyncedSaver<number[]>({
      initial,
      same,
      save: (t) => api.setDrumBreaks(songId, t).then((r) => r.times),
      beacon: { url: `/api/songs/${songId}/drum-breaks`, body: (t) => ({ times: t }) },
      onError: (e) => toast.error(e instanceof Error ? `Could not save the line breaks: ${e.message}` : "Could not save the line breaks"),
    }),
  )

  const show = useCallback((t: number[]) => {
    setTimes(t)
    qc.setQueryData<SongDetail>(keys.song(songId), (d) => (d ? { ...d, drum_breaks: [], drum_break_times: t } : d))
  }, [qc, songId])
  const commit = useCallback((t: number[]) => {
    show(t)
    saver.set(t)
  }, [show, saver])

  useEffect(() => {
    saver.listen(show)
    const onHide = () => saver.beacon()
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      // Closing the player: save what is left (a request in flight sends the rest when it ends).
      saver.flush()
    }
  }, [saver, show])

  // Older songs: bar indices to times, once the bars are there. Their tempo map is still the default then, so these
  // are the bars the breaks were set on. The indices are kept until the server has the times, so a failed save is
  // retried the next time the song opens.
  const converting = useRef(false)
  useEffect(() => {
    if (!legacy.current.length || converting.current || !hasAnalysis || grid.bars.length === 0) return
    const bars = legacy.current
    const t = [...new Set(bars.map((i) => grid.bars[i]?.start).filter((x): x is number => x !== undefined && x > 0))].sort((a, b) => a - b)
    converting.current = true
    setTimes(t)
    api
      .setDrumBreaks(songId, t)
      .then((r) => {
        legacy.current = []
        setPending(false)
        saver.reset(r.times)
        show(r.times)
      })
      .catch(() => toast.error("Could not update the line breaks; they will be converted next time"))
      .finally(() => {
        converting.current = false
      })
  }, [grid, hasAnalysis, songId, saver, show])

  // Tempo map edits move the breaks with the bars. The breaks each map had are kept, so undo and redo put them back.
  useEffect(() => {
    const kept = new WeakMap<TempoMarker[], number[]>()
    let current = usePlayer.getState().markers
    return usePlayer.subscribe((s, p) => {
      if (s.markersDraft) return
      if (s.markerEdits === p.markerEdits) {
        current = s.markers // loading, not an edit
        return
      }
      const before = saver.value
      kept.set(current, before)
      current = s.markers
      const back = kept.get(s.markers)
      if (back) {
        if (!same(back, before)) commit(back)
        return
      }
      if (before.length === 0 || legacy.current.length || !s.analysis?.drums) return
      const r = remapBreaks(before, s.grid.bars)
      if (!same(r.times, before)) commit(r.times)
      if (r.removed === 0) return
      const edited = s.markers
      toast(`Removed ${r.removed} line ${r.removed === 1 ? "break" : "breaks"}`, {
        action: {
          label: "Undo",
          onClick: () => {
            const st = usePlayer.getState()
            if (st.markers === edited) st.undo()
          },
        },
      })
    })
  }, [saver, commit])

  const breaks = useMemo(() => breakBars(times, grid.bars), [times, grid])
  const toggle = useCallback((bar: number) => {
    const start = usePlayer.getState().grid.bars[bar]?.start
    if (bar < 1 || start === undefined || legacy.current.length) return
    const cur = saver.value
    const on = breakBars(cur, usePlayer.getState().grid.bars).includes(bar)
    commit(on ? cur.filter((t) => Math.abs(t - start) > 0.002) : [...cur, start].sort((a, b) => a - b))
  }, [saver, commit])

  return { breaks, toggle, editable: !pending }
}
