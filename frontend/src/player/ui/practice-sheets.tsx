import type { ReactElement } from "react"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { splitChord, transposeChord } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { MAX_SEMITONES } from "@/player/tempo"
import { TickDial } from "@/player/ui/tick-dial"

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0")

export function ShiftUnavailable() {
  const canShift = usePlayer((s) => s.canShift)
  if (canShift !== false) return null
  return <p className="text-center text-sm text-muted-foreground">This browser cannot keep the pitch while changing speed, so the key cannot be changed and tempo changes also shift the pitch.</p>
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
