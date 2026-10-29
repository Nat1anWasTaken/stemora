import { useSyncExternalStore } from "react"
import type { Song } from "@/lib/api"
import { useSongs } from "@/lib/queries"
import { isTransferring, useUploads, type LocalUpload } from "@/lib/uploads"

/**
 * Everything in flight for the user, built from the server's song list (the queue itself lives
 * on the server, so it is the same on every device) plus the file transfers running in this tab.
 */
export type QueueView = {
  /** Importing, waiting for a GPU or being separated; oldest first. */
  running: Song[]
  /** `pending` songs in queue order. */
  waiting: Song[]
  /** File transfers in this tab. */
  uploads: LocalUpload[]
  /** Songs still `uploading` that this tab is not sending (another device or a closed tab). */
  elsewhere: Song[]
  /** Newest first. */
  failed: Song[]
  /** Songs this device saw in the queue that are now ready, newest first. */
  finished: Song[]
  /** What the nav badge shows: running, waiting and this tab's live transfers. */
  count: number
}

const oldestFirst = (a: Song, b: Song) => a.created_at.localeCompare(b.created_at)

export function buildQueue(songs: Song[], local: LocalUpload[], seen: ReadonlySet<string>): QueueView {
  const sending = new Set(local.map((u) => u.ctrl.state.songId).filter((id): id is string => id !== null))
  const running = songs.filter((s) => s.status === "importing" || s.status === "queued" || s.status === "processing").sort(oldestFirst)
  const waiting = songs
    .filter((s) => s.status === "pending")
    .sort((a, b) => (a.queue_position ?? Infinity) - (b.queue_position ?? Infinity) || oldestFirst(a, b))
  const elsewhere = songs.filter((s) => s.status === "uploading" && !sending.has(s.id))
  const failed = songs.filter((s) => s.status === "failed")
  const finished = songs.filter((s) => s.status === "ready" && seen.has(s.id))
  const live = local.filter((u) => isTransferring(u.ctrl.state)).length
  return { running, waiting, uploads: local, elsewhere, failed, finished, count: running.length + waiting.length + live }
}

/**
 * Ids of songs seen running or waiting while the app was open, so the queue can list them as
 * finished afterwards (per tab; cleared with "Clear").
 */
let seen = new Set<string>()
const seenListeners = new Set<() => void>()
const setSeen = (next: Set<string>) => {
  seen = next
  seenListeners.forEach((l) => l())
}
const subscribeSeen = (fn: () => void) => {
  seenListeners.add(fn)
  return () => {
    seenListeners.delete(fn)
  }
}

/** Record songs that are in flight now; returns the new set, or the same one if nothing changed. */
export function trackSeen(current: ReadonlySet<string>, songs: Song[]): ReadonlySet<string> {
  const fresh = songs.filter((s) => s.status !== "ready" && s.status !== "failed" && !current.has(s.id))
  return fresh.length === 0 ? current : new Set([...current, ...fresh.map((s) => s.id)])
}

export const clearFinished = (songs: Song[]) => {
  const done = new Set(songs.filter((s) => s.status === "ready").map((s) => s.id))
  setSeen(new Set([...seen].filter((id) => !done.has(id))))
}

export function useQueue(): QueueView & { isLoading: boolean; error: Error | null } {
  const { data: songs = [], isLoading, error } = useSongs()
  const local = useUploads()
  const tracked = useSyncExternalStore(subscribeSeen, () => seen)
  const next = trackSeen(tracked, songs)
  // Remember new ones after render; this render already uses `next`.
  if (next !== tracked) queueMicrotask(() => setSeen(new Set([...seen, ...next])))
  return { ...buildQueue(songs, local, next), isLoading, error }
}
