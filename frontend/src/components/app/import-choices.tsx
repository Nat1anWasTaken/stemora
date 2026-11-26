import { useState } from "react"
import { AlertTriangle, ExternalLink, ListPlus } from "lucide-react"
import { ResponsiveDialog } from "@/components/app/responsive-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { LinkEntry, LinkMatch, ResolvedLink } from "@/lib/api"
import { formatClock } from "@/lib/format"

/** A YouTube upload this much longer or shorter than the song is probably another version (an intro, a live take). */
const DURATION_WARN_S = 15

function joinDetails(parts: (string | null | undefined | false)[]) {
  return parts.filter(Boolean).join(" · ")
}

function lengthDiff(song: number | null, match: number | null): string | null {
  if (song === null || match === null) return null
  const d = Math.round(match - song)
  if (Math.abs(d) <= DURATION_WARN_S) return null
  return `${formatClock(Math.abs(d))} ${d > 0 ? "longer" : "shorter"} than the song`
}

/**
 * "Is this the song?" for a Spotify track: Spotify cannot be downloaded, so the user picks which YouTube Music or
 * YouTube upload to import. The best match is preselected; each can be opened to check it.
 */
export function MatchDialog({ resolved, onDone }: { resolved: ResolvedLink; onDone: (match: LinkMatch | null) => void }) {
  const matches = resolved.matches ?? []
  const [picked, setPicked] = useState(0)
  const song = resolved.entries[0]
  const songLength = song?.duration_s ?? null
  const unsure = matches.length > 0 && matches[0].score < 0.5

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => { if (!o) onDone(null) }}
      title="Is this the song?"
      description={
        <>
          <span className="font-medium text-foreground">{resolved.title ?? "Untitled"}</span>
          {" "}
          {joinDetails([resolved.subtitle && `by ${resolved.subtitle}`, songLength !== null && formatClock(songLength), "on Spotify"])}
          . Spotify songs are downloaded from YouTube, so pick the matching upload.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onDone(null)}>Cancel</Button>
          <Button disabled={matches.length === 0} onClick={() => onDone(matches[picked] ?? null)}><ListPlus />Add to queue</Button>
        </>
      }
    >
      {matches.length === 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Nothing on YouTube Music or YouTube looks like this song. Paste a YouTube link to it instead.
        </p>
      )}
      {unsure && (
        <p className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          None of these is a close match. Open them to check before adding one.
        </p>
      )}
      <div role="radiogroup" aria-label="YouTube uploads" className="flex flex-col gap-2">
        {matches.map((m, i) => {
          const diff = lengthDiff(songLength, m.duration_s)
          return (
            <label key={m.url} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 hover:bg-muted has-checked:border-primary has-checked:bg-primary/10">
              <input type="radio" name="match" className="size-4 shrink-0 accent-primary" checked={picked === i} onChange={() => setPicked(i)} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium break-words">{m.title}</span>
                <span className="text-xs text-muted-foreground">{joinDetails([m.channel, m.duration_s !== null && formatClock(m.duration_s)])}</span>
                {(i === 0 || m.music || diff) && (
                  <span className="flex flex-wrap gap-1">
                    {i === 0 && !unsure && <Badge variant="soft">Best match</Badge>}
                    {m.music && <Badge variant="secondary">YouTube Music</Badge>}
                    {diff && <Badge variant="warning">{diff}</Badge>}
                  </span>
                )}
              </span>
              <Button variant="ghost" size="icon" aria-label={`Open ${m.title} on YouTube`} render={<a href={m.url} target="_blank" rel="noreferrer" />}>
                <ExternalLink />
              </Button>
            </label>
          )
        })}
      </div>
    </ResponsiveDialog>
  )
}

/** Choose which songs of a playlist or album to add; all that can be imported start selected. */
export function CollectionDialog({ resolved, onDone }: { resolved: ResolvedLink; onDone: (entries: LinkEntry[] | null) => void }) {
  const entries = resolved.entries
  const importable = entries.flatMap((e, i) => (e.problem ? [] : [i]))
  const [selected, setSelected] = useState(() => new Set(importable))
  const all = selected.size === importable.length && importable.length > 0
  const toggle = (i: number) => setSelected((cur) => {
    const next = new Set(cur)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })
  const spotify = resolved.site === "Spotify"
  const count = `${entries.length} ${entries.length === 1 ? "song" : "songs"}`

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => { if (!o) onDone(null) }}
      title="Choose songs to import"
      description={
        <>
          <span className="font-medium text-foreground">{resolved.title ?? "Playlist"}</span>
          {" "}
          {joinDetails([resolved.subtitle && `by ${resolved.subtitle}`, resolved.site && `on ${resolved.site}`, count])}
          {spotify && ". Each song is found on YouTube Music or YouTube when it is imported."}
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onDone(null)}>Cancel</Button>
          <Button disabled={selected.size === 0} onClick={() => onDone(entries.filter((_, i) => selected.has(i)))}>
            <ListPlus />
            {selected.size === 1 ? "Add 1 song to queue" : `Add ${selected.size} songs to queue`}
          </Button>
        </>
      }
    >
      <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-muted">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          checked={all}
          ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !all }}
          disabled={importable.length === 0}
          onChange={() => setSelected(all ? new Set() : new Set(importable))}
        />
        <span className="flex-1 font-medium">Select all</span>
        <span className="text-xs text-muted-foreground tabular-nums">{selected.size} of {importable.length}</span>
      </label>
      <ul className="flex flex-col">
        {entries.map((e, i) => (
          <li key={`${i}-${e.url}`}>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted has-disabled:cursor-default has-disabled:opacity-60 has-disabled:hover:bg-transparent">
              <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selected.has(i)} disabled={!!e.problem} onChange={() => toggle(i)} />
              <span className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{e.title ?? e.url}</span>
                <span className="truncate text-xs text-muted-foreground">{joinDetails([e.artists.join(", "), e.duration_s !== null && formatClock(e.duration_s)])}</span>
                {e.problem && <span className="text-xs text-destructive">{e.problem}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </ResponsiveDialog>
  )
}
