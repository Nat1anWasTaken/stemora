import { ChevronDown } from "lucide-react"
import { ActionMenu } from "@/components/app/action-menu"
import { Button } from "@/components/ui/button"
import { CLICK_SOUNDS, clickSound } from "@/player/click-sounds"
import { usePlayer } from "@/player/store"

/** Which sound the metronome makes (kept in this browser). */
export function ClickSoundPicker() {
  const id = usePlayer((s) => s.clickSound)
  const { setClickSound } = usePlayer.getState()
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">Sound</span>
      <ActionMenu
        title="Click sound"
        trigger={<Button variant="outline" size="sm" aria-label={`Click sound: ${clickSound(id).label}`}>{clickSound(id).label}<ChevronDown data-icon="inline-end" /></Button>}
        entries={[{ key: "sound", radio: { value: id, onValueChange: setClickSound, options: CLICK_SOUNDS.map((s) => ({ value: s.id, label: s.label })) } }]}
      />
    </div>
  )
}
