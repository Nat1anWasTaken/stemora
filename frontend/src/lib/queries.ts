import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { usePlayer } from "@/player/store"
import { api, ApiError, isActive, isLinkImport, retryModel, type EntryEdit, type Model, type Setlist, type SetlistDetail, type SettingsSource, type Song, type SongPage, type SongSort, type SongStatus, type Transition } from "@/lib/api"
import { offlineSetlist, removeSetlistOffline } from "@/player/offline"
import { useUpNext } from "@/player/up-next"

export const keys = {
  me: ["me"] as const,
  status: ["auth-status"] as const,
  songs: ["songs"] as const,
  song: (id: string) => ["song", id] as const,
  usage: ["usage"] as const,
  invites: ["invites"] as const,
  setlists: ["setlists"] as const,
  setlist: (id: string) => ["setlist", id] as const,
  listening: ["listening-settings"] as const,
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000, retry: false })
export const useUsage = () => useQuery({ queryKey: keys.usage, queryFn: api.usage, refetchInterval: 30_000 })

/** The library, a page at a time. Polls every 2s while any loaded song is still being processed. */
export const useLibrary = ({ q, sort }: { q: string; sort: SongSort }) =>
  useInfiniteQuery({
    queryKey: [...keys.songs, { q, sort }],
    queryFn: ({ pageParam }) => api.songs({ q, sort, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.next_cursor,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.songs.some(isActive)) ? 2000 : false),
  })

/** Follows a few songs by id, polling each every 2s while it is still being worked on (deleted ones drop out). */
export const useSongsById = (ids: string[]) =>
  useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.song(id),
      queryFn: () => api.song(id),
      retry: false,
      refetchInterval: (q: { state: { data?: { song: Song }; error: Error | null } }) =>
        q.state.error || (q.state.data && !isActive(q.state.data.song)) ? false : 2000,
    })),
    combine: (results) => results.flatMap((r) => (r.data ? [r.data.song] : [])),
  })

/** What the queue shows: everything in flight, plus failed songs. */
const IN_FLIGHT: SongStatus[] = ["pending", "uploading", "importing", "queued", "processing", "failed"]

/** Every in-flight or failed song (all pages). Polls every 2s while any is still being worked on. */
export const useInFlightSongs = () =>
  useQuery({
    queryKey: [...keys.songs, "in-flight"],
    queryFn: async () => {
      const all: Song[] = []
      let cursor: string | null = null
      do {
        const page: SongPage = await api.songs({ status: IN_FLIGHT, limit: 100, cursor })
        all.push(...page.songs)
        cursor = page.next_cursor
      } while (cursor)
      return all
    },
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 2000 : false),
  })

/** Polls every 2s until the song is ready or failed. */
export const useSong = (id: string) =>
  useQuery({
    queryKey: keys.song(id),
    queryFn: () => api.song(id),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.song.status
      return s === "ready" || s === "failed" ? false : 2000
    },
    // presigned URLs live 1h; keep the detail stable while the player is open
    staleTime: 5 * 60_000,
  })

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong")

/** A song that is deleted or reprocessed (its stems are about to go) cannot keep playing. */
function stopIfPlaying(id: string) {
  if (usePlayer.getState().songId === id) usePlayer.getState().unload()
}

export function useSongActions() {
  const qc = useQueryClient()
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: keys.songs })
    void qc.invalidateQueries({ queryKey: keys.usage })
    if (id) void qc.invalidateQueries({ queryKey: keys.song(id) })
  }
  const remove = useMutation({
    mutationFn: (s: Song) => api.remove(s.id),
    onSuccess: (_d, s) => { stopIfPlaying(s.id); toast.success(`Deleted "${s.title}"`); qc.removeQueries({ queryKey: keys.song(s.id) }); refresh() },
    onError: (e) => toast.error(message(e)),
  })
  const rename = useMutation({
    mutationFn: (v: { id: string; title: string }) => api.rename(v.id, v.title),
    onSuccess: (_d, v) => { toast.success("Renamed"); refresh(v.id) },
    onError: (e) => toast.error(message(e)),
  })
  const reprocess = useMutation({
    mutationFn: (v: { id: string; model: Model }) => api.reprocess(v.id, v.model),
    onSuccess: (song, v) => { stopIfPlaying(v.id); toast.success(song.status === "pending" ? "Waiting in Processing" : "Processing started"); refresh(v.id) },
    onError: (e) => toast.error(message(e)),
  })
  // Import the same link again, then drop the failed song.
  const reimport = useMutation({
    mutationFn: async (s: Song) => {
      const title = s.title === s.source_url ? undefined : s.title
      const fresh = await api.importSong({ url: s.source_url ?? "", title, model: retryModel(s.model) })
      await api.remove(s.id)
      return fresh
    },
    onSuccess: (fresh, s) => { toast.success(fresh.status === "pending" ? "Waiting in Processing" : "Import started"); qc.removeQueries({ queryKey: keys.song(s.id) }); refresh() },
    onError: (e) => { toast.error(message(e)); refresh() },
  })
  // Takes a song out of the queue, or stops an import that is downloading.
  const cancel = useMutation({
    mutationFn: (s: Song) => api.cancel(s.id),
    onSuccess: (_d, s) => { toast.success(s.status === "importing" || isLinkImport(s) ? "Import cancelled" : "Removed from Processing"); refresh(s.id) },
    onError: (e, s) => { toast.error(message(e)); refresh(s.id) },
  })
  return { remove, rename, reprocess, reimport, cancel }
}

// --- Setlists ----------------------------------------------------------------------------------------------------

export const useSetlists = () => useQuery({ queryKey: keys.setlists, queryFn: () => api.setlists().then((r) => r.setlists) })

/** A setlist with its entries; without a network, the copy kept with "Make available offline". */
export const useSetlist = (id: string) =>
  useQuery({
    queryKey: keys.setlist(id),
    queryFn: async () => {
      try {
        return await api.setlist(id)
      } catch (e) {
        const kept = await offlineSetlist(id)
        if (kept && !(e instanceof ApiError && e.status === 404)) return kept
        throw e
      }
    },
    enabled: !!id,
  })

export function useSetlistActions() {
  const qc = useQueryClient()
  const saved = (d: SetlistDetail) => {
    qc.setQueryData(keys.setlist(d.setlist.id), d)
    void qc.invalidateQueries({ queryKey: keys.setlists })
    syncUpNext(d)
  }
  const create = useMutation({
    mutationFn: api.createSetlist,
    onSuccess: saved,
    onError: (e) => toast.error(message(e)),
  })
  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; settings_source?: SettingsSource; transition?: Transition }) => {
      const { id, ...body } = v
      return api.updateSetlist(id, body)
    },
    onSuccess: saved,
    onError: (e) => toast.error(message(e)),
  })
  const add = useMutation({
    mutationFn: (v: { id: string; songIds: string[] }) => api.addToSetlist(v.id, v.songIds),
    onSuccess: saved,
    onError: (e) => toast.error(message(e)),
  })
  const entries = useMutation({
    mutationFn: (v: { id: string; entries: EntryEdit[] }) => api.replaceEntries(v.id, v.entries),
    // Shown at once; the server's answer replaces it, and a failure puts the saved list back.
    onMutate: (v) => {
      const before = qc.getQueryData<SetlistDetail>(keys.setlist(v.id))
      if (before) {
        const byId = new Map(before.entries.map((e) => [e.id, e]))
        qc.setQueryData<SetlistDetail>(keys.setlist(v.id), {
          ...before,
          entries: v.entries.flatMap((e) => {
            const old = byId.get(e.id)
            return old ? [{ ...old, transition: e.transition, notes: e.notes }] : []
          }),
        })
      }
      return { before }
    },
    onSuccess: saved,
    onError: (e, v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.setlist(v.id), ctx.before)
      toast.error(message(e))
    },
  })
  const remove = useMutation({
    mutationFn: (s: Setlist) => api.removeSetlist(s.id),
    onSuccess: (_d, s) => {
      toast.success(`Deleted "${s.name}"`)
      qc.removeQueries({ queryKey: keys.setlist(s.id) })
      void qc.invalidateQueries({ queryKey: keys.setlists })
      void removeSetlistOffline(s.id)
    },
    onError: (e) => toast.error(message(e)),
  })
  return { create, update, add, entries, remove }
}

/** Entries the setlist being played no longer has, or whose transition changed, are brought into Up Next. */
function syncUpNext(d: SetlistDetail) {
  const s = useUpNext.getState()
  if (s.setlist?.id !== d.setlist.id) return
  const byId = new Map(d.entries.map((e) => [e.id, e]))
  useUpNext.setState({
    setlist: { id: d.setlist.id, name: d.setlist.name, transition: d.setlist.transition },
    items: s.items.map((it) => {
      const e = it.entryId ? byId.get(it.entryId) : undefined
      return e ? { ...it, title: e.song.title, transition: e.transition } : it
    }),
  })
}
