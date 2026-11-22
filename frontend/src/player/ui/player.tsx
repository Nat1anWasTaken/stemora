import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { AudioWaveform, ChevronDown, Download, FileMusic, LayoutGrid, Loader2, MoreHorizontal, Pencil, SlidersVertical, Sparkles, Trash2 } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "sonner"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { ConfirmDialog, RenameDialog } from "@/components/app/dialogs"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useIsDesktop } from "@/hooks/use-media"
import { useThemeColor } from "@/hooks/use-theme-color"
import { HQ_MODEL, isHighQuality, stemDownloadUrl, type SongDetail } from "@/lib/api"
import { formatClock } from "@/lib/format"
import { useSongActions } from "@/lib/queries"
import { tempoMidi } from "@/player/midi"
import { STEM_NAMES } from "@/player/mixer"
import { bindMediaHandlers, clearMediaSession, setMediaMetadata, setPlaybackState } from "@/player/mediaSession"
import { getPosition, usePlayer } from "@/player/store"
import { ChartToolbar, loadChart, saveChart, type Chart, type DrumControls } from "@/player/ui/chart-header"
import { ChordGrid } from "@/player/ui/chord-grid"
import { DrumNotation } from "@/player/ui/drum-notation"
import { barIndexAt, useDrumChart } from "@/player/drums/chart"
import { loadNotationPrefs, saveNotationPrefs, type NotationPrefs } from "@/player/drums/notation-prefs"
import { loadPrecision, savePrecision, type DrumPrecision } from "@/player/drums/precision"
import { useDrumBreaks } from "@/player/drums/use-drum-breaks"
import { SectionBar } from "@/player/ui/section-bar"
import { MixerTools, StemRow, triggerDownload } from "@/player/ui/stem-row"
import { SeekBar, Transport } from "@/player/ui/transport"
import { useSheetDrag } from "@/player/ui/use-sheet-drag"
import { usePlayerCommands } from "@/player/ui/use-player-commands"
import { TempoEditor } from "@/player/ui/tempo-editor/tempo-editor"
import { Swap, WorkspaceToolbar } from "@/player/ui/workspace"
import { useTempoMarkers } from "@/player/use-tempo-markers"
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
  /** Phone tab; on desktop the mixer is always shown and `view` picks the main area. */
  const [tab, setTab] = useState<"mixer" | "tempo" | "practice">("mixer")
  const [view, setView] = useState<"tempo" | "practice">("tempo")
  const [closing, setClosing] = useState(false)
  /** The workspace toolbar's slot, where the tempo editor renders its tools. */
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const dragZone = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setClosing(true), [])
  const [selected, setSelected] = useState<StemName>("vocals")
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reproc, setReproc] = useState(false)
  const select = useCallback((n: StemName) => setSelected(n), [])
  const toggleView = useCallback(() => setView((v) => (v === "tempo" ? "practice" : "tempo")), [])
  const practice = desktop ? view === "practice" : tab === "practice"
  const [chart, setChartState] = useState<Chart>(loadChart)
  const setChart = useCallback((c: Chart) => {
    setChartState(c)
    saveChart(c)
  }, [])
  const cycleChart = useCallback(() => setChart(chart === "chords" ? "drums" : "chords"), [chart, setChart])
  const [precision, setPrecisionState] = useState<DrumPrecision>(loadPrecision)
  const setPrecision = useCallback((p: DrumPrecision) => {
    setPrecisionState(p)
    savePrecision(p)
  }, [])
  const [notationPrefs, setNotationPrefsState] = useState<NotationPrefs>(loadNotationPrefs)
  const setNotationPrefs = useCallback((p: NotationPrefs) => {
    setNotationPrefsState(p)
    saveNotationPrefs(p)
  }, [])
  const setZoom = useCallback((zoom: number) => setNotationPrefsState((p) => {
    const next = { ...p, zoom }
    saveNotationPrefs(next)
    return next
  }), [])
  const drumChart = useDrumChart(precision)
  const { breaks, toggle: toggleBreak, editable: breaksEditable } = useDrumBreaks(song.id, detail)
  useTempoMarkers(song.id, detail.tempo_markers)
  const toggleBreakAtPlayhead = useCallback(() => {
    if (!drumChart) return
    const bar = barIndexAt(drumChart.bars, getPosition())
    if (bar > 0) toggleBreak(bar)
  }, [drumChart, toggleBreak])
  const drums: DrumControls = {
    precision,
    onPrecision: setPrecision,
    prefs: notationPrefs,
    onPrefs: setNotationPrefs,
    bars: drumChart?.bars ?? null,
    breaks,
    onToggleBreak: toggleBreak,
    breaksEditable,
  }
  const chartView = chart === "drums"
    ? <DrumNotation chart={drumChart} prefs={notationPrefs} breaks={breaks} onZoom={setZoom} />
    : <ChordGrid />

  usePlayerEnvironment()
  useThemeColor("--sheet-top")
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

  const hasGrid = usePlayer((s) => s.grid.beats.length > 0)
  const exportTempo = () => {
    const { grid, duration, analysis } = usePlayer.getState()
    const bytes = tempoMidi(grid, duration, { title: song.title, sections: analysis?.sections })
    if (!bytes) return
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }))
    triggerDownload(url, `${song.title.replace(/[\\/:*?"<>|]/g, "-")} - tempo.mid`)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const entries: MenuEntry[] = [
    { key: "dl-m4a", label: "Download all stems (M4A)", icon: <Download />, onSelect: () => downloadAll("m4a") },
    { key: "dl-flac", label: "Download all stems (FLAC)", icon: <Download />, onSelect: () => downloadAll("flac") },
    { key: "dl-tempo", label: "Export tempo map (MIDI)", icon: <FileMusic />, disabled: !hasGrid, onSelect: exportTempo },
    ...(song.model !== HQ_MODEL ? [{ key: "hq", label: "Reprocess in high quality", icon: <Sparkles />, onSelect: () => setReproc(true) } as MenuEntry] : []),
    { key: "rename", label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
    { key: "sep", separator: true },
    { key: "delete", label: "Delete song", icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(true) },
  ]

  usePlayerCommands({ selected, select, desktop, view, toggleView, tab, setTab, practice, chart, cycleChart, toggleBreak: toggleBreakAtPlayhead, close, menu: entries })

  // Loading/error state, floating over the bottom of the view until the stems are ready.
  const statusPanel = status === "loading" || status === "idle" ? (
    <div className="flex h-14 shrink-0 items-center rounded-2xl border border-border bg-surface/70 px-4">
      <Progress value={Math.round(loadProgress * 100)} aria-label="Loading stems" className="flex-1">
        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums"><Loader2 className="size-4 animate-spin" />{Math.round(loadProgress * 100)}%</span>
      </Progress>
    </div>
  ) : status === "error" ? (
    <div role="alert" className="flex h-14 shrink-0 items-center gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4">
      <p className="min-w-0 flex-1 truncate text-sm text-destructive">{error}</p>
      <Button variant="secondary" size="sm" onClick={() => void usePlayer.getState().load(detail)}>Try again</Button>
    </div>
  ) : null
  const floatingStatus = statusPanel && <div className="absolute inset-x-4 bottom-2 z-10 rounded-2xl glass md:inset-x-6">{statusPanel}</div>
  const chartToolbar = <ChartToolbar chart={chart} onChart={setChart} desktop={desktop} drums={drums} />
  const chartBlock = <Swap key={chart} className="flex-col">{chartView}</Swap>
  const stems = STEM_NAMES.map((n) => <StemRow key={n} name={n} songId={song.id} selected={selected === n} onSelect={() => select(n)} />)

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
            <p className="truncate text-sm text-muted-foreground">{song.duration_s ? formatClock(song.duration_s) : "Stems"}{isHighQuality(song.model) ? " · High quality" : ""}</p>
          </div>
          <ActionMenu title={song.title} entries={entries} trigger={<Button variant="secondary" size="icon-lg" aria-label="More options"><MoreHorizontal /></Button>} />
        </header>
      </div>

      {desktop ? (
        <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pt-3 pb-2">
          {floatingStatus}
          {/* One fixed skeleton for both views: only the toolbar's tools and the main area's content change. */}
          <div className="grid min-h-0 flex-1 workspace-grid gap-x-4 gap-y-2">
            <Tabs value={view} onValueChange={(v) => setView(v as "tempo" | "practice")}>
              <TabsList variant="workspace" aria-label="View">
                <TabsTrigger value="tempo" title="Tempo (V)"><AudioWaveform />Tempo</TabsTrigger>
                <TabsTrigger value="practice" title="Practice (V)"><LayoutGrid />Practice</TabsTrigger>
              </TabsList>
            </Tabs>
            <WorkspaceToolbar label={view === "tempo" ? "Tempo map" : "Chart"} slotRef={setToolbar}>
              {view === "practice" && chartToolbar}
            </WorkspaceToolbar>
            {/* Track headers: the mixer header is as tall as the editor's ruler and tempo lane, and the 1px borders
                match the editor's frame, so in the tempo view each row sits on its stem's lane. */}
            <aside aria-label="Mixer" className="flex min-h-0 flex-col border-y border-transparent">
              <div className="flex h-15 shrink-0 items-center"><MixerTools /></div>
              <ul className="grid min-h-0 flex-1 grid-rows-4">{stems}</ul>
            </aside>
            <div className="flex min-h-0 min-w-0 flex-col">
              {view === "tempo"
                ? <Swap key="tempo" className="flex-col"><TempoEditor centered={false} toolbar={toolbar} /></Swap>
                : <Swap key="practice" className="flex-col">{chartBlock}</Swap>}
            </div>
          </div>
          <SectionBar />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-4 pt-2 pb-2">
          {floatingStatus}
          <WorkspaceToolbar label={tab === "mixer" ? "Mixer" : tab === "tempo" ? "Tempo map" : "Chart"} slotRef={setToolbar}>
            {tab === "mixer" && <Swap className="items-center"><MixerTools /></Swap>}
            {tab === "practice" && chartToolbar}
          </WorkspaceToolbar>
          {tab === "mixer" && (
            <Swap key="mixer" className="-mx-4 flex-col gap-2 overflow-y-auto overscroll-contain px-4">
              <section aria-label="Mixer" className="flex flex-1 flex-col">
                <ul className="flex flex-1 flex-col justify-evenly">{stems}</ul>
              </section>
              <div className="shrink-0"><SectionBar /></div>
            </Swap>
          )}
          {tab === "tempo" && <Swap key="tempo" className="flex-col"><TempoEditor centered toolbar={toolbar} /></Swap>}
          {tab === "practice" && <Swap key="practice" className="flex-col">{chartBlock}</Swap>}
        </div>
      )}

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-4 pt-2 pb-safe md:px-6 md:pb-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <SeekBar />
        <Transport />
        <nav className="mx-auto w-full max-w-sm rounded-full border border-border bg-secondary/60 p-1 md:hidden" aria-label="Player view">
          <div className="relative flex">
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary transition-transform duration-300 ease-spring", tab === "tempo" && "translate-x-full", tab === "practice" && "translate-x-double")} />
            {([["mixer", "Mixer", SlidersVertical], ["tempo", "Tempo", AudioWaveform], ["practice", "Practice", LayoutGrid]] as const).map(([key, label, Icon]) => (
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
        description={`The high quality model (SCNet XL) is about 3x slower and costlier. Your current stems for "${song.title}" are replaced when it finishes.`}
        confirmLabel="Reprocess"
        onConfirm={() => reprocess.mutate({ id: song.id, model: HQ_MODEL }, { onSuccess: () => nav("/", { replace: true }) })}
      />
    </div>
  )
}
