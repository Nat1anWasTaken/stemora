import { Link, useParams } from "react-router"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { ProcessingLine, SongArtwork } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useSong, useSongActions } from "@/lib/queries"
import { Player } from "@/player/ui/player"

export function SongPage() {
  const { id = "" } = useParams()
  const { data, error, isLoading } = useSong(id)
  const { reprocess } = useSongActions()

  if (isLoading) return <div className="grid min-h-app place-items-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
  if (error || !data) {
    return (
      <div className="mx-auto flex min-h-app max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Song not found</h1>
        <p className="text-muted-foreground">{error?.message ?? "It may have been deleted."}</p>
        <Button render={<Link to="/" />}>Back to library</Button>
      </div>
    )
  }
  const { song } = data
  if (song.status === "ready" && data.stems.length > 0) return <Player detail={data} />

  return (
    <div className="player-sheet animate-sheet-in flex min-h-app flex-col items-center justify-center gap-6 px-4 pt-safe pb-safe">
      <Button variant="secondary" size="sm" className="absolute top-safe left-4" render={<Link to="/" />}><ArrowLeft />Library</Button>
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <SongArtwork id={song.id} />
        <h1 className="text-2xl font-semibold">{song.title}</h1>
        {song.status === "failed" ? (
          <>
            <p role="alert" className="text-destructive">{song.error ?? "Processing failed."}</p>
            <Button size="lg" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ id: song.id, model: song.model })}><RefreshCw />Retry processing</Button>
          </>
        ) : (
          <Progress value={song.status === "processing" ? song.progress : null} className="w-full" aria-label="Processing progress">
            <div className="flex w-full items-center justify-between text-sm">
              <ProcessingLine song={song} />
              <span className="text-muted-foreground tabular-nums">{song.status === "processing" ? `${song.progress}%` : ""}</span>
            </div>
          </Progress>
        )}
        {song.status !== "failed" && <p className="text-sm text-muted-foreground">This page updates on its own. You can leave and come back.</p>}
      </div>
    </div>
  )
}
