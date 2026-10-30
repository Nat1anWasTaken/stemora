import { useRef, useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { Ban, MoreHorizontal, Pencil, Play, RefreshCw, Sparkles, Trash2 } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { ProcessingLine, SongArtwork, StatusBadge } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { HQ_MODEL, isActive, isCancellable, isFailedImport, isHighQuality, isLinkImport, progressValue, retryModel, type Song } from "@/lib/api"
import { formatBytes, formatClock, hostOf, relativeTime } from "@/lib/format"
import { useSwipeAction } from "@/hooks/use-swipe-action"
import { useSongActions } from "@/lib/queries"
import { cn } from "@/lib/utils"

export type LibraryView = "grid" | "list"

/** A library song as a grid card or a compact list row, with its menu, swipe-to-delete and dialogs. */
export function SongItem({ song, view }: { song: Song; view: LibraryView }) {
  const nav = useNavigate()
  const { remove, rename, reprocess, reimport, cancel } = useSongActions()
  const [confirm, setConfirm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const ready = song.status === "ready"
  const working = isActive(song)
  const failedImport = isFailedImport(song)
  const importing = song.status === "importing"
  const pending = song.status === "pending"
  const cancelLabel = importing || isLinkImport(song) ? "Cancel import" : "Remove from queue"
  const row = useRef<HTMLDivElement>(null)
  const swipe = useSwipeAction(row, { reveal: 96, onFullSwipe: () => setConfirm(true) })
  const list = view === "list"

  const failed = song.status === "failed"
  const retry = failedImport ? () => reimport.mutate(song) : () => reprocess.mutate({ id: song.id, model: retryModel(song.model) })
  const entries: MenuEntry[] = [
    ...(failed && !list ? [{ key: "retry", label: failedImport ? "Retry import" : "Retry", icon: <RefreshCw />, onSelect: retry } as MenuEntry] : []),
    ...(isCancellable(song) ? [{ key: "cancel", label: cancelLabel, icon: <Ban />, onSelect: () => cancel.mutate(song) } as MenuEntry] : []),
    ...(ready ? [{ key: "open", label: "Open player", icon: <Play />, onSelect: () => nav(`/songs/${song.id}`) } as MenuEntry] : []),
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    ...((failed && !failedImport) || ready
      ? [{ key: "hq", label: song.model === HQ_MODEL ? "Reprocess" : "Reprocess in high quality", icon: <Sparkles />, onSelect: () => reprocess.mutate({ id: song.id, model: HQ_MODEL }) } as MenuEntry]
      : []),
    { key: "sep", separator: true },
    { key: "delete", label: "Delete", icon: <Trash2 />, destructive: true, onSelect: () => setConfirm(true) },
  ]

  const title = ready ? (
    <Link to={`/songs/${song.id}`} className={cn("truncate font-heading font-semibold after:absolute after:inset-0", list ? "text-sm after:rounded-2xl md:text-base" : "text-base after:rounded-3xl")}>
      {song.title}
    </Link>
  ) : (
    <span className={cn("truncate font-heading font-semibold", list ? "text-sm md:text-base" : "text-base")}>{song.title}</span>
  )
  const duration = song.duration_s !== null && (ready || importing || pending) ? formatClock(song.duration_s) : null
  const menu = (
    <div className="relative z-10">
      <ActionMenu title={song.title} entries={entries} trigger={<Button variant="ghost" size={list ? "icon" : "icon-lg"} aria-label={`Actions for ${song.title}`}><MoreHorizontal /></Button>} />
    </div>
  )

  let details: ReactNode = null
  if (pending) {
    details = (
      <div className="flex items-center justify-between gap-3">
        <ProcessingLine song={song} />
        <Button size="sm" variant="ghost" className="relative z-10" disabled={cancel.isPending} onClick={() => cancel.mutate(song)}>
          Cancel
        </Button>
      </div>
    )
  } else if (working) {
    details = (
      <Progress value={progressValue(song)} aria-label={importing ? "Import progress" : "Processing progress"}>
        <div className="flex w-full items-center justify-between gap-3">
          <ProcessingLine song={song} />
          {importing && (
            <Button size="sm" variant="ghost" className="relative z-10" disabled={cancel.isPending} onClick={() => cancel.mutate(song)}>
              Cancel
            </Button>
          )}
        </div>
      </Progress>
    )
  } else if (failed) {
    details = (
      <div className="relative z-10 flex flex-col gap-2">
        <p className="text-sm text-destructive">{song.error ?? "Processing failed."}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={reimport.isPending || reprocess.isPending} onClick={retry}>
            <RefreshCw />{failedImport ? "Retry import" : "Retry"}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <li className="pressable relative">
      <div className={cn("absolute inset-0.5 flex justify-end bg-destructive/20", list ? "rounded-2xl" : "rounded-3xl")} aria-hidden={!swipe.open}>
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
      {list ? (
        <div ref={row} className="surface-soft swipe-row relative flex flex-col gap-2 rounded-2xl border border-border px-3 py-2 hover:border-primary/40">
          <div className="flex items-center gap-3">
            <SongArtwork id={song.id} dim={!ready} size="sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {title}
              <div className="flex items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                <StatusBadge song={song} />
                {ready && isHighQuality(song.model) && <span className="hidden md:inline">High quality</span>}
                {(importing || pending) && song.source_url && <span className="truncate">{hostOf(song.source_url)}</span>}
                <span className="truncate md:hidden">{[duration, relativeTime(song.created_at)].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
            <span className="hidden w-14 shrink-0 text-right text-sm text-muted-foreground tabular-nums md:block">{duration ?? "–"}</span>
            <span className="hidden w-28 shrink-0 text-right text-sm text-muted-foreground md:block">{relativeTime(song.created_at)}</span>
            {menu}
          </div>
          {details}
        </div>
      ) : (
        <div ref={row} className="surface-soft swipe-row relative flex flex-col gap-3 rounded-3xl border border-border p-3 hover:border-primary/40">
          <div className="flex items-center gap-3">
            <SongArtwork id={song.id} dim={!ready} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {title}
              <div className="flex items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                <StatusBadge song={song} />
                {duration && <span className="tabular-nums">{duration}</span>}
                {ready && isHighQuality(song.model) && <span className="truncate">High quality</span>}
                {(importing || pending) && song.source_url && <span className="truncate">{hostOf(song.source_url)}</span>}
              </div>
              <div className="flex items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                {working ? (
                  <ProcessingLine song={song} className="min-w-0 flex-nowrap truncate" />
                ) : failed ? (
                  <span className="truncate text-destructive" title={song.error ?? undefined}>{song.error ?? "Processing failed."}</span>
                ) : (
                  <span className="shrink-0">{relativeTime(song.created_at)}</span>
                )}
              </div>
            </div>
            {menu}
          </div>
          {/* Grid cards keep one height in every state so rows stay aligned: status and errors sit in
              the meta rows, progress hugs the bottom edge, and cancel/retry live in the menu. */}
          {working && !pending && (
            <Progress value={progressValue(song)} aria-label={importing ? "Import progress" : "Processing progress"} className="absolute inset-x-6 bottom-1.5" />
          )}
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
