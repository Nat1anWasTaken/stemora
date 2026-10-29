import { useState, type ReactElement, type ReactNode } from "react"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { useIsDesktop } from "@/hooks/use-media"
import { splitChord, transposeChord } from "@/player/analysis"
import { usePlayer } from "@/player/store"
import { MAX_SEMITONES, speedFor, tempoMarking, tempoRange, tempoUnit, tempoValue } from "@/player/tempo"
import { TickDial } from "@/player/ui/tick-dial"

/** Bottom drawer on touch/mobile, popover on desktop, with a centred title and an optional control on the right. */
function PracticePanel({ title, action, trigger, children }: { title: string; action?: ReactNode; trigger: ReactElement; children: ReactNode }) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)
  const header = (Title: typeof DrawerTitle | typeof PopoverTitle) => (
    <div className="relative flex min-h-9 items-center justify-center">
      <Title className="text-lg font-semibold">{title}</Title>
      {action && <div className="absolute right-0">{action}</div>}
    </div>
  )

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={trigger} />
        <PopoverContent>
          <div className="flex flex-col gap-4 p-1">
            {header(PopoverTitle)}
            {children}
          </div>
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
      <DrawerTrigger render={trigger} />
      <DrawerContent>
        <div className="flex flex-col gap-4 px-5 pt-3 pb-safe">
          {header(DrawerTitle)}
          {children}
          <div className="h-2" />
        </div>
      </DrawerContent>
    </Drawer>
  )
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0")

function ShiftUnavailable() {
  const canShift = usePlayer((s) => s.canShift)
  if (canShift !== false) return null
  return <p className="text-center text-sm text-muted-foreground">This browser cannot keep the pitch while changing speed, so the key cannot be changed and tempo changes also shift the pitch.</p>
}

/** Metronome on/off plus the tempo dial; the dial changes the song's speed (in BPM when the song's tempo is known). */
export function TempoPanel({ trigger }: { trigger: ReactElement }) {
  const enabled = usePlayer((s) => s.metronome.enabled)
  const speed = usePlayer((s) => s.speed)
  const baseBpm = usePlayer((s) => s.analysis?.bpm ?? null)
  const { setMetronome, setSpeed } = usePlayer.getState()
  const { min, max } = tempoRange(baseBpm)
  const value = tempoValue(speed, baseBpm)
  return (
    <PracticePanel title="Metronome" trigger={trigger} action={<Switch aria-label="Metronome click" checked={enabled} onCheckedChange={setMetronome} />}>
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
    </PracticePanel>
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
    <PracticePanel title="Song key" trigger={trigger}>
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
    </PracticePanel>
  )
}
