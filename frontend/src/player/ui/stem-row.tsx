import { Download, Drum, Guitar, MoreHorizontal, Mic, Music, RotateCcw, VolumeX, Headphones } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { stemDownloadUrl, type StemName } from "@/lib/api"
import { effectiveGain, STEM_LABEL } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import { cn } from "@/lib/utils"

const ICONS = { vocals: Mic, drums: Drum, bass: Guitar, other: Music } as const

export function triggerDownload(url: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = ""
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
    <li data-stem={name} className={cn("flex min-h-16 items-center gap-1 rounded-2xl pr-1 pl-1 transition-colors", selected && "md:bg-secondary/60")} onPointerDown={onSelect}>
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
      <ActionMenu title={STEM_LABEL[name]} entries={entries} trigger={<Button variant="ghost" size="icon-lg" aria-label={`${STEM_LABEL[name]} options`}><MoreHorizontal /></Button>} />
    </li>
  )
}
