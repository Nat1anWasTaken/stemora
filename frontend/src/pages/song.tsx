import { Link, useNavigate, useParams } from "react-router"
import { ArrowLeft, Ban, Link2, Loader2, RefreshCw } from "lucide-react"
import { ProcessingLine, SongArtwork } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useThemeColor } from "@/hooks/use-theme-color"
import { isFailedImport, progressValue } from "@/lib/api"
import { formatClock, hostOf } from "@/lib/format"
import { useSong, useSongActions } from "@/lib/queries"
import { Player } from "@/player/ui/player"

export function SongPage() {
  const { id = "" } = useParams()
  const nav = useNavigate()
  const { data, error, isLoading } = useSong(id)
  const { reprocess, reimport, cancelImport } = useSongActions()
  useThemeColor("--sheet-top")

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
  const importing = song.status === "importing"

  return (
    <div className="player-sheet animate-sheet-in flex min-h-app flex-col items-center justify-center gap-6 px-4 pt-safe pb-safe">
      <Button variant="secondary" size="sm" className="absolute top-safe left-4" render={<Link to="/" />}><ArrowLeft />Library</Button>
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <SongArtwork id={song.id} />
        <div className="flex flex-col items-center gap-1">
          <h1 className="text-2xl font-semibold">{song.title}</h1>
          {song.source_url && (
            <a href={song.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <Link2 className="size-4" />
              {hostOf(song.source_url)}
              {song.duration_s !== null && ` · ${formatClock(song.duration_s)}`}
            </a>
          )}
        </div>
        {song.status === "failed" ? (
          <>
            <p role="alert" className="text-destructive">{song.error ?? "Processing failed."}</p>
            {isFailedImport(song) ? (
              <Button size="lg" disabled={reimport.isPending} onClick={() => reimport.mutate(song, { onSuccess: (fresh) => nav(`/songs/${fresh.id}`, { replace: true }) })}><RefreshCw />Retry import</Button>
            ) : (
              <Button size="lg" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ id: song.id, model: song.model })}><RefreshCw />Retry processing</Button>
            )}
          </>
        ) : (
          <Progress value={progressValue(song)} className="w-full" aria-label={importing ? "Import progress" : "Processing progress"}>
            <div className="flex w-full items-center justify-between gap-3 text-sm">
              <ProcessingLine song={song} />
              <span className="text-muted-foreground tabular-nums">{progressValue(song) !== null ? `${song.progress}%` : ""}</span>
            </div>
          </Progress>
        )}
        {importing && (
          <Button variant="secondary" disabled={cancelImport.isPending} onClick={() => cancelImport.mutate(song)}><Ban />Cancel import</Button>
        )}
        {song.status !== "failed" && <p className="text-sm text-muted-foreground">This page updates on its own. You can leave and come back.</p>}
      </div>
    </div>
  )
}
