import { create } from "zustand"
import { toast } from "sonner"
import { api, type PlaybackSettings, type SetlistDetail, type SettingsSource, type SongDetail, type Transition } from "@/lib/api"
import { keys } from "@/lib/queries"
import { queryClient } from "@/lib/query-client"
import { clearPending, initialSettings, loadPending, parseSettings, type SettingsScope } from "@/player/settings"
import { getPosition, setSongEndedHandler, settingsOf, usePlayer, type LoadOptions } from "@/player/store"
import { offlineDetail } from "@/player/offline"

/**
 * Up Next (docs/playback.md): what plays on this device, the current song included. It is kept in this browser
 * (playback is per device) and can come from a setlist, whose entries then carry their settings and transitions.
 */

export type UpNextItem = {
  /** Unique in the list (a song can be in it twice). */
  key: string
  songId: string
  title: string
  /** Set for songs that came from the setlist being played. */
  entryId?: string
  /** The entry's own transition after it (null: the setlist's). */
  transition?: Transition | null
}
export type UpNextSetlist = { id: string; name: string; transition: Transition }
export type UpNextList = { items: UpNextItem[]; index: number }
export type SongRef = { id: string; title: string }

let counter = 0
const newKey = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`
export const itemOf = (s: SongRef): UpNextItem => ({ key: newKey(), songId: s.id, title: s.title })

// --- List logic (pure) -----------------------------------------------------------------------------------------------

/** `added` right after the current song (at the start when nothing is current). */
export function insertNext(l: UpNextList, added: UpNextItem[]): UpNextList {
  const at = l.index + 1
  return { items: [...l.items.slice(0, at), ...added, ...l.items.slice(at)], index: l.index }
}

/** Removes an item; the current one cannot be removed. */
export function removeItem(l: UpNextList, key: string): UpNextList {
  const i = l.items.findIndex((x) => x.key === key)
  if (i < 0 || i === l.index) return l
  return { items: l.items.filter((x) => x.key !== key), index: i < l.index ? l.index - 1 : l.index }
}

/** Moves an item one place up (-1) or down (+1), keeping track of the current one. */
export function moveItem(l: UpNextList, key: string, by: -1 | 1): UpNextList {
  const i = l.items.findIndex((x) => x.key === key)
  const j = i + by
  if (i < 0 || j < 0 || j >= l.items.length) return l
  const items = [...l.items]
  ;[items[i], items[j]] = [items[j], items[i]]
  const index = l.index === i ? j : l.index === j ? i : l.index
  return { items, index }
}

/** What happens after the item at `i` ends: an entry's own choice, else the setlist's; songs outside one continue. */
export function transitionAfter(items: UpNextItem[], i: number, setlist: UpNextSetlist | null): Transition {
  const it = items[i]
  if (!setlist) return "continue"
  return (it?.entryId && it.transition) || setlist.transition
}

// --- State -------------------------------------------------------------------------------------------------------------

type UpNextState = UpNextList & {
  setlist: UpNextSetlist | null
  /** Where the player takes settings from. "setlist" only applies to songs from the setlist being played. */
  source: SettingsSource
}

const STORAGE = "stemora:up-next"

function restore(): UpNextState {
  const empty: UpNextState = { items: [], index: -1, setlist: null, source: "song" }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? "null") as Partial<UpNextState> | null
    if (!raw || !Array.isArray(raw.items)) return empty
    const items = raw.items.filter((x): x is UpNextItem => !!x && typeof x.key === "string" && typeof x.songId === "string" && typeof x.title === "string")
    const index = typeof raw.index === "number" && raw.index >= -1 && raw.index < items.length ? raw.index : -1
    const source = raw.source === "listening" || raw.source === "setlist" ? raw.source : "song"
    return { items, index, setlist: raw.setlist ?? null, source }
  } catch {
    return empty
  }
}

export const useUpNext = create<UpNextState>(() => restore())

useUpNext.subscribe((s) => {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ items: s.items, index: s.index, setlist: s.setlist, source: s.source }))
  } catch {
    /* storage unavailable: Up Next lasts for this page */
  }
})

// --- Playing ----------------------------------------------------------------------------------------------------------

/** The song's details with presigned URLs fresh enough to load (they last an hour); the offline copy without a network. */
export async function songDetail(id: string): Promise<SongDetail> {
  try {
    return await queryClient.fetchQuery({ queryKey: keys.song(id), queryFn: () => api.song(id), staleTime: 30 * 60_000 })
  } catch (e) {
    const offline = await offlineDetail(id)
    if (offline) return offline
    throw e
  }
}

async function setlistDetail(id: string): Promise<SetlistDetail | null> {
  try {
    return await queryClient.fetchQuery({ queryKey: keys.setlist(id), queryFn: () => api.setlist(id), staleTime: 60_000 })
  } catch {
    return queryClient.getQueryData<SetlistDetail>(keys.setlist(id)) ?? null
  }
}

async function listeningServer(): Promise<PlaybackSettings | null> {
  try {
    const r = await queryClient.fetchQuery({ queryKey: keys.listening, queryFn: api.listeningSettings, staleTime: Infinity })
    return r.settings
  } catch {
    return null
  }
}

/** Which source applies to an item: Setlist only for the setlist's own songs. */
export function effectiveSource(source: SettingsSource, item: UpNextItem | undefined, setlist: UpNextSetlist | null): SettingsSource {
  if (source === "setlist") return setlist && item?.entryId ? "setlist" : "song"
  return source
}

/** The settings an item plays with under the current source, where changes to them go, and the server's copy. */
async function resolveSettings(item: UpNextItem | undefined, detail: SongDetail): Promise<Required<Pick<LoadOptions, "settings" | "scope" | "server">>> {
  const { source, setlist } = useUpNext.getState()
  const song = { settings: initialSettings(detail.song.id, detail.settings), scope: { kind: "song", id: detail.song.id } as SettingsScope, server: detail.settings ?? null }
  switch (effectiveSource(source, item, setlist)) {
    case "listening": {
      const scope: SettingsScope = { kind: "listening" }
      const server = await listeningServer()
      const player = usePlayer.getState()
      // The first time, the listening set starts as what you hear.
      const settings = loadPending(scope) ?? (server ? parseSettings(server) : player.songId ? settingsOf(player) : song.settings)
      return { settings, scope, server }
    }
    case "setlist": {
      const sl = await setlistDetail(setlist!.id)
      const entry = sl?.entries.find((e) => e.id === item!.entryId)
      if (!entry) return song
      const scope: SettingsScope = { kind: "entry", setlistId: setlist!.id, entryId: entry.id }
      const server = entry.settings ?? null
      return { settings: loadPending(scope) ?? (server ? parseSettings(server) : song.settings), scope, server }
    }
    default:
      return song
  }
}

let loading = 0

/** Loads the item at `index` (and plays it when `autoplay`). A newer call wins over one still fetching. */
export async function playAt(index: number, autoplay: boolean) {
  const { items } = useUpNext.getState()
  const item = items[index]
  if (!item) return
  const token = ++loading
  useUpNext.setState({ index })
  try {
    const detail = await songDetail(item.songId)
    if (token !== loading) return
    if (detail.song.status !== "ready" || detail.stems.length === 0) {
      toast.error(`"${detail.song.title}" has no stems to play yet`)
      return
    }
    const opts = await resolveSettings(item, detail)
    if (token !== loading) return
    void usePlayer.getState().load(detail, { ...opts, autoplay })
  } catch (e) {
    if (token === loading) toast.error(e instanceof Error ? `Could not open "${item.title}": ${e.message}` : `Could not open "${item.title}"`)
  }
}

/** The player sheet opened a song (from the Library, a link or the mini player): it becomes the current song. */
export async function openSong(detail: SongDetail) {
  const s = useUpNext.getState()
  if (s.items[s.index]?.songId !== detail.song.id) {
    const l = insertNext(s, [itemOf({ id: detail.song.id, title: detail.song.title })])
    useUpNext.setState({ items: l.items, index: l.index + 1 })
  }
  const token = ++loading
  const item = useUpNext.getState().items[useUpNext.getState().index]
  const opts = await resolveSettings(item, detail)
  if (token !== loading) return
  void usePlayer.getState().load(detail, opts)
}

const playing = () => usePlayer.getState().playing

export const upNext = {
  /** After the current song, ahead of the rest. With nothing playing, the first of them starts. */
  playNext(songs: SongRef[]) {
    const s = useUpNext.getState()
    const items = songs.map(itemOf)
    useUpNext.setState(insertNext(s, items))
    if (!usePlayer.getState().songId) void playAt(s.index + 1, false)
    toast.success(songs.length === 1 ? `"${songs[0].title}" plays next` : `${songs.length} songs play next`)
  },
  /** At the end of Up Next. */
  add(songs: SongRef[]) {
    const s = useUpNext.getState()
    useUpNext.setState({ items: [...s.items, ...songs.map(itemOf)] })
    if (!usePlayer.getState().songId) void playAt(s.index + 1, false)
    toast.success(songs.length === 1 ? `Added "${songs[0].title}" to Up Next` : `Added ${songs.length} songs to Up Next`)
  },
  /** Replaces Up Next with a setlist, from entry `start`, on the setlist's settings source. */
  playSetlist(d: SetlistDetail, start = 0, autoplay = false) {
    const items = d.entries
      .filter((e) => e.song.status === "ready")
      .map((e) => ({ key: newKey(), songId: e.song.id, title: e.song.title, entryId: e.id, transition: e.transition }))
    if (items.length === 0) return void toast.error("This setlist has no songs ready to play")
    const startEntry = d.entries[start]?.id
    const index = Math.max(0, items.findIndex((x) => x.entryId === startEntry))
    useUpNext.setState({ items, index, setlist: { id: d.setlist.id, name: d.setlist.name, transition: d.setlist.transition }, source: d.setlist.settings_source })
    void playAt(index, autoplay)
  },
  remove(key: string) {
    useUpNext.setState(removeItem(useUpNext.getState(), key))
  },
  move(key: string, by: -1 | 1) {
    useUpNext.setState(moveItem(useUpNext.getState(), key, by))
  },
  /** Keeps only the current song (and forgets the setlist). */
  clear() {
    const s = useUpNext.getState()
    const cur = s.items[s.index]
    useUpNext.setState({ items: cur ? [{ ...cur, entryId: undefined, transition: undefined }] : [], index: cur ? 0 : -1, setlist: null, source: s.source === "setlist" ? "song" : s.source })
  },
  jump(key: string) {
    const i = useUpNext.getState().items.findIndex((x) => x.key === key)
    if (i >= 0) void playAt(i, playing())
  },
  hasNext: () => useUpNext.getState().index + 1 < useUpNext.getState().items.length,
  hasPrevious: () => useUpNext.getState().index > 0,
  next() {
    if (upNext.hasNext()) void playAt(useUpNext.getState().index + 1, playing())
  },
  /** Back to the start of the song, or the song before when already near the start. */
  previous() {
    if (getPosition() > 3 || !upNext.hasPrevious()) return usePlayer.getState().seek(0)
    void playAt(useUpNext.getState().index - 1, playing())
  },
  /** Saves what is heard now as the current song's own settings, or its setlist entry's. */
  async copyTo(target: "song" | "entry") {
    const player = usePlayer.getState()
    const s = useUpNext.getState()
    const item = s.items[s.index]
    if (!player.songId) return
    const settings = settingsOf(player)
    try {
      if (target === "song") {
        const saved = (await api.setSongSettings(player.songId, settings)).settings
        clearPending({ kind: "song", id: player.songId })
        queryClient.setQueryData<SongDetail>(keys.song(player.songId), (d) => (d ? { ...d, settings: saved } : d))
        toast.success("Saved as this song's settings")
      } else if (s.setlist && item?.entryId) {
        const saved = (await api.setEntrySettings(s.setlist.id, item.entryId, settings)).settings
        clearPending({ kind: "entry", setlistId: s.setlist.id, entryId: item.entryId })
        queryClient.setQueryData<SetlistDetail>(keys.setlist(s.setlist.id), (d) =>
          d ? { ...d, entries: d.entries.map((e) => (e.id === item.entryId ? { ...e, settings: saved } : e)) } : d,
        )
        toast.success(`Saved for this song in "${s.setlist.name}"`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? `Could not save: ${e.message}` : "Could not save")
    }
  },
  /** Switches the settings source; the current song switches at once (an A/B comparison). */
  async setSource(source: SettingsSource) {
    useUpNext.setState({ source })
    const player = usePlayer.getState()
    if (!player.detail) return
    const s = useUpNext.getState()
    const opts = await resolveSettings(s.items[s.index], player.detail)
    if (usePlayer.getState().songId !== player.detail.song.id) return
    usePlayer.getState().applySettings(opts.settings, opts.scope, opts.server)
  },
}

// When a song ends: the next one plays, or loads and waits, as the transition after it says.
setSongEndedHandler(() => {
  const { index, items, setlist } = useUpNext.getState()
  if (index + 1 >= items.length) return false
  const go = transitionAfter(items, index, setlist) === "continue"
  void playAt(index + 1, go)
  return go
})
