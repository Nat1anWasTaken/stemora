import { api, type SetlistDetail, type SongDetail, type StemName } from "@/lib/api"

/**
 * Setlists made available offline (docs/playback.md, Stage view): every song's stems, peaks, analysis and details are
 * kept in Cache Storage under paths of their own, not their presigned URLs (those expire after an hour). The player
 * prefers these copies whenever they exist, online too, and Up Next falls back to the saved details without a network.
 * The service worker never caches /api or R2, so this is the only place songs are kept.
 */

const CACHE = "stemora-offline-v1"
const INDEX = "stemora:offline-setlists"

const songPath = (id: string, file: string) => `/offline/song/${id}/${file}`
const setlistPath = (id: string) => `/offline/setlist/${id}.json`

const supported = () => typeof caches !== "undefined"

async function open(): Promise<Cache | null> {
  if (!supported()) return null
  try {
    return await caches.open(CACHE)
  } catch {
    return null
  }
}

/** The offline setlists and the songs each holds (to know which songs are still needed when one is removed). */
function readIndex(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) ?? "{}") as unknown
    return v && typeof v === "object" ? (v as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}
function writeIndex(v: Record<string, string[]>) {
  try {
    localStorage.setItem(INDEX, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export const isOfflineSetlist = (id: string) => id in readIndex()

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`)
  return r
}

/** Whether every file a song plays from is cached. */
async function songCached(cache: Cache, d: SongDetail): Promise<boolean> {
  const hits = await Promise.all([songPath(d.song.id, "detail.json"), ...d.stems.map((s) => songPath(d.song.id, `${s.name}.m4a`))].map((p) => cache.match(p)))
  return hits.every(Boolean)
}

/**
 * Downloads every ready song of a setlist (skipping those already kept) and the setlist itself. `onProgress` gets the
 * songs done so far. Asks the browser to keep the storage, so it is not cleared when space runs low.
 */
export async function saveSetlistOffline(sl: SetlistDetail, onProgress: (done: number, total: number) => void = () => {}) {
  const cache = await open()
  if (!cache) throw new Error("This browser cannot keep songs offline")
  void navigator.storage?.persist?.().catch(() => false)
  const ids = [...new Set(sl.entries.filter((e) => e.song.status === "ready").map((e) => e.song.id))]
  let done = 0
  onProgress(done, ids.length)
  for (const id of ids) {
    const d = await api.song(id)
    if (!(await songCached(cache, d))) {
      for (const s of d.stems) await cache.put(songPath(id, `${s.name}.m4a`), await fetchOk(s.url))
      if (d.peaks_url) await cache.put(songPath(id, "peaks.json"), await fetchOk(d.peaks_url)).catch(() => {})
      if (d.analysis_url) {
        const r = await fetch(d.analysis_url).catch(() => null)
        if (r?.ok) await cache.put(songPath(id, "analysis.json"), r)
      }
    }
    // The details last: a song counts as kept only once all of its files are.
    await cache.put(songPath(id, "detail.json"), new Response(JSON.stringify(d), { headers: { "Content-Type": "application/json" } }))
    onProgress(++done, ids.length)
  }
  await cache.put(setlistPath(sl.setlist.id), new Response(JSON.stringify(sl), { headers: { "Content-Type": "application/json" } }))
  writeIndex({ ...readIndex(), [sl.setlist.id]: ids })
}

/** Forgets an offline setlist, and the songs no other offline setlist needs. */
export async function removeSetlistOffline(id: string) {
  const index = readIndex()
  const songs = index[id] ?? []
  delete index[id]
  writeIndex(index)
  const still = new Set(Object.values(index).flat())
  const cache = await open()
  if (!cache) return
  await cache.delete(setlistPath(id))
  for (const sid of songs) {
    if (still.has(sid)) continue
    for (const k of await cache.keys()) if (new URL(k.url).pathname.startsWith(`/offline/song/${sid}/`)) await cache.delete(k)
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const cache = await open()
  const r = await cache?.match(path)
  if (!r) return null
  try {
    return (await r.json()) as T
  } catch {
    return null
  }
}

/** A song's saved details (stems then come from the cache, see `localSources`). */
export const offlineDetail = (id: string) => readJson<SongDetail>(songPath(id, "detail.json"))
export const offlineSetlist = (id: string) => readJson<SetlistDetail>(setlistPath(id))

/** How many of a setlist's ready songs are kept, to show "available offline" truthfully. */
export async function offlineCount(sl: SetlistDetail): Promise<{ kept: number; total: number }> {
  const ids = [...new Set(sl.entries.filter((e) => e.song.status === "ready").map((e) => e.song.id))]
  const cache = await open()
  if (!cache) return { kept: 0, total: ids.length }
  const kept = await Promise.all(ids.map((id) => cache.match(songPath(id, "detail.json"))))
  return { kept: kept.filter(Boolean).length, total: ids.length }
}

/**
 * Where to load a song from: its cached files as object URLs when kept (release them once loaded), else its presigned
 * URLs.
 */
export async function localSources(d: SongDetail): Promise<{ stems: { name: StemName; url: string }[]; peaks: string | null; analysis: string | null; release: () => void }> {
  const made: string[] = []
  const cache = await open()
  const local = async (file: string, fallback: string | null) => {
    const r = await cache?.match(songPath(d.song.id, file))
    if (!r) return fallback
    const url = URL.createObjectURL(await r.blob())
    made.push(url)
    return url
  }
  const stems = await Promise.all(d.stems.map(async (s) => ({ name: s.name, url: (await local(`${s.name}.m4a`, s.url))! })))
  return {
    stems,
    peaks: await local("peaks.json", d.peaks_url),
    analysis: await local("analysis.json", d.analysis_url),
    release: () => made.forEach((u) => URL.revokeObjectURL(u)),
  }
}
