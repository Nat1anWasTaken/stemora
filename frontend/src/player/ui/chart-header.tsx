import { Drum, LayoutGrid, Minimize2, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

/**
 * Chords | Drums switch above the chart, plus the drums mute (play along over the song while reading the chart).
 * Desktop adds tempo/meter and Collapse; on mobile the switch spans the width with 44px targets.
 */
export function ChartHeader({ chart, onChart, onCollapse }: { chart: Chart; onChart: (c: Chart) => void; onCollapse?: () => void }) {
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
