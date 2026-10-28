import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { AudioWaveform, ChevronDown, Download, Loader2, MoreHorizontal, Pencil, SlidersVertical, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useIsDesktop } from "@/hooks/use-media"
import { stemDownloadUrl, type SongDetail } from "@/lib/api"
import { formatClock } from "@/lib/format"
import { useSongActions } from "@/lib/queries"
import { STEM_NAMES } from "@/player/mixer"
import { bindMediaHandlers, clearMediaSession, setMediaMetadata, setPlaybackState } from "@/player/mediaSession"
import { getPosition, usePlayer } from "@/player/store"
import { PresetChips } from "@/player/ui/preset-chips"
import { PracticeStrip } from "@/player/ui/practice-strip"
import { StemRow, triggerDownload } from "@/player/ui/stem-row"
import { SeekBar, Transport } from "@/player/ui/transport"
import { useSheetDrag } from "@/player/ui/use-sheet-drag"
import { useShortcuts } from "@/player/ui/use-shortcuts"
import { Waveform } from "@/player/ui/waveform"
import type { StemName } from "@/lib/api"
import { cn } from "@/lib/utils"

function usePlayerEnvironment() {
  useEffect(() => {
    const html = document.documentElement
    html.classList.add("player-active")
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const prev = meta?.content ?? ""
    if (meta) meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    return () => {
      html.classList.remove("player-active")
      if (meta) meta.content = prev
    }
  }, [])
}

function useMediaSession(title: string) {
  const status = usePlayer((s) => s.status)
  const playing = usePlayer((s) => s.playing)
  const duration = usePlayer((s) => s.duration)
  useEffect(() => {
    if (status !== "ready") return
    const { play, pause, seek, skip } = usePlayer.getState()
    setMediaMetadata(title, "/icons/icon-512.png")
    bindMediaHandlers({ play, pause, seekTo: seek, seekBy: skip })
    return clearMediaSession
  }, [status, title])
  useEffect(() => {
    if (status !== "ready") return
    setPlaybackState(playing, getPosition(), duration)
    if (!playing) return
    const id = setInterval(() => setPlaybackState(true, getPosition(), duration), 1000)
    return () => clearInterval(id)
  }, [status, playing, duration])
}

export function Player({ detail }: { detail: SongDetail }) {
  const { song } = detail
  const nav = useNavigate()
  const { remove, rename, reprocess } = useSongActions()
  const status = usePlayer((s) => s.status)
  const loadProgress = usePlayer((s) => s.loadProgress)
  const error = usePlayer((s) => s.error)
  const desktop = useIsDesktop()
  const [tab, setTab] = useState<"mixer" | "practice">("mixer")
  const [closing, setClosing] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  const dragZone = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setClosing(true), [])
  const [selected, setSelected] = useState<StemName>("vocals")
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reproc, setReproc] = useState(false)
  const select = useCallback((n: StemName) => setSelected(n), [])

  usePlayerEnvironment()
  useShortcuts(selected, select)
  useMediaSession(song.title)
  useSheetDrag(sheet, dragZone, close, !desktop)

  // Navigate even if the exit animation never reports its end (e.g. the tab is hidden).
  useEffect(() => {
    if (!closing) return
    const id = setTimeout(() => nav("/"), 500)
    return () => clearTimeout(id)
  }, [closing, nav])

  // (Re)load only when the song changes; presigned URLs in later refetches are ignored.
  useEffect(() => {
    void usePlayer.getState().load(detail)
    return () => usePlayer.getState().unload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id])

  const downloadAll = (format: "m4a" | "flac") => {
    toast.message(`Downloading 4 stems (${format.toUpperCase()})`, { description: "Your browser may ask to allow multiple downloads." })
    STEM_NAMES.forEach((n, i) => setTimeout(() => triggerDownload(stemDownloadUrl(song.id, n, format)), i * 700))
  }

  const entries: MenuEntry[] = [
    { key: "dl-m4a", label: "Download all stems (M4A)", icon: <Download />, onSelect: () => downloadAll("m4a") },
    { key: "dl-flac", label: "Download all stems (FLAC)", icon: <Download />, onSelect: () => downloadAll("flac") },
    ...(song.model !== "htdemucs_ft" ? [{ key: "hq", label: "Reprocess in high quality", icon: <Sparkles />, onSelect: () => setReproc(true) } as MenuEntry] : []),
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    { key: "sep", separator: true },
    { key: "delete", label: "Delete song", icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(true) },
  ]

  const statusPanel = (
    <>
      {status === "loading" && (
        <div className="flex shrink-0 flex-col gap-3 rounded-3xl border border-border bg-surface/70 p-5">
          <Progress value={Math.round(loadProgress * 100)} aria-label="Loading stems" >
            <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading stems {Math.round(loadProgress * 100)}%</span>
          </Progress>
        </div>
      )}
      {status === "error" && (
        <div role="alert" className="flex shrink-0 flex-col gap-3 rounded-3xl border border-destructive/40 bg-destructive/10 p-5">
          <p className="text-destructive">{error}</p>
          <Button variant="secondary" onClick={() => void usePlayer.getState().load(detail)}>Try again</Button>
        </div>
      )}
    </>
  )

  return (
    <div
      ref={sheet}
      className={cn("player-sheet sheet-drag fixed inset-0 z-40 flex h-app flex-col overflow-hidden pt-safe pr-safe pl-safe", closing ? "animate-sheet-out" : "animate-sheet-in")}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) nav("/")
      }}
    >
      <div ref={dragZone} className="no-gestures shrink-0">
        <div className="flex justify-center pt-2 pb-1 md:hidden" aria-hidden>
          <div className="h-1 w-10 rounded-full bg-muted-foreground/40" />
        </div>
        <header className="flex items-center gap-2 px-3 pt-2 pb-1 md:px-6">
          <Button variant="secondary" size="icon-lg" aria-label="Back to library" onClick={close}><ChevronDown className="md:rotate-90" /></Button>
          <div className="flex min-w-0 flex-1 flex-col px-1">
            <h1 className="truncate text-lg leading-tight font-semibold">{song.title}</h1>
            <p className="truncate text-sm text-muted-foreground">{song.duration_s ? formatClock(song.duration_s) : "Stems"}{song.model === "htdemucs_ft" ? " · High quality" : ""}</p>
          </div>
          <ActionMenu title={song.title} entries={entries} trigger={<Button variant="secondary" size="icon-lg" aria-label="More options"><MoreHorizontal /></Button>} />
        </header>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pt-2 pb-2 md:grid md:grid-cols-5 md:gap-8 md:px-6 md:pt-4">
        {!desktop && statusPanel}
        <div className={cn("animate-page min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain md:col-span-2 md:flex md:flex-none", tab === "mixer" ? "flex" : "hidden")}>
          {desktop && status === "ready" && <PracticeStrip />}
          {desktop && statusPanel}
          <section aria-label="Mixer" className="flex flex-1 flex-col gap-3 md:flex-none">
            <ul className="flex flex-1 flex-col justify-evenly gap-1 md:flex-none md:justify-start">
              {STEM_NAMES.map((n) => <StemRow key={n} name={n} songId={song.id} selected={selected === n} onSelect={() => select(n)} />)}
            </ul>
            <PresetChips />
          </section>
        </div>
        <section aria-label="Practice" className={cn("animate-page min-h-0 flex-1 flex-col gap-3 md:col-span-3 md:flex", tab === "practice" ? "flex" : "hidden")}>
          {!desktop && status === "ready" && <PracticeStrip />}
          <Waveform />
        </section>
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-4 pt-2 pb-safe md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <SeekBar />
        <Transport />
        <nav className="mx-auto w-full max-w-xs rounded-full border border-border bg-secondary/60 p-1 md:hidden" aria-label="Player view">
          <div className="relative flex">
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary transition-transform duration-300 ease-spring", tab === "practice" && "translate-x-full")} />
            {([["mixer", "Mixer", SlidersVertical], ["practice", "Practice", AudioWaveform]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
                className={cn("pressable relative flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm font-medium", tab === key ? "text-primary-foreground" : "text-muted-foreground")}
              >
                <Icon className="size-4" />{label}
              </button>
            ))}
          </div>
        </nav>
        <p className="hidden pb-3 text-center text-xs text-muted-foreground md:block">Space play/pause · arrows skip 10s · 1-4 select stem · M mute · S solo · L loop</p>
        <div className="h-1 md:hidden" />
        </div>
      </footer>

      <RenameDialog open={renaming} onOpenChange={setRenaming} title={song.title} onRename={(t) => rename.mutate({ id: song.id, title: t })} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title="Delete this song?"
        description="The original and all stems are removed permanently."
        confirmLabel="Delete song"
        onConfirm={() => remove.mutate(song, { onSuccess: () => nav("/", { replace: true }) })}
      />
      <ConfirmDialog
        open={reproc}
        onOpenChange={setReproc}
        title="Reprocess in high quality?"
        description={`The fine-tuned model is about 4x slower and costlier. Your current stems for "${song.title}" are replaced when it finishes.`}
        confirmLabel="Reprocess"
        onConfirm={() => reprocess.mutate({ id: song.id, model: "htdemucs_ft" }, { onSuccess: () => nav("/", { replace: true }) })}
      />
    </div>
  )
}
