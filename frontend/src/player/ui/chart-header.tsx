import { useEffect, useState } from "react"
import { ChevronDown, Drum, LayoutGrid, Minimize2, Moon, Sun, Volume2, VolumeX, WrapText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
    <Popover>
      <PopoverTrigger
        render={compact
          ? <Button variant="toggle" size="icon-lg" aria-label={`Notation settings (grid: ${label})`} />
          : <Button variant="toggle" size="sm" aria-label={`Notation settings (grid: ${label})`} />}
      >
        {compact ? <span className="text-xs font-semibold tabular-nums">{value.precision === "auto" ? "A" : value.precision}</span> : <>Grid: {label}<ChevronDown /></>}
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex w-72 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Notation grid</p>
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
      </PopoverContent>
    </Popover>
  )
}

/** Bar at the playhead, re-rendering only when it changes. */
function useCurrentBar(bars: QBar[] | null): number {
  const [bar, setBar] = useState(0)
  useEffect(() => {
    if (!bars) return
    let raf = 0
    const tick = () => {
      setBar(barIndexAt(bars, getPosition()))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bars])
  return bar
}

/** Toggle a line break before the bar at the playhead (tap a note first to pick a bar while paused). */
function LineBreakToggle({ drums, compact }: { drums: DrumControls; compact: boolean }) {
  const bar = useCurrentBar(drums.bars)
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
 * song while reading the chart). Desktop adds tempo/meter and Collapse; on mobile the switch spans the width with
 * 44px targets.
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

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Tabs value={chart} onValueChange={(v) => onChart(v as Chart)} className={desktop ? undefined : "min-w-0 flex-1"}>
        <TabsList variant="segmented" aria-label="Chart" className={desktop ? undefined : "w-full"}>
          <TabsTrigger value="chords"><LayoutGrid />Chords</TabsTrigger>
          <TabsTrigger value="drums"><Drum />Drums</TabsTrigger>
        </TabsList>
      </Tabs>
      {desktop && analysis && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {analysis.bpm ? `${Math.round(analysis.bpm)} BPM · ` : ""}
          {analysis.beatsPerBar}/4
        </p>
      )}
      <div className="ml-auto flex items-center gap-1">
        {chart === "drums" && <NotationSettings drums={drums} compact={!desktop} />}
        {chart === "drums" && <LineBreakToggle drums={drums} compact={!desktop} />}
        {chart === "drums" && (
          desktop ? (
            <Button variant="toggle" size="sm" aria-pressed={muted} onClick={() => toggleMute("drums")}>
              {muted ? <VolumeX /> : <Volume2 />}Mute drums
            </Button>
          ) : (
            <Button variant="toggle" size="icon-lg" aria-pressed={muted} aria-label="Mute drums" onClick={() => toggleMute("drums")}>
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
          )
        )}
        {onCollapse && <Button variant="ghost" size="sm" onClick={onCollapse}><Minimize2 />Collapse</Button>}
      </div>
    </div>
  )
}
