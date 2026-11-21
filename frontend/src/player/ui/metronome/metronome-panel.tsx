import { useState, type ReactElement } from "react"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePlayer } from "@/player/store"
import { speedFor, tempoMarking, tempoRange, tempoUnit, tempoValue } from "@/player/tempo"
import { AutoClickNote, ClickPatternGrid } from "@/player/ui/metronome/click-pattern"
import { MarkerNavigator } from "@/player/ui/metronome/marker-navigator"
import { ClickSoundPicker } from "@/player/ui/metronome/sound-picker"
import { usePlayheadMarker } from "@/player/ui/metronome/use-playhead-marker"
import { ShiftUnavailable } from "@/player/ui/practice-sheets"
import { TickDial } from "@/player/ui/tick-dial"
import { usePlayheadTempo } from "@/player/ui/use-playhead-tempo"

type Tab = "click" | "speed"

/** The click pattern of the marker under the playhead (or the note for an auto marker), and the sound. */
function ClickTab({ index }: { index: number }) {
  const marker = usePlayer((s) => s.markers[index])
  return (
    <>
      {marker?.kind === "manual" ? <ClickPatternGrid marker={marker} index={index} /> : <AutoClickNote index={index} />}
      <ClickSoundPicker />
    </>
  )
}

/**
 * The speed dial. The song has one playback speed, so it is a single multiplier for every section; it reads in BPM
 * of the section under the playhead (the navigator's marker), and says so when other sections have other tempos.
 */
function SpeedTab() {
  const speed = usePlayer((s) => s.speed)
  const sections = usePlayer((s) => s.markers.length)
  const playhead = usePlayheadTempo().bpm
  const { setSpeed } = usePlayer.getState()
  const baseBpm = playhead ? Math.round(playhead) : null
  const { min, max } = tempoRange(baseBpm)
  const value = tempoValue(speed, baseBpm)
  const percent = Math.round(speed * 100)
  return (
    <>
      <p className="text-center text-sm text-muted-foreground">{baseBpm ? tempoMarking(value) : "Speed"}</p>
      <TickDial
        label={baseBpm ? "Tempo" : "Speed"}
        min={min}
        max={max}
        value={value}
        original={Math.round(tempoUnit(baseBpm))}
        onChange={(v) => setSpeed(speedFor(v, baseBpm))}
        display={baseBpm ? value : `${value}%`}
        valueText={baseBpm ? `${value} BPM` : `${value} percent`}
      />
      <p className="text-center text-xs text-muted-foreground">
        {baseBpm ? `${percent} % of ${baseBpm} BPM` : "Percent of the original speed"}
        {sections > 1 && " · every section plays at this speed"}
      </p>
      <ShiftUnavailable />
    </>
  )
}

/**
 * Metronome: on/off in the header, then the tempo marker under the playhead (‹ › seek between markers) with its
 * click pattern and sound, or the speed dial.
 */
export function MetronomePanel({ trigger }: { trigger: ReactElement }) {
  const enabled = usePlayer((s) => s.metronome)
  const { setMetronome } = usePlayer.getState()
  const [tab, setTab] = useState<Tab>("click")
  const index = usePlayheadMarker()
  return (
    <ResponsivePanel title="Metronome" size="wide" trigger={trigger} action={<Switch aria-label="Metronome click" checked={enabled} onCheckedChange={setMetronome} />}>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="items-center">
        <TabsList variant="segmented" aria-label="Metronome view">
          <TabsTrigger value="click">Click</TabsTrigger>
          <TabsTrigger value="speed">Speed</TabsTrigger>
        </TabsList>
      </Tabs>
      <MarkerNavigator index={index} />
      {tab === "click" ? <ClickTab index={index} /> : <SpeedTab />}
    </ResponsivePanel>
  )
}
