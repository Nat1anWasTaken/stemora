import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, isActive, retryModel, type Model, type Song, type SongSort } from "@/lib/api"

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

/** Follows a few songs by id (polling each every 2s while it is still being worked on). */
export const useSongsById = (ids: string[]) =>
  useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.song(id),
      queryFn: () => api.song(id),
      refetchInterval: (q: { state: { data?: { song: Song } } }) => (q.state.data && !isActive(q.state.data.song) ? false : 2000),
    })),
    combine: (results) => results.flatMap((r) => (r.data ? [r.data.song] : [])),
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
    onSuccess: (_d, v) => { toast.success("Processing started"); refresh(v.id) },
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
    onSuccess: (_d, s) => { toast.success("Import started"); qc.removeQueries({ queryKey: keys.song(s.id) }); refresh() },
    onError: (e) => { toast.error(message(e)); refresh() },
  })
  const cancelImport = useMutation({
    mutationFn: (s: Song) => api.cancelImport(s.id),
    onSuccess: (_d, s) => { toast.success("Import cancelled"); refresh(s.id) },
    onError: (e, s) => { toast.error(message(e)); refresh(s.id) },
  })
  return { remove, rename, reprocess, reimport, cancelImport }
}
