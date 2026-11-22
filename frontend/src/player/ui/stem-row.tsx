import { Download, Drum, Guitar, MoreHorizontal, Mic, Music, RotateCcw, VolumeX, Headphones } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { stemDownloadUrl, type StemName } from "@/lib/api"
import { currentPreset, effectiveGain, STEM_LABEL } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import { cn } from "@/lib/utils"

const ICONS = { vocals: Mic, drums: Drum, bass: Guitar, other: Music } as const

/** Downloads `url`; `filename` names it (same-origin and blob URLs only, the server's name otherwise). */
export function triggerDownload(url: string, filename = "") {
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function StemRow({ name, songId, selected, onSelect }: { name: StemName; songId: string; selected: boolean; onSelect: () => void }) {
  const mixer = usePlayer((s) => s.mixer)
  const { setVolume, resetVolume, toggleMute, toggleSolo } = usePlayer.getState()
  const Icon = ICONS[name]
  const gain = effectiveGain(name, mixer)
  const silent = gain === 0
  const muted = mixer.muted.includes(name)
  const soloed = mixer.soloed.includes(name)

  const entries: MenuEntry[] = [
    { key: "solo", label: soloed ? "Unsolo" : "Solo", icon: <Headphones />, onSelect: () => toggleSolo(name) },
    { key: "mute", label: muted ? "Unmute" : "Mute", icon: <VolumeX />, onSelect: () => toggleMute(name) },
    { key: "reset", label: "Reset volume", icon: <RotateCcw />, onSelect: () => resetVolume(name) },
    { key: "sep", separator: true },
    { key: "dl-m4a", label: "Download M4A", icon: <Download />, onSelect: () => triggerDownload(stemDownloadUrl(songId, name, "m4a")) },
    { key: "dl-flac", label: "Download FLAC (lossless)", icon: <Download />, onSelect: () => triggerDownload(stemDownloadUrl(songId, name, "flac")) },
  ]

  return (
    <li
      data-stem={name}
      data-selected={selected || undefined}
      className="relative flex min-h-14 items-center gap-1 rounded-2xl md:min-h-16 pr-1 pl-1 transition-colors before:absolute before:inset-y-4 before:left-0 before:w-0.5 before:rounded-full before:bg-stem before:opacity-0 before:transition-opacity md:self-center md:data-selected:bg-secondary/40 md:data-selected:before:opacity-100"
      onPointerDown={onSelect}
    >
      <Button
        variant="stem"
        size="icon-lg"
        onClick={() => toggleMute(name)}
        aria-pressed={silent}
        aria-label={`${silent ? "Unmute" : "Mute"} ${STEM_LABEL[name]}`}
      >
        {silent ? <VolumeX /> : <Icon />}
      </Button>
      <div className={cn("flex min-w-0 flex-1 flex-col transition-opacity", silent && "opacity-40")}>
        <div className="flex items-center justify-between px-1 text-xs">
          <span className="font-medium">{STEM_LABEL[name]}{soloed && <span className="ml-1.5 text-stem">Solo</span>}{muted && !soloed && <span className="ml-1.5 text-muted-foreground">Muted</span>}</span>
          <span className="text-muted-foreground tabular-nums">{Math.round(mixer.volumes[name] * 100)}</span>
        </div>
        <Slider
          aria-label={`${STEM_LABEL[name]} volume`}
          min={0}
          max={100}
          step={1}
          value={Math.round(mixer.volumes[name] * 100)}
          onValueChange={(v) => setVolume(name, (Array.isArray(v) ? v[0] : v) / 100)}
        />
      </div>
      <Button variant="toggle" size="icon-lg" onClick={() => toggleSolo(name)} aria-pressed={soloed} aria-label={`${soloed ? "Unsolo" : "Solo"} ${STEM_LABEL[name]}`}>
        <Headphones />
      </Button>
      <ActionMenu title={STEM_LABEL[name]} entries={entries} trigger={<Button variant="ghost" size="icon-lg" aria-label={`${STEM_LABEL[name]} options`}><MoreHorizontal /></Button>} />
    </li>
  )
}

/**
 * The mixer's own header: its name and a reset to all stems playing (clears mute and solo). Sits above the stem rows in every view (in
 * the tempo view it fills the height of the editor's ruler and tempo lane, so the rows line up with the lanes).
 */
export function MixerTools() {
  const mixer = usePlayer((s) => s.mixer)
  const preset = usePlayer((s) => s.preset)
  const all = currentPreset(mixer).kind === "all"
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2 pl-3">
      <span className="text-sm font-semibold">Mixer</span>
      <Button variant="ghost" size="sm" title="Clear every mute and solo" disabled={all} onClick={() => preset({ kind: "all" })}>
        <RotateCcw />All stems
      </Button>
    </div>
  )
}
