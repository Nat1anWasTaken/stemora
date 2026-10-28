import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { Music2, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { ProcessingLine, SongArtwork, StatusBadge } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type { Song } from "@/lib/api"
import { formatBytes, formatClock, relativeTime } from "@/lib/format"
import { useSongActions, useSongs } from "@/lib/queries"

function SongCard({ song }: { song: Song }) {
  const nav = useNavigate()
  const { remove, rename, reprocess } = useSongActions()
  const [confirm, setConfirm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const ready = song.status === "ready"
  const working = song.status === "queued" || song.status === "processing" || song.status === "uploading"

  const entries: MenuEntry[] = [
    ...(ready ? [{ key: "open", label: "Open player", icon: <Play />, onSelect: () => nav(`/songs/${song.id}`) } as MenuEntry] : []),
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    ...(song.status === "failed" || ready
      ? [{ key: "hq", label: song.model === "htdemucs_ft" ? "Reprocess" : "Reprocess in high quality", icon: <Sparkles />, onSelect: () => reprocess.mutate({ id: song.id, model: "htdemucs_ft" }) } as MenuEntry]
      : []),
    { key: "sep", separator: true },
    { key: "delete", label: "Delete", icon: <Trash2 />, destructive: true, onSelect: () => setConfirm(true) },
  ]

  return (
    <li className="surface-soft relative flex flex-col gap-3 rounded-3xl border border-border p-3 transition-colors hover:border-primary/40">
      <div className="flex items-center gap-3">
        <SongArtwork id={song.id} dim={!ready} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {ready ? (
            <Link to={`/songs/${song.id}`} className="truncate font-heading text-base font-semibold after:absolute after:inset-0 after:rounded-3xl">
              {song.title}
            </Link>
          ) : (
            <span className="truncate font-heading text-base font-semibold">{song.title}</span>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <StatusBadge song={song} />
            {ready && song.duration_s !== null && <span>{formatClock(song.duration_s)}</span>}
            {ready && song.model === "htdemucs_ft" && <span>High quality</span>}
            <span>{relativeTime(song.created_at)}</span>
          </div>
        </div>
        <div className="relative z-10">
          <ActionMenu title={song.title} entries={entries} trigger={<Button variant="ghost" size="icon-lg" aria-label={`Actions for ${song.title}`}><MoreHorizontal /></Button>} />
        </div>
      </div>

      {working && (
        <Progress value={song.status === "processing" ? song.progress : null} aria-label="Processing progress">
          <ProcessingLine song={song} />
        </Progress>
      )}
      {song.status === "failed" && (
        <div className="relative z-10 flex flex-col gap-2">
          <p className="text-sm text-destructive">{song.error ?? "Processing failed."}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ id: song.id, model: song.model })}>
              <RefreshCw />Retry
            </Button>
          </div>
        </div>
      )}
      <RenameDialog open={renaming} onOpenChange={setRenaming} title={song.title} onRename={(t) => rename.mutate({ id: song.id, title: t })} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title="Delete this song?"
        description={`"${song.title}" and all of its stems will be removed permanently (${formatBytes(song.size_bytes)} of original audio).`}
        confirmLabel="Delete song"
        onConfirm={() => remove.mutate(song)}
      />
    </li>
  )
}

export function LibraryPage() {
  const { data: songs, isLoading, error } = useSongs()
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-8 pt-safe md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Library</h1>
          <p className="text-muted-foreground">{songs ? `${songs.length} ${songs.length === 1 ? "song" : "songs"}` : "Your separated songs"}</p>
        </div>
        <Button size="lg" className="hidden md:inline-flex" render={<Link to="/upload" />}><Plus />Upload song</Button>
      </header>

      {error && <p role="alert" className="text-destructive">{error.message}</p>}
      {isLoading && (
        <ul className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </ul>
      )}
      {songs && songs.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
          <Music2 className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">No songs yet</h2>
            <p className="max-w-xs text-muted-foreground">Upload a track and Stemora splits it into vocals, drums, bass and other so you can play along.</p>
          </div>
          <Button size="lg" render={<Link to="/upload" />}><Plus />Upload your first song</Button>
        </div>
      )}
      {songs && songs.length > 0 && (
        <ul className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {songs.map((s) => <SongCard key={s.id} song={s} />)}
        </ul>
      )}
    </div>
  )
}
