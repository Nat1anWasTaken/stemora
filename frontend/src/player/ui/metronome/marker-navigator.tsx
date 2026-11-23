import { ChevronLeft, ChevronRight } from "lucide-react"
import { PanelHeadline } from "@/components/app/panel-parts"
import { Button } from "@/components/ui/button"
import { formatClock } from "@/lib/format"
import { usePlayer } from "@/player/store"
import { formatTimeSignature, isImplicitStart, markerNumber, visibleMarkerCount } from "@/player/tempo-map"
import { formatBpm } from "@/player/ui/use-playhead-tempo"

/**
 * ‹ Marker 2 of 5 › for the marker under the playhead. Stepping seeks to the previous or next marker, so the marker
 * being edited is always the one you hear. Before the first marker the user placed (the implicit start) it reads
 * "Detected beats", since there is no marker there to number.
 */
export function MarkerNavigator({ index }: { index: number }) {
  const markers = usePlayer((s) => s.markers)
  const { seek } = usePlayer.getState()
  const m = markers[index]
  if (!m) return null
  const go = (i: number) => markers[i] && seek(markers[i].time)
  const implicit = isImplicitStart(markers, index)
  const next = markers[index + 1]
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" aria-label="Previous tempo marker" disabled={index <= 0} onClick={() => go(index - 1)}><ChevronLeft /></Button>
      <PanelHeadline
        title={implicit ? "Detected beats" : `Marker ${markerNumber(markers, index)} of ${visibleMarkerCount(markers)}`}
        detail={implicit
          ? next ? `Until marker 1 at ${formatClock(next.time)}` : "Whole song"
          : `${formatClock(m.time)} · ${m.kind === "manual" ? `${formatBpm(m.bpm)} BPM · ${formatTimeSignature(m)}` : "Detected beats"}`}
      />
      <Button variant="ghost" size="icon" aria-label="Next tempo marker" disabled={index >= markers.length - 1} onClick={() => go(index + 1)}><ChevronRight /></Button>
    </div>
  )
}
