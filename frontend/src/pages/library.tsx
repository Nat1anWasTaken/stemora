import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { Ban, Music2, MoreHorizontal, Pencil, Play, Plus, RefreshCw, RotateCw, Sparkles, Trash2 } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { ProcessingLine, SongArtwork, StatusBadge } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { HQ_MODEL, isActive, isFailedImport, isHighQuality, progressValue, retryModel, type Song } from "@/lib/api"
import { formatBytes, formatClock, hostOf, relativeTime } from "@/lib/format"
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh"
import { useSwipeAction } from "@/hooks/use-swipe-action"
import { useSongActions, useSongs } from "@/lib/queries"

function SongCard({ song }: { song: Song }) {
  const nav = useNavigate()
  const { remove, rename, reprocess, reimport, cancelImport } = useSongActions()
  const [confirm, setConfirm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const ready = song.status === "ready"
  const working = isActive(song)
  const failedImport = isFailedImport(song)
  const importing = song.status === "importing"
  const row = useRef<HTMLDivElement>(null)
  const swipe = useSwipeAction(row, { reveal: 96, onFullSwipe: () => setConfirm(true) })

  const entries: MenuEntry[] = [
    ...(importing ? [{ key: "cancel", label: "Cancel import", icon: <Ban />, onSelect: () => cancelImport.mutate(song) } as MenuEntry] : []),
    ...(ready ? [{ key: "open", label: "Open player", icon: <Play />, onSelect: () => nav(`/songs/${song.id}`) } as MenuEntry] : []),
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    ...((song.status === "failed" && !failedImport) || ready
      ? [{ key: "hq", label: song.model === HQ_MODEL ? "Reprocess" : "Reprocess in high quality", icon: <Sparkles />, onSelect: () => reprocess.mutate({ id: song.id, model: HQ_MODEL }) } as MenuEntry]
      : []),
    { key: "sep", separator: true },
    { key: "delete", label: "Delete", icon: <Trash2 />, destructive: true, onSelect: () => setConfirm(true) },
  ]

  return (
    <li className="pressable relative">
      <div className="absolute inset-0.5 flex justify-end rounded-3xl bg-destructive/20" aria-hidden={!swipe.open}>
        <button
          type="button"
          tabIndex={swipe.open ? 0 : -1}
          onClick={() => {
            swipe.close()
            setConfirm(true)
          }}
          className="flex w-24 flex-col items-center justify-center gap-1 text-xs font-medium text-destructive"
        >
          <Trash2 className="size-5" />Delete
        </button>
      </div>
      <div ref={row} className="surface-soft swipe-row relative flex flex-col gap-3 rounded-3xl border border-border p-3 hover:border-primary/40">
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
            {ready && isHighQuality(song.model) && <span>High quality</span>}
            {importing && song.source_url && <span className="max-w-40 truncate">{hostOf(song.source_url)}</span>}
            {importing && song.duration_s !== null && <span>{formatClock(song.duration_s)}</span>}
            <span>{relativeTime(song.created_at)}</span>
          </div>
        </div>
        <div className="relative z-10">
          <ActionMenu title={song.title} entries={entries} trigger={<Button variant="ghost" size="icon-lg" aria-label={`Actions for ${song.title}`}><MoreHorizontal /></Button>} />
        </div>
      </div>

      {working && (
        <Progress value={progressValue(song)} aria-label={importing ? "Import progress" : "Processing progress"}>
          <div className="flex w-full items-center justify-between gap-3">
            <ProcessingLine song={song} />
            {importing && (
              <Button size="sm" variant="ghost" className="relative z-10" disabled={cancelImport.isPending} onClick={() => cancelImport.mutate(song)}>
                Cancel
              </Button>
            )}
          </div>
        </Progress>
      )}
      {song.status === "failed" && (
        <div className="relative z-10 flex flex-col gap-2">
          <p className="text-sm text-destructive">{song.error ?? "Processing failed."}</p>
          <div className="flex gap-2">
            {failedImport ? (
              <Button size="sm" variant="secondary" disabled={reimport.isPending} onClick={() => reimport.mutate(song)}>
                <RefreshCw />Retry import
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ id: song.id, model: retryModel(song.model) })}>
                <RefreshCw />Retry
              </Button>
            )}
          </div>
        </div>
      )}
      </div>
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
  const { data: songs, isLoading, error, refetch } = useSongs()
  const pull = useRef<HTMLDivElement>(null)
  usePullToRefresh(pull, refetch)
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <div ref={pull} className="ptr-indicator pointer-events-none fixed inset-x-0 top-safe z-20 flex justify-center" aria-hidden>
        <span className="grid size-10 place-items-center rounded-full border border-border bg-popover text-primary shadow-lg">
          <RotateCw className="ptr-spin size-5" />
        </span>
      </div>
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Library</h1>
          <p className="text-muted-foreground">{songs ? `${songs.length} ${songs.length === 1 ? "song" : "songs"}` : "Your separated songs"}</p>
        </div>
        <Button size="lg" className="hidden md:inline-flex" render={<Link to="/upload" />}><Plus />Upload song</Button>
      </header>

      {error && <p role="alert" className="text-destructive">{error.message}</p>}
      {isLoading && (
        <ul className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </ul>
      )}
      {songs && songs.length === 0 && (
        <div className="animate-page flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
          <Music2 className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">No songs yet</h2>
            <p className="max-w-xs text-muted-foreground">Upload a track and Stemora splits it into vocals, drums, bass and other so you can play along.</p>
          </div>
          <Button size="lg" render={<Link to="/upload" />}><Plus />Upload your first song</Button>
        </div>
      )}
      {songs && songs.length > 0 && (
        <ul className="stagger-children grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {songs.map((s) => <SongCard key={s.id} song={s} />)}
        </ul>
      )}
    </div>
  )
}
