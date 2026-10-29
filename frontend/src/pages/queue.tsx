import { useSyncExternalStore, type ReactNode } from "react"
import { Link } from "react-router"
import { AlertTriangle, Ban, CheckCircle2, FileAudio, ListOrdered, Loader2, Play, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { ProcessingLine, SongArtwork, StatusBadge } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { isCancellable, isFailedImport, isHighQuality, isLinkImport, progressValue, retryModel, type Song } from "@/lib/api"
import { formatBytes, hostOf, relativeTime } from "@/lib/format"
import { useSongActions } from "@/lib/queries"
import { clearFinished, useQueue } from "@/lib/queue"
import { uploads, type LocalUpload } from "@/lib/uploads"

function Section({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {title} <span className="tabular-nums">· {count}</span>
        </h2>
        {action}
      </div>
      <ul className="stagger-children grid grid-cols-1 items-start gap-3 lg:grid-cols-2">{children}</ul>
    </section>
  )
}

function Row({ art, title, meta, actions, children }: { art: ReactNode; title: ReactNode; meta: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <li className="surface-soft flex flex-col gap-3 rounded-3xl border border-border p-3">
      <div className="flex items-center gap-3">
        {art}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate font-heading text-base font-semibold">{title}</span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{meta}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </li>
  )
}

/** A song the server is importing, separating, holding in line, or that finished or failed. */
function SongRow({ song }: { song: Song }) {
  const { remove, reprocess, reimport, cancel } = useSongActions()
  const pending = song.status === "pending"
  const running = song.status === "importing" || song.status === "queued" || song.status === "processing"
  const cancelLabel = song.status === "importing" || isLinkImport(song) ? "Cancel import" : "Remove from queue"

  const actions = (
    <>
      {isCancellable(song) && (
        <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(song)} aria-label={`${cancelLabel}: ${song.title}`}>
          <Ban />Cancel
        </Button>
      )}
      {song.status === "ready" && (
        <Button size="sm" variant="secondary" render={<Link to={`/songs/${song.id}`} />}><Play />Open</Button>
      )}
      {song.status === "failed" && (
        <>
          {isFailedImport(song) ? (
            <Button size="sm" variant="secondary" disabled={reimport.isPending} onClick={() => reimport.mutate(song)}><RefreshCw />Retry</Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ id: song.id, model: retryModel(song.model) })}><RefreshCw />Retry</Button>
          )}
          <Button size="icon-sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(song)} aria-label={`Delete ${song.title}`}><Trash2 /></Button>
        </>
      )}
    </>
  )

  return (
    <Row
      art={<SongArtwork id={song.id} dim={song.status !== "ready"} />}
      title={<Link to={`/songs/${song.id}`} className="hover:text-primary">{song.title}</Link>}
      meta={
        <>
          <StatusBadge song={song} />
          {song.source_url && <span className="max-w-40 truncate">{hostOf(song.source_url)}</span>}
          {song.status !== "pending" && isHighQuality(song.model) && <span>High quality</span>}
          <span>{relativeTime(song.created_at)}</span>
        </>
      }
      actions={actions}
    >
      {pending && <ProcessingLine song={song} />}
      {running && (
        <Progress value={progressValue(song)} aria-label={song.status === "importing" ? "Import progress" : "Processing progress"}>
          <ProcessingLine song={song} />
        </Progress>
      )}
      {song.status === "failed" && <p className="text-sm text-destructive">{song.error ?? "Processing failed."}</p>}
    </Row>
  )
}

/** A file this tab is sending to storage; it joins the server queue once stored. */
function UploadRow({ upload }: { upload: LocalUpload }) {
  const ctrl = upload.ctrl
  const state = useSyncExternalStore((cb) => ctrl.subscribe(cb), () => ctrl.state)
  const pct = state.total > 0 ? Math.round((state.loaded / state.total) * 100) : 0
  const doneParts = state.parts.filter((p) => p.status === "done").length
  const failedParts = state.parts.filter((p) => p.status === "failed").length
  const failed = state.phase === "error"
  return (
    <Row
      art={
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-secondary text-muted-foreground">
          {failed ? <AlertTriangle className="text-destructive" /> : <FileAudio />}
        </span>
      }
      title={upload.title}
      meta={<span className="truncate">{upload.fileName} · {formatBytes(upload.size)}</span>}
      actions={
        <>
          {failed && <Button size="sm" variant="secondary" onClick={() => uploads.retry(upload.id)}><RefreshCw />Retry</Button>}
          <Button size="icon-sm" variant="ghost" onClick={() => uploads.remove(upload.id)} aria-label={failed ? `Remove ${upload.title}` : `Stop uploading ${upload.title}`}><X /></Button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
          {failedParts > 0 && ` (${failedParts} ${failedParts === 1 ? "part" : "parts"} to retry)`}
        </p>
      ) : (
        <Progress value={state.phase === "uploading" ? pct : null} aria-label="Upload progress">
          <span className="flex w-full items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              {state.phase === "uploading" ? "Uploading from this device" : state.phase === "completing" ? "Finishing up" : "Preparing"}
            </span>
            <span className="tabular-nums">{state.parts.length > 1 ? `part ${doneParts}/${state.parts.length} · ` : ""}{pct}%</span>
          </span>
        </Progress>
      )}
    </Row>
  )
}

/** Still `uploading` on the server, but not from this tab. */
function ElsewhereRow({ song }: { song: Song }) {
  const { remove } = useSongActions()
  return (
    <Row
      art={<SongArtwork id={song.id} dim />}
      title={song.title}
      meta={<><StatusBadge song={song} /><span>{relativeTime(song.created_at)}</span></>}
      actions={<Button size="icon-sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(song)} aria-label={`Delete ${song.title}`}><Trash2 /></Button>}
    >
      <p className="text-xs text-muted-foreground">Being uploaded from another device or tab. If that upload stopped, delete it and upload the file again.</p>
    </Row>
  )
}

export function QueuePage() {
  const q = useQueue()
  const empty = q.count === 0 && q.uploads.length === 0 && q.elsewhere.length === 0 && q.failed.length === 0 && q.finished.length === 0

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 pt-page md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Queue</h1>
          <p className="text-muted-foreground">
            {q.count > 0 ? `${q.count} in progress or waiting. Songs start on their own as slots free up, even with the app closed.` : "Uploads, link imports and separations, on every device."}
          </p>
        </div>
        <Button size="lg" className="hidden md:inline-flex" render={<Link to="/upload" />}><Plus />Add songs</Button>
      </header>

      {q.error && <p role="alert" className="text-destructive">{q.error.message}</p>}
      {q.isLoading && (
        <ul className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-24" />)}
        </ul>
      )}

      {!q.isLoading && empty && (
        <div className="animate-page flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
          <ListOrdered className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">Nothing in the queue</h2>
            <p className="max-w-xs text-muted-foreground">Add files or paste links, and follow them here while they download and split into stems.</p>
          </div>
          <Button size="lg" render={<Link to="/upload" />}><Plus />Add songs</Button>
        </div>
      )}

      {(q.uploads.length > 0 || q.elsewhere.length > 0) && (
        <Section title="Uploading" count={q.uploads.length + q.elsewhere.length}>
          {q.uploads.map((u) => <UploadRow key={u.id} upload={u} />)}
          {q.elsewhere.map((s) => <ElsewhereRow key={s.id} song={s} />)}
        </Section>
      )}
      {q.running.length > 0 && (
        <Section title="In progress" count={q.running.length}>
          {q.running.map((s) => <SongRow key={s.id} song={s} />)}
        </Section>
      )}
      {q.waiting.length > 0 && (
        <Section title="Up next" count={q.waiting.length}>
          {q.waiting.map((s) => <SongRow key={s.id} song={s} />)}
        </Section>
      )}
      {q.failed.length > 0 && (
        <Section title="Failed" count={q.failed.length}>
          {q.failed.map((s) => <SongRow key={s.id} song={s} />)}
        </Section>
      )}
      {q.finished.length > 0 && (
        <Section
          title="Finished"
          count={q.finished.length}
          action={<Button size="sm" variant="ghost" onClick={() => clearFinished(q.finished)}><CheckCircle2 />Clear</Button>}
        >
          {q.finished.map((s) => <SongRow key={s.id} song={s} />)}
        </Section>
      )}
    </div>
  )
}
