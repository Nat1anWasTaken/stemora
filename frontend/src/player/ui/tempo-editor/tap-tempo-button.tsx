import { useEffect, useRef, type KeyboardEvent } from "react"
import { Hand } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePlayer } from "@/player/store"
import { TAP_RESET_MS, tapTempo } from "@/player/tap-tempo"
import type { TempoMarker } from "@/player/tempo-map"
import { commitPreview, previewBpm } from "@/player/ui/tempo-editor/actions"

/**
 * Tap along with the beat to set manual marker `index`'s BPM. Each tap previews the tempo (the clicks follow it);
 * once the taps stop the whole run becomes a single undo step. Taps count on press, not release, so they land on the beat.
 * Mount it keyed by marker: unmounting keeps what was tapped.
 */
export function TapTempoButton({ index, large }: { index: number; large?: boolean }) {
  const taps = useRef<number[]>([])
  /** The tempo map before this run of taps, or null when no run is in progress. */
  const from = useRef<TempoMarker[] | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const finish = () => {
    window.clearTimeout(timer.current)
    if (from.current) commitPreview(from.current)
    from.current = null
    taps.current = []
  }
  const finishRef = useRef(finish)
  useEffect(() => () => finishRef.current(), [])

  const tap = () => {
    const r = tapTempo(taps.current, performance.now())
    taps.current = r.taps
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(finish, TAP_RESET_MS)
    if (r.bpm === null) return
    from.current ??= usePlayer.getState().markers
    previewBpm(index, r.bpm)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== " " && e.key !== "Enter") return
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) tap()
  }

  return (
    <Button
      variant="secondary"
      size={large ? "default" : "sm"}
      title="Tap tempo: tap along with the beat"
      onPointerDown={(e) => {
        if (e.button === 0) tap()
      }}
      onKeyDown={onKeyDown}
    >
      <Hand />
      Tap
    </Button>
  )
}
