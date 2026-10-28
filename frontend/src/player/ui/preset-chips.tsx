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
        "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/60 text-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  )
}

/** All / solo one stem / minus one stem. */
export function PresetChips() {
  const mixer = usePlayer((s) => s.mixer)
  const preset = usePlayer((s) => s.preset)
  const cur = currentPreset(mixer)
  const is = (p: Preset) => cur.kind === p.kind && ("stem" in p ? "stem" in cur && cur.stem === p.stem : true)
  return (
    <div className="fade-x -mx-4 overflow-x-auto scrollbar-none md:mx-0" role="group" aria-label="Mix presets">
      <div className="flex gap-2 px-4 md:px-0">
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
