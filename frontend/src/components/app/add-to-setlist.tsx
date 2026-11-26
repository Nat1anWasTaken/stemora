import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { ListMusic, Loader2, Plus } from "lucide-react"
import { ResponsiveDialog } from "@/components/app/responsive-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { SongRef } from "@/player/up-next"
import { useSetlistActions, useSetlists } from "@/lib/queries"

/** Adds songs to a setlist the user picks, or to a new one named here. */
export function AddToSetlistDialog({ songs, open, onOpenChange }: { songs: SongRef[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate()
  const lists = useSetlists()
  const { add, create } = useSetlistActions()
  const [name, setName] = useState("")
  const ids = songs.map((s) => s.id)
  const what = songs.length === 1 ? `"${songs[0].title}"` : `${songs.length} songs`
  const done = (id: string, listName: string) => {
    onOpenChange(false)
    setName("")
    toast.success(`Added ${what} to "${listName}"`, { action: { label: "Open", onClick: () => nav(`/setlists/${id}`) } })
  }
  const busy = add.isPending || create.isPending

  return (
    <ResponsiveDialog
      title="Add to setlist"
      description={`Adds ${what} with a copy of ${songs.length === 1 ? "its" : "their"} current settings.`}
      open={open}
      onOpenChange={onOpenChange}
      footer={<Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>}
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const n = name.trim()
          if (n) create.mutate({ name: n, song_ids: ids }, { onSuccess: (d) => done(d.setlist.id, d.setlist.name) })
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New setlist name" maxLength={200} aria-label="New setlist name" className="flex-1" />
        <Button type="submit" disabled={!name.trim() || busy}><Plus />Create</Button>
      </form>
      {lists.isLoading && <Loader2 className="mx-auto my-4 animate-spin text-muted-foreground" />}
      {lists.data?.map((l) => (
        <Button key={l.id} variant="cell" size="cell" disabled={busy} onClick={() => add.mutate({ id: l.id, songIds: ids }, { onSuccess: () => done(l.id, l.name) })}>
          <span className="flex items-center gap-2 font-semibold"><ListMusic className="size-4" />{l.name}</span>
          <span className="text-xs text-muted-foreground">{l.entry_count} {l.entry_count === 1 ? "song" : "songs"}</span>
        </Button>
      ))}
    </ResponsiveDialog>
  )
}
