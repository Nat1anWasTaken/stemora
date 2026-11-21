import type { ReactElement } from "react"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Switch } from "@/components/ui/switch"
import { splitChord, transposeChord } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { MAX_SEMITONES, speedFor, tempoMarking, tempoRange, tempoUnit, tempoValue } from "@/player/tempo"
import { TickDial } from "@/player/ui/tick-dial"
import { usePlayheadTempo } from "@/player/ui/use-playhead-tempo"

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0")

function ShiftUnavailable() {
  const canShift = usePlayer((s) => s.canShift)
  if (canShift !== false) return null
  return <p className="text-center text-sm text-muted-foreground">This browser cannot keep the pitch while changing speed, so the key cannot be changed and tempo changes also shift the pitch.</p>
}

/**
 * Metronome on/off plus the tempo dial; the dial changes the song's speed, in BPM of the tempo under the playhead
 * when there is one (else percent).
 */
export function TempoPanel({ trigger }: { trigger: ReactElement }) {
  const enabled = usePlayer((s) => s.metronome)
  const speed = usePlayer((s) => s.speed)
  const playhead = usePlayheadTempo().bpm
  const baseBpm = playhead ? Math.round(playhead) : null
  const { setMetronome, setSpeed } = usePlayer.getState()
  const { min, max } = tempoRange(baseBpm)
  const value = tempoValue(speed, baseBpm)
  return (
    <ResponsivePanel title="Metronome" trigger={trigger} action={<Switch aria-label="Metronome click" checked={enabled} onCheckedChange={setMetronome} />}>
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
      <ShiftUnavailable />
    </ResponsivePanel>
  )
}

/** Key dial in semitones; shows the song's key (transposed) when the analysis has one. */
export function KeyPanel({ trigger }: { trigger: ReactElement }) {
  const semitones = usePlayer((s) => s.semitones)
  const key = usePlayer((s) => s.analysis?.key ?? null)
  const canShift = usePlayer((s) => s.canShift)
  const { setSemitones } = usePlayer.getState()
  const shown = key ? splitChord(transposeChord(key, semitones)) : null
  return (
    <ResponsivePanel title="Song key" trigger={trigger}>
      <p className="text-center text-sm text-muted-foreground">{semitones === 0 ? "Original key" : `${signed(semitones)} semitone${Math.abs(semitones) === 1 ? "" : "s"}`}</p>
      <TickDial
        label="Key"
        min={-MAX_SEMITONES}
        max={MAX_SEMITONES}
        value={semitones}
        original={0}
        disabled={canShift === false}
        onChange={setSemitones}
        display={shown ? <span>{shown.root}<span className="text-sm font-medium">{shown.suffix}</span></span> : signed(semitones)}
        valueText={`${shown ? `${shown.root}${shown.suffix === "m" ? " minor" : " major"}, ` : ""}${signed(semitones)} semitones`}
      />
      <ShiftUnavailable />
    </ResponsivePanel>
  )
}
