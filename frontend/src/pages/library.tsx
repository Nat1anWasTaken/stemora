import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { ArrowDownUp, LayoutGrid, List, ListOrdered, Loader2, Music2, Plus, RotateCw, SearchX } from "lucide-react"
import { SongItem, type LibraryView } from "@/components/app/song-item"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SearchInput } from "@/components/ui/search-input"
import { Skeleton } from "@/components/ui/skeleton"
import type { SongSort } from "@/lib/api"
import { useInView } from "@/hooks/use-in-view"
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh"
import { useLibrary } from "@/lib/queries"
import { useQueue } from "@/lib/queue"
import { cn } from "@/lib/utils"

const SORTS: { value: SongSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
  { value: "longest", label: "Longest first" },
  { value: "shortest", label: "Shortest first" },
]
const isSort = (s: string | null): s is SongSort => SORTS.some((o) => o.value === s)

const VIEW_KEY = "stemora.library-view"
function useLibraryView() {
  const [view, setView] = useState<LibraryView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"
    } catch {
      return "grid"
    }
  })
  const update = (v: LibraryView) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // private mode: keep it for this visit only
    }
  }
  return [view, update] as const
}

/** Search text and sort order live in the URL (?q=&sort=) so reloads and back navigation keep them. */
function useLibraryParams() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const raw = params.get("sort")
  const sort: SongSort = isSort(raw) ? raw : "newest"
  const set = (key: "q" | "sort", value: string, fallback: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (value && value !== fallback) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: true })
  return { q, sort, setQ: (v: string) => set("q", v, ""), setSort: (v: SongSort) => set("sort", v, "newest") }
}

const gridClass = (view: LibraryView) => (view === "grid" ? "grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2")

function SkeletonItems({ view, count }: { view: LibraryView; count: number }) {
  return Array.from({ length: count }, (_, i) => <Skeleton key={i} className={view === "grid" ? "h-24" : "h-16"} />)
}

export function LibraryPage() {
  const { q, sort, setQ, setSort } = useLibraryParams()
  const [view, setView] = useLibraryView()
  // The field updates at once; the URL (and the query) follow after a short pause.
  const [text, setText] = useState(q)
  const [lastQ, setLastQ] = useState(q)
  if (q !== lastQ) {
    setLastQ(q)
    // Keep what is being typed (a trailing space, say) when it already matches.
    if (text.trim() !== q) setText(q)
  }
  useEffect(() => {
    if (text.trim() === q) return
    const t = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(t)
  }, [text, q, setQ])

  const { count: inQueue } = useQueue()
  const { data, isLoading, isPlaceholderData, isFetching, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = useLibrary({ q, sort })
  const songs = data?.pages.flatMap((p) => p.songs) ?? []
  const total = data?.pages[0]?.total ?? 0

  const pull = useRef<HTMLDivElement>(null)
  usePullToRefresh(pull, refetch)
  const sentinel = useRef<HTMLDivElement>(null)
  useInView(sentinel, () => void fetchNextPage(), { enabled: hasNextPage && !isFetchingNextPage && !isFetchNextPageError })

  const searching = q !== ""
  const clearSearch = () => {
    setText("")
    setQ("")
  }
  const subtitle = !data ? "Your separated songs" : searching ? `${total} ${total === 1 ? "result" : "results"}` : `${total} ${total === 1 ? "song" : "songs"}`
  const empty = data && total === 0 && !searching && !isPlaceholderData

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <div ref={pull} className="ptr-indicator pointer-events-none fixed inset-x-0 top-safe z-20 flex justify-center" aria-hidden>
        <span className="grid size-10 place-items-center rounded-full border border-border bg-popover text-primary shadow-lg">
          <RotateCw className="ptr-spin size-5" />
        </span>
      </div>
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Library</h1>
          <p className="text-muted-foreground" aria-live="polite">{subtitle}</p>
        </div>
        <div className="flex gap-2">
          {inQueue > 0 && (
            <Button size="lg" variant="secondary" render={<Link to="/queue" />}><ListOrdered />{inQueue} in queue</Button>
          )}
          <Button size="lg" className="hidden md:inline-flex" render={<Link to="/upload" />}><Plus />Upload song</Button>
        </div>
      </header>

      {!empty && (
        <div className="glass-page sticky top-0 z-10 -mx-4 -my-2 flex items-center gap-2 px-4 py-2 md:-mx-8 md:px-8">
          <SearchInput
            className="flex-1"
            value={text}
            onValueChange={setText}
            placeholder="Search songs"
            aria-label="Search songs"
            autoComplete="off"
            enterKeyHint="search"
          />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" aria-label="Sort songs" />}>
              <ArrowDownUp />
              <span className="hidden sm:inline">{SORTS.find((o) => o.value === sort)?.label}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => isSort(v) && setSort(v)}>
                  {SORTS.map((o) => <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex shrink-0 gap-1 rounded-lg border border-border p-0.5" role="group" aria-label="Layout">
            <Button variant="toggle" size="icon-sm" aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => setView("grid")}><LayoutGrid /></Button>
            <Button variant="toggle" size="icon-sm" aria-pressed={view === "list"} aria-label="List view" onClick={() => setView("list")}><List /></Button>
          </div>
        </div>
      )}

      {error && !data && <p role="alert" className="text-destructive">{error.message}</p>}
      {isLoading && (
        <div className={gridClass(view)}>
          <SkeletonItems view={view} count={6} />
        </div>
      )}
      {empty && (
        <div className="animate-page flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
          <Music2 className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">No songs yet</h2>
            <p className="max-w-xs text-muted-foreground">Upload a track and Stemora splits it into vocals, drums, bass and other so you can play along.</p>
          </div>
          <Button size="lg" render={<Link to="/upload" />}><Plus />Upload your first song</Button>
        </div>
      )}
      {data && total === 0 && searching && !isPlaceholderData && (
        <div className="animate-page flex flex-col items-center gap-4 px-6 py-16 text-center">
          <SearchX className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">No matches</h2>
            <p className="max-w-xs break-words text-muted-foreground">No song titles contain “{q}”.</p>
          </div>
          <Button variant="secondary" onClick={clearSearch}>Clear search</Button>
        </div>
      )}
      {songs.length > 0 && (
        <ul
          className={cn("stagger-children transition-opacity", gridClass(view), isPlaceholderData && isFetching && "opacity-60")}
          aria-busy={isPlaceholderData && isFetching}
        >
          {songs.map((s) => <SongItem key={s.id} song={s} view={view} />)}
          {isFetchingNextPage && <SkeletonItems view={view} count={view === "grid" ? 3 : 2} />}
        </ul>
      )}
      {hasNextPage && (
        <div ref={sentinel} className="flex justify-center pb-6">
          {isFetchNextPageError ? (
            <Button variant="secondary" onClick={() => void fetchNextPage()}>Couldn't load more. Try again</Button>
          ) : (
            <Button variant="ghost" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {isFetchingNextPage && <Loader2 className="animate-spin" />}Load more
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
