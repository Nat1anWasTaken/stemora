import { ChevronDown, Drum, LayoutGrid, Minimize2, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PRECISION_LABELS, PRECISIONS, type DrumPrecision } from "@/player/drums/precision"
import type { Precision } from "@/player/drums/quantize"
import { usePlayer } from "@/player/store"

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

/** Notation grid for the drum chart: Auto or a fixed note value, optionally allowing triplets. */
function PrecisionPicker({ value, onChange, compact }: { value: DrumPrecision; onChange: (p: DrumPrecision) => void; compact: boolean }) {
  const label = PRECISION_LABELS[value.precision]
  return (
    <Popover>
      <PopoverTrigger
        render={compact
          ? <Button variant="toggle" size="icon-lg" aria-label={`Notation grid: ${label}`} />
          : <Button variant="toggle" size="sm" aria-label={`Notation grid: ${label}`} />}
      >
        {compact ? <span className="text-xs font-semibold tabular-nums">{value.precision === "auto" ? "A" : value.precision}</span> : <>Grid: {label}<ChevronDown /></>}
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex w-64 flex-col gap-4">
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
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Chords | Drums switch above the chart; for drums also the notation grid and the drums mute (play along over the
 * song while reading the chart). Desktop adds tempo/meter and Collapse; on mobile the switch spans the width with
 * 44px targets.
 */
export function ChartHeader({ chart, onChart, onCollapse, precision, onPrecision }: {
  chart: Chart
  onChart: (c: Chart) => void
  onCollapse?: () => void
  precision: DrumPrecision
  onPrecision: (p: DrumPrecision) => void
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
        {chart === "drums" && <PrecisionPicker value={precision} onChange={onPrecision} compact={!desktop} />}
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
