import type { ReactElement } from "react"
import { ChevronDown } from "lucide-react"
import { ActionMenu } from "@/components/app/action-menu"
import { PanelHeadline, PanelSetting } from "@/components/app/panel-parts"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { splitChord, transposeChord } from "@/player/analysis"
import { STEM_LABEL, STEM_NAMES } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import { MAX_SEMITONES } from "@/player/tempo"
import { signed, transposedLabel } from "@/player/transpose"
import { STEM_ICONS } from "@/player/ui/stem-row"
import { TickDial } from "@/player/ui/tick-dial"

const plural = (n: number) => `${signed(n)} semitone${Math.abs(n) === 1 ? "" : "s"}`

/** "C major" / "A minor" for a key label such as "C" or "Am". */
function keyName(label: string) {
  const { root, suffix } = splitChord(label)
  return `${root} ${suffix === "m" ? "minor" : "major"}`
}

export function ShiftUnavailable() {
  const canShift = usePlayer((s) => s.canShift)
  if (canShift !== false) return null
  return <p className="text-center text-sm text-muted-foreground">This browser cannot keep the pitch while changing speed, so the key cannot be changed and tempo changes also shift the pitch.</p>
}

/** What the key controls are doing: the change heard and where it starts from. */
function KeyHeadline() {
  const semitones = usePlayer((s) => s.semitones)
  const enabled = usePlayer((s) => s.keyEnabled)
  const none = usePlayer((s) => s.transposed.length === 0)
  const key = usePlayer((s) => s.analysis?.key ?? null)
  if (semitones === 0) return <PanelHeadline title="Original key" detail={key ? keyName(key) : "Turn the dial to transpose"} />
  if (!enabled) return <PanelHeadline title="Original key" detail={`Off · ${plural(semitones)} set`} />
  return <PanelHeadline title={plural(semitones)} detail={none ? "No stems follow the key" : key ? `From ${keyName(key)}` : "From the original key"} />
}

/** Which stems follow the key change; the others keep their original key (drums, by default). */
function TransposedStems() {
  const transposed = usePlayer((s) => s.transposed)
  const canShift = usePlayer((s) => s.canShift)
  const { toggleTransposed } = usePlayer.getState()
  const label = transposedLabel(transposed)
  return (
    <PanelSetting label="Stems">
      <ActionMenu
        title="Stems that follow the key"
        label="Follow the key"
        trigger={<Button variant="outline" size="sm" disabled={canShift === false} aria-label={`Stems that follow the key: ${label}`}>{label}<ChevronDown data-icon="inline-end" /></Button>}
        entries={STEM_NAMES.map((n) => {
          const Icon = STEM_ICONS[n]
          return { key: n, label: STEM_LABEL[n], icon: <Icon />, checked: transposed.includes(n), onCheckedChange: () => toggleTransposed(n) }
        })}
      />
    </PanelSetting>
  )
}

/**
 * Key: the switch in the header plays the original key without losing the dial (to compare the two), then what is
 * heard, the dial in semitones (showing the song's key, transposed, when the analysis has one) and which stems follow it.
 * Laid out like the metronome panel, its counterpart on the other end of the transport.
 */
export function KeyPanel({ trigger }: { trigger: ReactElement }) {
  const semitones = usePlayer((s) => s.semitones)
  const enabled = usePlayer((s) => s.keyEnabled)
  const key = usePlayer((s) => s.analysis?.key ?? null)
  const canShift = usePlayer((s) => s.canShift)
  const { setSemitones, setKeyEnabled } = usePlayer.getState()
  const shown = key ? splitChord(transposeChord(key, semitones)) : null
  return (
    <ResponsivePanel
      title="Key"
      size="wide"
      trigger={trigger}
      action={<Switch aria-label="Key change" checked={enabled && semitones !== 0} disabled={canShift === false || semitones === 0} onCheckedChange={setKeyEnabled} />}
    >
      <KeyHeadline />
      <TickDial
        label="Key"
        min={-MAX_SEMITONES}
        max={MAX_SEMITONES}
        value={semitones}
        original={0}
        disabled={canShift === false}
        onChange={setSemitones}
        display={shown ? <span>{shown.root}<span className="text-sm font-medium">{shown.suffix}</span></span> : signed(semitones)}
        valueText={`${shown ? `${keyName(`${shown.root}${shown.suffix}`)}, ` : ""}${signed(semitones)} semitones`}
      />
      <TransposedStems />
      <ShiftUnavailable />
    </ResponsivePanel>
  )
}
