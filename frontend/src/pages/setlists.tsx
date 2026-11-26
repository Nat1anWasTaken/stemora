import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CloudDownload,
  CloudOff,
  ListMusic,
  Loader2,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { LibraryTabs } from "@/components/app/library-tabs"
import { SongArtwork } from "@/components/app/song-bits"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCommands } from "@/hooks/use-commands"
import { api, type Setlist, type SetlistDetail, type SetlistEntry, type SettingsSource, type Transition } from "@/lib/api"
import { formatClock } from "@/lib/format"
import { keys, useSetlist, useSetlistActions, useSetlists } from "@/lib/queries"
import { queryClient } from "@/lib/query-client"
import { cn } from "@/lib/utils"
import { isOfflineSetlist, offlineCount, removeSetlistOffline, saveSetlistOffline } from "@/player/offline"
import { defaultSettings, parseSettings } from "@/player/settings"
import { SOURCE_LABEL } from "@/player/ui/settings-source"
import { songDetail, upNext } from "@/player/up-next"

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
export const setlistSummary = (l: Setlist) => [plural(l.entry_count, "song"), l.duration_s ? formatClock(l.duration_s) : null].filter(Boolean).join(" · ")

const SOURCE_OPTIONS = (["setlist", "song", "listening"] as const).map((v) => ({ value: v, label: SOURCE_LABEL[v] }))
const TRANSITION_LABEL: Record<Transition, string> = { continue: "Play the next song", stop: "Wait for Play" }
const TRANSITION_OPTIONS = (["stop", "continue"] as const).map((v) => ({ value: v, label: TRANSITION_LABEL[v] }))

/** Starts the setlist (from entry `start`) in Up Next. */
async function playSetlist(id: string, start = 0, autoplay = false) {
  const d = queryClient.getQueryData<SetlistDetail>(keys.setlist(id)) ?? (await api.setlist(id))
  upNext.playSetlist(d, start, autoplay)
}

// --- The Setlists half of the Library ----------------------------------------------------------------------------------

function SetlistCard({ l }: { l: Setlist }) {
  const nav = useNavigate()
  const { remove, update } = useSetlistActions()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <li className="pressable relative">
      <div className="surface-soft relative flex items-center gap-3 rounded-3xl border border-border p-3 hover:border-primary/40">
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-secondary text-primary" aria-hidden><ListMusic className="size-6" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link to={`/setlists/${l.id}`} className="truncate font-heading text-base font-semibold after:absolute after:inset-0 after:rounded-3xl">{l.name}</Link>
          <span className="truncate text-xs text-muted-foreground">{setlistSummary(l)} · {SOURCE_LABEL[l.settings_source]}</span>
        </div>
        <div className="relative z-10">
          <ActionMenu
            title={l.name}
            entries={[
              { key: "play", label: "Play", icon: <Play />, disabled: l.entry_count === 0, onSelect: () => void playSetlist(l.id) },
              { key: "open", label: "Open", icon: <ListMusic />, onSelect: () => nav(`/setlists/${l.id}`) },
              { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
              { key: "sep", separator: true },
              { key: "delete", label: "Delete", icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(true) },
            ]}
            trigger={<Button variant="ghost" size="icon-lg" aria-label={`Actions for ${l.name}`}><MoreHorizontal /></Button>}
          />
        </div>
      </div>
      <RenameDialog open={renaming} onOpenChange={setRenaming} title={l.name} heading="Rename setlist" description="The name shown in your library and on stage." label="Setlist name" onRename={(name) => update.mutate({ id: l.id, name })} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} destructive title={`Delete "${l.name}"?`} description="The setlist and its settings are removed. The songs stay in your library." confirmLabel="Delete setlist" onConfirm={() => remove.mutate(l)} />
    </li>
  )
}

/** The Library's Setlists tab. */
export function SetlistsView() {
  const nav = useNavigate()
  const lists = useSetlists()
  const { create } = useSetlistActions()
  const [creating, setCreating] = useState(false)
  const n = lists.data?.length ?? 0
  const newSetlist = (
    <RenameDialog
      open={creating}
      onOpenChange={setCreating}
      title=""
      heading="New setlist"
      description="Add songs from the Library with Add to setlist."
      label="Setlist name"
      submit="Create"
      onRename={(name) => create.mutate({ name }, { onSuccess: (d) => nav(`/setlists/${d.setlist.id}`) })}
    />
  )
  useCommands(() => [{ id: "setlists.new", title: "New setlist", group: "Setlists", keywords: ["playlist", "create"], run: () => setCreating(true) }], "page")

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Library</h1>
          <p className="text-muted-foreground" aria-live="polite">{lists.data ? plural(n, "setlist") : "Your setlists"}</p>
        </div>
        <Button size="lg" onClick={() => setCreating(true)}><Plus />New setlist</Button>
      </header>
      <LibraryTabs />
      {lists.error && <p role="alert" className="text-destructive">{lists.error.message}</p>}
      {lists.isLoading && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>}
      {lists.data && n === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ListMusic className="size-8 text-muted-foreground" />
          <h2 className="text-xl font-semibold">No setlists yet</h2>
          <p className="max-w-sm text-muted-foreground">A setlist is an ordered list of songs to listen through or perform, each with its own settings for that set.</p>
          <Button onClick={() => setCreating(true)}><Plus />New setlist</Button>
        </div>
      )}
      {n > 0 && <ul className="stagger-children grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">{lists.data!.map((l) => <SetlistCard key={l.id} l={l} />)}</ul>}
      {newSetlist}
    </div>
  )
}

// --- One setlist -------------------------------------------------------------------------------------------------------

function EntryRow({ d, e, i }: { d: SetlistDetail; e: SetlistEntry; i: number }) {
  const { entries } = useSetlistActions()
  const [notes, setNotes] = useState(false)
  const list = d.entries
  const edits = () => list.map((x) => ({ id: x.id, transition: x.transition, notes: x.notes }))
  const save = (next: ReturnType<typeof edits>) => entries.mutate({ id: d.setlist.id, entries: next })
  const move = (by: -1 | 1) => {
    const next = edits()
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    save(next)
  }
  const patch = (p: Partial<{ transition: Transition | null; notes: string }>) => save(edits().map((x) => (x.id === e.id ? { ...x, ...p } : x)))
  const resetSettings = async () => {
    try {
      const song = await songDetail(e.song.id)
      const saved = (await api.setEntrySettings(d.setlist.id, e.id, song.settings ? parseSettings(song.settings) : defaultSettings())).settings
      queryClient.setQueryData<SetlistDetail>(keys.setlist(d.setlist.id), (x) => (x ? { ...x, entries: x.entries.map((y) => (y.id === e.id ? { ...y, settings: saved } : y)) } : x))
      toast.success(`"${e.song.title}" uses its song settings again`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reset the settings")
    }
  }
  const ready = e.song.status === "ready"
  const last = i === list.length - 1
  const own = e.transition !== null
  const after: Transition = e.transition ?? d.setlist.transition
  const menu: MenuEntry[] = [
    { key: "play", label: "Play from here", icon: <Play />, disabled: !ready, onSelect: () => upNext.playSetlist(d, i) },
    { key: "up", label: "Move up", icon: <ArrowUp />, disabled: i === 0, onSelect: () => move(-1) },
    { key: "down", label: "Move down", icon: <ArrowDown />, disabled: last, onSelect: () => move(1) },
    { key: "notes", label: e.notes ? "Edit notes" : "Add notes", icon: <NotebookPen />, onSelect: () => setNotes(true) },
    { key: "reset", label: "Use the song's settings again", icon: <RotateCcw />, onSelect: () => void resetSettings() },
    { key: "sep", separator: true },
    {
      key: "after",
      radio: {
        label: "After this song",
        value: e.transition ?? "default",
        onValueChange: (v) => patch({ transition: v === "default" ? null : (v as Transition) }),
        options: [{ value: "default", label: `Setlist default (${TRANSITION_LABEL[d.setlist.transition].toLowerCase()})` }, ...TRANSITION_OPTIONS],
      },
    },
    { key: "sep2", separator: true },
    { key: "remove", label: "Remove from setlist", icon: <X />, destructive: true, onSelect: () => save(edits().filter((x) => x.id !== e.id)) },
  ]
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2">
      <span className="w-6 shrink-0 text-center text-sm text-muted-foreground tabular-nums">{i + 1}</span>
      <SongArtwork id={e.song.id} size="xs" dim={!ready} />
      <button type="button" disabled={!ready} onClick={() => upNext.playSetlist(d, i)} className="pressable flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left">
        <span className="truncate text-sm font-semibold">{e.song.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[e.song.duration_s ? formatClock(e.song.duration_s) : null, e.notes || null, !ready ? "Not ready" : null].filter(Boolean).join(" · ")}
        </span>
      </button>
      {!last && own && <Badge variant="soft" className="hidden sm:inline-flex">{after === "continue" ? "Plays on" : "Waits"}</Badge>}
      <ActionMenu title={e.song.title} entries={menu} trigger={<Button variant="ghost" size="icon" aria-label={`Options for ${e.song.title}`}><MoreHorizontal /></Button>} />
      <RenameDialog
        open={notes}
        onOpenChange={setNotes}
        title={e.notes}
        heading="Notes"
        description="Shown under the song here and on stage: a capo, a cue, who starts."
        label="Notes"
        submit="Save notes"
        maxLength={1000}
        allowEmpty
        onRename={(t) => patch({ notes: t })}
      />
    </li>
  )
}

/** "Available offline": download the whole setlist, show progress, or remove the copy. */
function useOffline(d: SetlistDetail | undefined) {
  const [state, setState] = useState<{ kept: number; total: number; busy: boolean }>({ kept: 0, total: 0, busy: false })
  const id = d?.setlist.id
  useEffect(() => {
    if (!d) return
    let live = true
    void offlineCount(d).then((c) => live && setState((s) => ({ ...s, ...c })))
    return () => {
      live = false
    }
  }, [d])
  const marked = !!id && isOfflineSetlist(id)
  return {
    ...state,
    marked,
    complete: marked && state.total > 0 && state.kept === state.total,
    async save() {
      if (!d) return
      setState((s) => ({ ...s, busy: true }))
      try {
        await saveSetlistOffline(d, (kept, total) => setState({ kept, total, busy: true }))
        toast.success(`"${d.setlist.name}" is available offline`)
      } catch (e) {
        toast.error(e instanceof Error ? `Could not download: ${e.message}` : "Could not download the setlist")
      } finally {
        setState((s) => ({ ...s, busy: false }))
      }
    },
    async remove() {
      if (!id) return
      await removeSetlistOffline(id)
      if (d) setState({ ...(await offlineCount(d)), busy: false })
      toast.success("Removed the offline copy")
    },
  }
}

export function SetlistPage() {
  const { id = "" } = useParams()
  const nav = useNavigate()
  const { data: d, error, isLoading } = useSetlist(id)
  const { update, remove } = useSetlistActions()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const offline = useOffline(d)
  const playable = !!d && d.entries.some((e) => e.song.status === "ready")

  useCommands(() => d ? [
    { id: "setlist.play", title: `Play "${d.setlist.name}"`, group: "Setlist", keywords: ["start", "listen"], enabled: () => playable, run: () => upNext.playSetlist(d, 0) },
    { id: "setlist.perform", title: `Perform "${d.setlist.name}"`, group: "Setlist", keywords: ["stage", "live", "gig"], enabled: () => playable, run: () => nav(`/setlists/${d.setlist.id}/stage`) },
  ] : [], "page")

  if (isLoading) return <div className="grid min-h-app place-items-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
  if (error || !d) {
    return (
      <div className="mx-auto flex min-h-app max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Setlist not found</h1>
        <p className="text-muted-foreground">{error?.message ?? "It may have been deleted."}</p>
        <Button render={<Link to="/?tab=setlists" />}>Back to setlists</Button>
      </div>
    )
  }
  const l = d.setlist
  const menu: MenuEntry[] = [
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    { key: "source", radio: { label: "Play with", value: l.settings_source, onValueChange: (v) => update.mutate({ id: l.id, settings_source: v as SettingsSource }), options: SOURCE_OPTIONS } },
    { key: "transition", radio: { label: "After each song", value: l.transition, onValueChange: (v) => update.mutate({ id: l.id, transition: v as Transition }), options: TRANSITION_OPTIONS } },
    { key: "sep", separator: true },
    offline.marked
      ? { key: "offline", label: "Remove offline copy", icon: <CloudOff />, onSelect: () => void offline.remove() }
      : { key: "offline", label: "Make available offline", icon: <CloudDownload />, disabled: offline.busy || !playable, onSelect: () => void offline.save() },
    { key: "sep2", separator: true },
    { key: "delete", label: "Delete setlist", icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(true) },
  ]

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <Button variant="secondary" size="sm" className="self-start" render={<Link to="/?tab=setlists" />}><ArrowLeft />Setlists</Button>
      <header className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-3xl font-semibold md:text-4xl">{l.name}</h1>
            <p className="text-muted-foreground">{setlistSummary(l)} · {SOURCE_LABEL[l.settings_source]} · {l.transition === "continue" ? "Plays straight through" : "Waits between songs"}</p>
            {(offline.busy || offline.marked) && (
              <p className={cn("flex items-center gap-1.5 text-sm", offline.complete ? "text-success" : "text-muted-foreground")} aria-live="polite">
                {offline.busy ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
                {offline.busy ? `Downloading ${offline.kept} of ${offline.total}` : offline.complete ? "Available offline" : `${offline.kept} of ${offline.total} songs offline`}
              </p>
            )}
          </div>
          <ActionMenu title={l.name} entries={menu} trigger={<Button variant="secondary" size="icon-lg" aria-label="Setlist options"><MoreHorizontal /></Button>} />
        </div>
        <div className="flex gap-2">
          <Button size="lg" disabled={!playable} onClick={() => upNext.playSetlist(d, 0)}><Play />Play</Button>
          <Button size="lg" variant="secondary" disabled={!playable} render={<Link to={`/setlists/${l.id}/stage`} />}><ListMusic />Perform</Button>
        </div>
      </header>
      {d.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="max-w-sm text-muted-foreground">No songs yet. In the Library, open a song's menu and choose Add to setlist.</p>
          <Button variant="secondary" render={<Link to="/" />}>Go to the Library</Button>
        </div>
      ) : (
        <ol className="flex flex-col gap-2">{d.entries.map((e, i) => <EntryRow key={e.id} d={d} e={e} i={i} />)}</ol>
      )}
      <RenameDialog open={renaming} onOpenChange={setRenaming} title={l.name} heading="Rename setlist" description="The name shown in your library and on stage." label="Setlist name" onRename={(name) => update.mutate({ id: l.id, name })} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete "${l.name}"?`}
        description="The setlist and its settings are removed. The songs stay in your library."
        confirmLabel="Delete setlist"
        onConfirm={() => remove.mutate(l, { onSuccess: () => nav("/?tab=setlists", { replace: true }) })}
      />
    </div>
  )
}
