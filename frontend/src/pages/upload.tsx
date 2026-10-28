import { useCallback, useRef, useState, useSyncExternalStore, type DragEvent } from "react"
import { Link } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, FileAudio, Loader2, RefreshCw, UploadCloud, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import type { Model } from "@/lib/api"
import { formatBytes, titleFromFilename } from "@/lib/format"
import { keys } from "@/lib/queries"
import { UploadController } from "@/lib/upload"
import { cn } from "@/lib/utils"

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
    <li className="surface-soft flex flex-col gap-3 rounded-2xl border border-border p-3">
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
        <p className="flex items-center justify-between text-sm text-success">
          <span>Uploaded. Separation has started.</span>
        </p>
      )}
      {phase === "error" && (
        <div className="flex items-center justify-between gap-3">
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
    const model: Model = hq ? "htdemucs_ft" : "htdemucs"
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
        <p className="text-muted-foreground">Add a track. It is split into vocals, drums, bass and other.</p>
      </header>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn("flex min-h-48 flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-input bg-surface px-6 py-10 text-center transition-colors hover:border-primary/60", dragging && "drop-active")}
      >
        <span className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary"><UploadCloud className="size-7" /></span>
        <span className="flex flex-col gap-1">
          <span className="font-heading text-lg font-semibold">Choose audio files</span>
          <span className="text-sm text-muted-foreground">or drop them here. MP3, M4A, WAV, FLAC and more.</span>
        </span>
      </button>
      <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = "" }} />
      {rejected.length > 0 && <p role="alert" className="text-sm text-destructive">Skipped (not audio): {rejected.join(", ")}</p>}

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
          <p className="text-sm text-muted-foreground">Uses the fine-tuned model (htdemucs_ft). Cleaner stems, but roughly 4x slower and costlier to process.</p>
        </div>
        <Switch id="hq" checked={hq} onCheckedChange={setHq} disabled={pending.length === 0 && items.length > 0} />
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
