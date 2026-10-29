import { useCallback, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent } from "react"
import { Link } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Ban, CheckCircle2, FileAudio, Link2, Loader2, RefreshCw, Search, UploadCloud, X } from "lucide-react"
import { ProcessingLine } from "@/components/app/song-bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { api, HQ_MODEL, progressValue, type LinkPreview, type Model, type Song } from "@/lib/api"
import { formatBytes, formatClock, titleFromFilename } from "@/lib/format"
import { keys, useSongActions, useSongsById } from "@/lib/queries"
import { UploadController } from "@/lib/upload"
import { cn } from "@/lib/utils"

/** A link import started on this page, followed live. */
function ImportRow({ song }: { song: Song }) {
  const { cancelImport } = useSongActions()
  const importing = song.status === "importing"
  return (
    <li className="flex flex-col gap-2 rounded-xl bg-secondary p-3">
      <div className="flex items-center gap-2">
        {song.status === "failed" ? <AlertTriangle className="size-4 shrink-0 text-destructive" /> : importing ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <CheckCircle2 className="size-4 shrink-0 text-success" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{song.title}</span>
        {importing && (
          <Button size="sm" variant="ghost" disabled={cancelImport.isPending} onClick={() => cancelImport.mutate(song)}><Ban />Cancel</Button>
        )}
      </div>
      {importing && (
        <Progress value={progressValue(song)} aria-label="Import progress">
          <ProcessingLine song={song} />
        </Progress>
      )}
      {song.status === "failed" && <p role="alert" className="text-sm text-destructive">{song.error ?? "The import failed."}</p>}
      {!importing && song.status !== "failed" && <p className="text-sm text-success">Downloaded. Separation has started.</p>}
    </li>
  )
}

function LinkImport({ model, onImported }: { model: Model; onImported: () => void }) {
  const [url, setUrl] = useState("")
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The looked-up link, kept only while the input still holds it. */
  const [preview, setPreview] = useState<{ url: string; info: LinkPreview } | null>(null)
  const [title, setTitle] = useState("")
  const [started, setStarted] = useState<string[]>([])
  const startedSongs = useSongsById(started)

  const link = url.trim()
  const current = preview?.url === link ? preview.info : null

  const check = async (e: FormEvent) => {
    e.preventDefault()
    if (!link || checking) return
    setChecking(true)
    setError(null)
    setPreview(null)
    try {
      const info = await api.previewLink(link)
      setPreview({ url: link, info })
      setTitle(info.title ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the link")
    } finally {
      setChecking(false)
    }
  }

  const start = async () => {
    if (!current || starting) return
    setStarting(true)
    setError(null)
    try {
      const t = title.trim()
      const song = await api.importSong({ url: link, title: t && t !== current.title ? t : undefined, model })
      setStarted((cur) => [song.id, ...cur])
      setUrl("")
      setPreview(null)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the import")
    } finally {
      setStarting(false)
    }
  }

  const meta = current
    ? [current.uploader, current.site, current.duration_s !== null ? formatClock(current.duration_s) : null, current.filesize ? `about ${formatBytes(current.filesize)}` : null].filter(Boolean).join(" · ")
    : ""

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <form onSubmit={check} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="link">Import from a link</Label>
          <p className="text-sm text-muted-foreground">Paste a YouTube, SoundCloud or other link. Check it first, then the server downloads the audio for you.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="link"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="h-11 flex-1"
          />
          <Button type="submit" size="lg" variant="secondary" disabled={checking || !link || current !== null}>
            {checking ? <Loader2 className="animate-spin" /> : <Search />}
            {checking ? "Checking" : "Check link"}
          </Button>
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {current && (
        <div className="flex animate-page flex-col gap-3 rounded-xl bg-secondary p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-title">Title</Label>
            <Input id="link-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={link} maxLength={200} className="h-10" />
            {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
          </div>
          {current.problem ? (
            <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {current.problem}
            </p>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1" disabled={starting} onClick={() => void start()}>
                {starting ? <Loader2 className="animate-spin" /> : <Link2 />}
                Import
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            </div>
          )}
        </div>
      )}

      {startedSongs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {startedSongs.map((s) => <ImportRow key={s.id} song={s} />)}
        </ul>
      )}
    </div>
  )
}

type Item = { id: string; file: File; title: string; ctrl: UploadController | null }

const isAudio = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?)$/i.test(f.name)

function ItemRow({ item, onTitle, onRemove, onRetry }: { item: Item; onTitle: (t: string) => void; onRemove: () => void; onRetry: () => void }) {
  const ctrl = item.ctrl
  const state = useSyncExternalStore(
    (cb) => (ctrl ? ctrl.subscribe(cb) : () => {}),
    () => ctrl?.state ?? null,
  )
  const phase = state?.phase ?? "idle"
  const pct = state && state.total > 0 ? Math.round((state.loaded / state.total) * 100) : 0
  const failedParts = state?.parts.filter((p) => p.status === "failed").length ?? 0
  const doneParts = state?.parts.filter((p) => p.status === "done").length ?? 0

  return (
    <li className="surface-soft animate-page flex flex-col gap-3 rounded-2xl border border-border p-3">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
          {phase === "done" ? <CheckCircle2 className="text-success" /> : phase === "error" ? <AlertTriangle className="text-destructive" /> : <FileAudio />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {phase === "idle" ? (
            <Input value={item.title} onChange={(e) => onTitle(e.target.value)} aria-label="Song title" maxLength={200} className="h-10" />
          ) : (
            <span className="truncate font-medium">{item.title}</span>
          )}
          <span className="truncate text-xs text-muted-foreground">{item.file.name} · {formatBytes(item.file.size)}</span>
        </div>
        {(phase === "idle" || phase === "error" || phase === "done") && (
          <Button variant="ghost" size="icon-lg" onClick={onRemove} aria-label={`Remove ${item.title}`}><X /></Button>
        )}
      </div>

      {(phase === "creating" || phase === "uploading" || phase === "completing") && (
        <Progress value={phase === "uploading" ? pct : null} aria-label="Upload progress">
          <span className="flex w-full items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />{phase === "creating" ? "Preparing" : phase === "completing" ? "Finishing up" : "Uploading"}</span>
            <span>{state && state.parts.length > 1 ? `part ${doneParts}/${state.parts.length} · ` : ""}{pct}%</span>
          </span>
        </Progress>
      )}
      {phase === "done" && (
        <p className="flex animate-in items-center justify-between text-sm text-success fade-in">
          <span>Uploaded. Separation has started.</span>
        </p>
      )}
      {phase === "error" && (
        <div className="flex animate-in items-center justify-between gap-3 fade-in">
          <p role="alert" className="text-sm text-destructive">
            {state?.error}
            {failedParts > 0 && ` (${failedParts} ${failedParts === 1 ? "part" : "parts"} to retry)`}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetry}><RefreshCw />Retry</Button>
        </div>
      )}
    </li>
  )
}

export function UploadPage() {
  const qc = useQueryClient()
  const [items, setItems] = useState<Item[]>([])
  const [hq, setHq] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [anyDone, setAnyDone] = useState(false)
  const [rejected, setRejected] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)

  const add = useCallback((files: FileList | File[]) => {
    const all = Array.from(files)
    const ok = all.filter(isAudio)
    setRejected(all.filter((f) => !isAudio(f)).map((f) => f.name))
    setItems((cur) => [...cur, ...ok.map((file) => ({ id: crypto.randomUUID(), file, title: titleFromFilename(file.name), ctrl: null }))])
  }, [])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    add(e.dataTransfer.files)
  }

  const pending = items.filter((i) => !i.ctrl)
  const startAll = () => {
    const model: Model = hq ? HQ_MODEL : "htdemucs"
    const started = items.map((it) => {
      if (it.ctrl) return it
      const ctrl = new UploadController(it.file, it.title.trim() || titleFromFilename(it.file.name), model)
      ctrl.subscribe(() => {
        if (ctrl.state.phase === "done") {
          setAnyDone(true)
          void qc.invalidateQueries({ queryKey: keys.songs })
        }
      })
      void ctrl.start()
      return { ...it, ctrl }
    })
    setItems(started)
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold md:text-4xl">Upload</h1>
        <p className="text-muted-foreground">Add a track or paste a link. It is split into vocals, drums, bass and other.</p>
      </header>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn("pressable flex min-h-48 flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-input bg-surface px-6 py-10 text-center hover:border-primary/60", dragging && "drop-active")}
      >
        <span className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary"><UploadCloud className="size-7" /></span>
        <span className="flex flex-col gap-1">
          <span className="font-heading text-lg font-semibold">Choose audio files</span>
          <span className="text-sm text-muted-foreground">or drop them here. MP3, M4A, WAV, FLAC and more.</span>
        </span>
      </button>
      <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = "" }} />
      {rejected.length > 0 && <p role="alert" className="text-sm text-destructive">Skipped (not audio): {rejected.join(", ")}</p>}

      <LinkImport
        model={hq ? HQ_MODEL : "htdemucs"}
        onImported={() => {
          setAnyDone(true)
          void qc.invalidateQueries({ queryKey: keys.songs })
        }}
      />

      {items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              onTitle={(t) => setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, title: t } : x)))}
              onRemove={() => { it.ctrl?.cancel(); setItems((cur) => cur.filter((x) => x.id !== it.id)) }}
              onRetry={() => void it.ctrl?.retry()}
            />
          ))}
        </ul>
      )}

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="hq">High quality</Label>
          <p className="text-sm text-muted-foreground">Uses SCNet XL. Cleaner stems, especially vocals, but about 3x slower and costlier to separate.</p>
        </div>
        <Switch id="hq" checked={hq} onCheckedChange={setHq} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" className="flex-1" disabled={pending.length === 0} onClick={startAll}>
          <UploadCloud />
          {pending.length > 1 ? `Upload ${pending.length} songs` : "Upload song"}
        </Button>
        {anyDone && <Button size="lg" variant="secondary" render={<Link to="/" />}>Go to library</Button>}
      </div>
    </div>
  )
}
