import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, isActive, type Model, type Song } from "@/lib/api"

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

/** Polls every 2s while any song is still being processed. */
export const useSongs = () =>
  useQuery({
    queryKey: keys.songs,
    queryFn: api.songs,
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
    onSuccess: (_d, v) => { toast.success("Processing started"); refresh(v.id) },
    onError: (e) => toast.error(message(e)),
  })
  return { remove, rename, reprocess }
}
