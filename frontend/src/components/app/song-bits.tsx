import { AlertTriangle, CheckCircle2, Clock, Hourglass, Link2, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { isHighQuality, type Song } from "@/lib/api"
import { downloadSummary, importStageLabel, queuePlace, stageLabel } from "@/lib/format"

const HEIGHTS = ["h-4", "h-5", "h-6", "h-7", "h-8"] as const

/** Small four-bar glyph; bar heights are derived from the id so each song has its own mark. */
export function SongArtwork({ id, dim }: { id: string; dim?: boolean }) {
  const h = (i: number) => HEIGHTS[parseInt(id.slice(i * 2, i * 2 + 2) || "0", 16) % HEIGHTS.length]
  return (
    <span className={`flex size-14 shrink-0 items-end justify-center gap-1 rounded-2xl bg-secondary p-3 ${dim ? "opacity-60" : ""}`} aria-hidden>
      <span className={`w-1.5 rounded-full bg-vocals ${h(0)}`} />
      <span className={`w-1.5 rounded-full bg-drums ${h(1)}`} />
      <span className={`w-1.5 rounded-full bg-bass ${h(2)}`} />
      <span className={`w-1.5 rounded-full bg-other ${h(3)}`} />
    </span>
  )
}

export function StatusBadge({ song }: { song: Pick<Song, "status" | "stage" | "progress" | "download"> }) {
  switch (song.status) {
    case "pending":
      return <Badge variant="secondary"><Hourglass data-icon="inline-start" />Waiting</Badge>
    case "ready":
      return <Badge variant="success"><CheckCircle2 data-icon="inline-start" />Ready</Badge>
    case "failed":
      return <Badge variant="destructive"><AlertTriangle data-icon="inline-start" />Failed</Badge>
    case "processing":
      return <Badge variant="soft"><Loader2 data-icon="inline-start" className="animate-spin" />{song.progress}%</Badge>
    case "importing":
      return <Badge variant="soft"><Link2 data-icon="inline-start" />{song.stage === "downloading" && song.download?.total_bytes ? `Importing ${song.progress}%` : "Importing"}</Badge>
    case "queued":
      return <Badge variant="warning"><Clock data-icon="inline-start" />Queued</Badge>
    default:
      return <Badge variant="secondary"><Clock data-icon="inline-start" />Uploading</Badge>
  }
}

export function ProcessingLine({ song }: { song: Pick<Song, "status" | "stage" | "progress" | "model" | "download" | "queue_position"> }) {
  if (song.status === "pending") {
    return (
      <span className="text-xs text-muted-foreground">
        {queuePlace(song.queue_position)} · starts when a slot frees up{isHighQuality(song.model) ? " (high quality)" : ""}
      </span>
    )
  }
  if (song.status === "importing") {
    return (
      <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{importStageLabel(song.stage)}</span>
        {song.stage === "downloading" && song.download && <span className="tabular-nums">{downloadSummary(song.download)}</span>}
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground">
      {song.status === "uploading" ? "Uploading" : song.status === "queued" ? "Waiting for a worker" : stageLabel(song.stage)}
      {isHighQuality(song.model) ? " (high quality)" : ""}
    </span>
  )
}
