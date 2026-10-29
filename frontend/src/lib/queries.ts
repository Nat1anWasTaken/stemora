import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, isActive, isLinkImport, retryModel, type Model, type Song, type SongPage, type SongSort, type SongStatus } from "@/lib/api"

export const keys = {
  me: ["me"] as const,
  status: ["auth-status"] as const,
  songs: ["songs"] as const,
  song: (id: string) => ["song", id] as const,
  usage: ["usage"] as const,
  invites: ["invites"] as const,
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
    refetchInterval: (q) => {
      const s = q.state.data?.song.status
      return s === "ready" || s === "failed" ? false : 2000
    },
    // presigned URLs live 1h; keep the detail stable while the player is open
    staleTime: 5 * 60_000,
  })

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong")

export function useSongActions() {
  const qc = useQueryClient()
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: keys.songs })
    void qc.invalidateQueries({ queryKey: keys.usage })
    if (id) void qc.invalidateQueries({ queryKey: keys.song(id) })
  }
  const remove = useMutation({
    mutationFn: (s: Song) => api.remove(s.id),
    onSuccess: (_d, s) => { toast.success(`Deleted "${s.title}"`); qc.removeQueries({ queryKey: keys.song(s.id) }); refresh() },
    onError: (e) => toast.error(message(e)),
  })
  const rename = useMutation({
    mutationFn: (v: { id: string; title: string }) => api.rename(v.id, v.title),
    onSuccess: (_d, v) => { toast.success("Renamed"); refresh(v.id) },
    onError: (e) => toast.error(message(e)),
  })
  const reprocess = useMutation({
    mutationFn: (v: { id: string; model: Model }) => api.reprocess(v.id, v.model),
    onSuccess: (song, v) => { toast.success(song.status === "pending" ? "Added to the queue" : "Processing started"); refresh(v.id) },
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
    onSuccess: (fresh, s) => { toast.success(fresh.status === "pending" ? "Added to the queue" : "Import started"); qc.removeQueries({ queryKey: keys.song(s.id) }); refresh() },
    onError: (e) => { toast.error(message(e)); refresh() },
  })
  // Takes a song out of the queue, or stops an import that is downloading.
  const cancel = useMutation({
    mutationFn: (s: Song) => api.cancel(s.id),
    onSuccess: (_d, s) => { toast.success(s.status === "importing" || isLinkImport(s) ? "Import cancelled" : "Removed from the queue"); refresh(s.id) },
    onError: (e, s) => { toast.error(message(e)); refresh(s.id) },
  })
  return { remove, rename, reprocess, reimport, cancel }
}
