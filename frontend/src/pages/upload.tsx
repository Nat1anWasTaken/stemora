import { useCallback, useRef, useState, type DragEvent, type FormEvent } from "react"
import { Link, useNavigate } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { AlertTriangle, FileAudio, Link2, ListOrdered, Loader2, UploadCloud, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, HQ_MODEL, type Model } from "@/lib/api"
import { formatBytes, splitLinks, titleFromFilename } from "@/lib/format"
import { keys } from "@/lib/queries"
import { useQueue } from "@/lib/queue"
import { uploads } from "@/lib/uploads"
import { cn } from "@/lib/utils"

/** Paste one or more links; each is added to the server-side queue right away. */
function LinkImport({ model, onAdded }: { model: Model; onAdded: (n: number) => void }) {
  const [text, setText] = useState("")
  const [adding, setAdding] = useState(false)
  const [problems, setProblems] = useState<{ url: string; error: string }[]>([])
  const links = splitLinks(text)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (links.length === 0 || adding) return
    setAdding(true)
    setProblems([])
    const failed: { url: string; error: string }[] = []
    // One at a time, so they join the queue in the order they were pasted.
    for (const url of links) {
      try {
        await api.importSong({ url, model })
      } catch (err) {
        failed.push({ url, error: err instanceof Error ? err.message : "Could not add the link" })
      }
    }
    // Keep the links that were refused so they can be fixed and added again.
    setText(failed.map((f) => f.url).join("\n"))
    setProblems(failed)
    setAdding(false)
    if (failed.length < links.length) onAdded(links.length - failed.length)
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="links">Import from links</Label>
        <p className="text-sm text-muted-foreground">Paste YouTube, SoundCloud or other links, one per line. The server downloads them in turn, even if you close the app.</p>
      </div>
      <Textarea
        id="links"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder={"https://www.youtube.com/watch?v=...\nhttps://soundcloud.com/..."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={problems.length > 0 || undefined}
      />
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p.url} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-all">{p.url}: {p.error}</span>
            </li>
          ))}
        </ul>
      )}
      <Button type="submit" size="lg" variant="secondary" disabled={adding || links.length === 0}>
        {adding ? <Loader2 className="animate-spin" /> : <Link2 />}
        {links.length > 1 ? `Add ${links.length} links to queue` : "Add to queue"}
      </Button>
    </form>
  )
}

type Item = { id: string; file: File; title: string }

const isAudio = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?)$/i.test(f.name)

function ItemRow({ item, onTitle, onRemove }: { item: Item; onTitle: (t: string) => void; onRemove: () => void }) {
  return (
    <li className="surface-soft animate-page flex items-center gap-3 rounded-2xl border border-border p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><FileAudio /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input value={item.title} onChange={(e) => onTitle(e.target.value)} aria-label="Song title" maxLength={200} className="h-10" />
        <span className="truncate text-xs text-muted-foreground">{item.file.name} · {formatBytes(item.file.size)}</span>
      </div>
      <Button variant="ghost" size="icon-lg" onClick={onRemove} aria-label={`Remove ${item.title}`}><X /></Button>
    </li>
  )
}

export function UploadPage() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const { count: inQueue } = useQueue()
  const [items, setItems] = useState<Item[]>([])
  const [hq, setHq] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const model: Model = hq ? HQ_MODEL : "htdemucs"

  const add = useCallback((files: FileList | File[]) => {
    const all = Array.from(files)
    const ok = all.filter(isAudio)
    setRejected(all.filter((f) => !isAudio(f)).map((f) => f.name))
    setItems((cur) => [...cur, ...ok.map((file) => ({ id: crypto.randomUUID(), file, title: titleFromFilename(file.name) }))])
  }, [])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    add(e.dataTransfer.files)
  }

  const refresh = () => void qc.invalidateQueries({ queryKey: keys.songs })
  const added = (n: number) => {
    refresh()
    toast.success(`Added ${n} ${n === 1 ? "song" : "songs"} to the queue`, { action: { label: "View queue", onClick: () => nav("/queue") } })
  }

  const startAll = () => {
    uploads.start(items.map((it) => ({ file: it.file, title: it.title.trim() || titleFromFilename(it.file.name) })), model, refresh)
    added(items.length)
    setItems([])
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold md:text-4xl">Upload</h1>
        <p className="text-muted-foreground">Add tracks or paste links. Each is split into vocals, drums, bass and other.</p>
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

      {items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              onTitle={(t) => setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, title: t } : x)))}
              onRemove={() => setItems((cur) => cur.filter((x) => x.id !== it.id))}
            />
          ))}
        </ul>
      )}

      <LinkImport model={model} onAdded={added} />

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="hq">High quality</Label>
          <p className="text-sm text-muted-foreground">Uses SCNet XL. Cleaner stems, especially vocals, but about 3x slower and costlier to separate.</p>
        </div>
        <Switch id="hq" checked={hq} onCheckedChange={setHq} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" className="flex-1" disabled={items.length === 0} onClick={startAll}>
          <UploadCloud />
          {items.length > 1 ? `Upload ${items.length} songs` : "Upload song"}
        </Button>
        {inQueue > 0 && <Button size="lg" variant="secondary" render={<Link to="/queue" />}><ListOrdered />View queue ({inQueue})</Button>}
      </div>
    </div>
  )
}
