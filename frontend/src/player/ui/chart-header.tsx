import { useEffect, useState } from "react"
import { ChevronDown, Drum, LayoutGrid, Minimize2, Moon, Sun, Volume2, VolumeX, WrapText } from "lucide-react"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PRECISION_LABELS, PRECISIONS, type DrumPrecision } from "@/player/drums/precision"
import { barIndexAt } from "@/player/drums/chart"
import { BARS_PER_ROW, type NotationPrefs, type NotationTheme } from "@/player/drums/notation-prefs"
import type { Precision, QBar } from "@/player/drums/quantize"
import { getPosition, usePlayer } from "@/player/store"

export type Chart = "chords" | "drums"
const CHART_KEY = "stemora:chart"

export function loadChart(): Chart {
  try {
    return localStorage.getItem(CHART_KEY) === "drums" ? "drums" : "chords"
  } catch {
    return "chords"
  }
}

export function saveChart(c: Chart) {
  try {
    localStorage.setItem(CHART_KEY, c)
  } catch {
    // storage unavailable (private mode): the choice just isn't remembered
  }
}

/** Everything the drum chart's controls act on (owned by the player). */
export type DrumControls = {
  precision: DrumPrecision
  onPrecision: (p: DrumPrecision) => void
  prefs: NotationPrefs
  onPrefs: (p: NotationPrefs) => void
  bars: QBar[] | null
  breaks: number[]
  onToggleBreak: (bar: number) => void
}

/** Drum notation settings: grid (Auto or a fixed note value, optionally with triplets), bars per row and sheet theme. */
function NotationSettings({ drums, compact }: { drums: DrumControls; compact: boolean }) {
  const { precision: value, onPrecision: onChange, prefs, onPrefs } = drums
  const label = PRECISION_LABELS[value.precision]
  return (
    <ResponsivePanel
      title="Notation"
      size="wide"
      trigger={compact
        ? <Button variant="toggle" size="icon-lg" aria-label={`Notation settings (grid: ${label})`}><span className="text-xs font-semibold tabular-nums">{value.precision === "auto" ? "A" : value.precision}</span></Button>
        : <Button variant="toggle" size="sm" aria-label={`Notation settings (grid: ${label})`}>Grid: {label}<ChevronDown /></Button>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Grid</p>
          <Tabs value={value.precision} onValueChange={(v) => onChange({ ...value, precision: v as Precision })}>
            <TabsList variant="segmented" aria-label="Notation grid" className="w-full">
              {PRECISIONS.map((p) => <TabsTrigger key={p} value={p}>{PRECISION_LABELS[p]}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">Auto picks the simplest note values that fit each beat.</p>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="drum-triplets">Triplets</Label>
          <Switch id="drum-triplets" checked={value.triplets} onCheckedChange={(v) => onChange({ ...value, triplets: v })} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Bars per row</p>
          <Tabs value={String(prefs.barsPerRow)} onValueChange={(v) => onPrefs({ ...prefs, barsPerRow: Number(v) })}>
            <TabsList variant="segmented" aria-label="Bars per row" className="w-full">
              {BARS_PER_ROW.map((n) => <TabsTrigger key={n} value={String(n)}>{n === 0 ? "Auto" : n}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">Start a new row at any bar with the line break button{compact ? "" : " (B)"}.</p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Sheet</p>
          <Tabs value={prefs.theme} onValueChange={(v) => onPrefs({ ...prefs, theme: v as NotationTheme })}>
            <TabsList variant="segmented" aria-label="Sheet colours" className="w-full">
              <TabsTrigger value="dark"><Moon />Dark</TabsTrigger>
              <TabsTrigger value="light"><Sun />Light</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
    </ResponsivePanel>
  )
}

/** Bar at the playhead, re-rendering only when it changes. */
function useCurrentBar(bars: QBar[] | null, active = true): number {
  const [bar, setBar] = useState(0)
  useEffect(() => {
    if (!bars || !active) return
    let raf = 0
    const tick = () => {
      setBar(barIndexAt(bars, getPosition()))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bars, active])
  return bar
}

/** Toggle a line break before the bar at the playhead (tap a note first to pick a bar while paused). */
function LineBreakToggle({ drums, compact, active = true }: { drums: DrumControls; compact: boolean; active?: boolean }) {
  const bar = useCurrentBar(drums.bars, active)
  const on = drums.breaks.includes(bar)
  const label = on ? `Remove the line break before bar ${bar + 1}` : `Start a new row at bar ${bar + 1}`
  return (
    <Button
      variant="toggle"
      size={compact ? "icon-lg" : "sm"}
      aria-pressed={on}
      aria-label={label}
      title={compact ? undefined : `${label} (B)`}
      disabled={!drums.bars || bar < 1}
      onClick={() => drums.onToggleBreak(bar)}
    >
      <WrapText />{!compact && "Line break"}
    </Button>
  )
}

/**
 * Chords | Drums switch above the chart; for drums also the notation settings, the line break toggle and the drums mute (play along over the
 * song while reading the chart). Desktop adds tempo/meter and Collapse. On mobile the switch fills the row with 44px targets and the slot to its
 * right keeps the drum tools' width in both charts (tempo/meter shows there for chords), so switching never resizes or moves the switch.
 */
export function ChartHeader({ chart, onChart, onCollapse, drums }: {
  chart: Chart
  onChart: (c: Chart) => void
  onCollapse?: () => void
  drums: DrumControls
}) {
  const analysis = usePlayer((s) => s.analysis)
  const muted = usePlayer((s) => s.mixer.muted.includes("drums"))
  const { toggleMute } = usePlayer.getState()
  const desktop = !!onCollapse
  const isDrums = chart === "drums"
  const tempo = analysis && `${analysis.bpm ? `${Math.round(analysis.bpm)} BPM · ` : ""}${analysis.beatsPerBar}/4`

  const tabs = (
    <Tabs value={chart} onValueChange={(v) => onChart(v as Chart)} className={desktop ? undefined : "min-w-0 flex-1"}>
      <TabsList variant="segmented" aria-label="Chart" className={desktop ? undefined : "w-full"}>
        <TabsTrigger value="chords"><LayoutGrid />Chords</TabsTrigger>
        <TabsTrigger value="drums"><Drum />Drums</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  if (!desktop) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        {tabs}
        <div className="grid shrink-0 items-center justify-items-end">
          <div inert={!isDrums} className={cn("col-start-1 row-start-1 flex items-center gap-1 transition-opacity duration-200", !isDrums && "invisible opacity-0")}>
            <NotationSettings drums={drums} compact />
            <LineBreakToggle drums={drums} compact active={isDrums} />
            <Button variant="toggle" size="icon-lg" aria-pressed={muted} aria-label="Mute drums" onClick={() => toggleMute("drums")}>
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
          </div>
          {!isDrums && tempo && <p className="col-start-1 row-start-1 animate-page pr-1 text-sm text-muted-foreground tabular-nums">{tempo}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {tabs}
      {tempo && <p className="text-sm text-muted-foreground tabular-nums">{tempo}</p>}
      <div className="ml-auto flex items-center gap-1">
        {isDrums && <NotationSettings drums={drums} compact={false} />}
        {isDrums && <LineBreakToggle drums={drums} compact={false} />}
        {isDrums && (
          <Button variant="toggle" size="sm" aria-pressed={muted} onClick={() => toggleMute("drums")}>
            {muted ? <VolumeX /> : <Volume2 />}Mute drums
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCollapse}><Minimize2 />Collapse</Button>
      </div>
    </div>
  )
}
