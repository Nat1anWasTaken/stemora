import { useRef } from "react"
import { useEdgeFade } from "@/hooks/use-edge-fade"
import { useIsDesktop } from "@/hooks/use-media"
import { currentPreset, STEM_LABEL, STEM_NAMES, type Preset } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import { cn } from "@/lib/utils"

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pressable min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/60 text-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  )
}

/**
 * All / solo one stem / minus one stem, desktop only: on phones each stem row has its own mute and solo buttons and
 * the mixer toolbar has "All stems", so the chips would only add a second horizontal scroller.
 */
export function PresetChips() {
  const mixer = usePlayer((s) => s.mixer)
  const preset = usePlayer((s) => s.preset)
  const desktop = useIsDesktop()
  const row = useRef<HTMLDivElement>(null)
  useEdgeFade(row)
  const cur = currentPreset(mixer)
  const is = (p: Preset) => cur.kind === p.kind && ("stem" in p ? "stem" in cur && cur.stem === p.stem : true)
  if (!desktop) return null
  return (
    <div ref={row} className="fade-x -mx-4 overflow-x-auto scrollbar-none md:mx-0" role="group" aria-label="Mix presets">
      <div className="flex w-max gap-2 px-4 md:px-0">
        <Chip active={is({ kind: "all" })} onClick={() => preset({ kind: "all" })}>All</Chip>
        {STEM_NAMES.map((n) => (
          <Chip key={`s-${n}`} active={is({ kind: "solo", stem: n })} onClick={() => preset({ kind: "solo", stem: n })}>{STEM_LABEL[n]}</Chip>
        ))}
        {STEM_NAMES.map((n) => (
          <Chip key={`m-${n}`} active={is({ kind: "minus", stem: n })} onClick={() => preset({ kind: "minus", stem: n })}>{`No ${STEM_LABEL[n].toLowerCase()}`}</Chip>
        ))}
      </div>
    </div>
  )
}
