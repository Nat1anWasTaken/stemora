import { ChevronDown } from "lucide-react"
import { ActionMenu } from "@/components/app/action-menu"
import { PanelSetting } from "@/components/app/panel-parts"
import { Button } from "@/components/ui/button"
import { CLICK_SOUNDS, clickSound } from "@/player/click-sounds"
import { usePlayer } from "@/player/store"

/** Which sound the metronome makes (kept in this browser). */
export function ClickSoundPicker() {
  const id = usePlayer((s) => s.clickSound)
  const { setClickSound } = usePlayer.getState()
  return (
    <PanelSetting label="Sound">
      <ActionMenu
        title="Click sound"
        trigger={<Button variant="outline" size="sm" aria-label={`Click sound: ${clickSound(id).label}`}>{clickSound(id).label}<ChevronDown data-icon="inline-end" /></Button>}
        entries={[{ key: "sound", radio: { value: id, onValueChange: setClickSound, options: CLICK_SOUNDS.map((s) => ({ value: s.id, label: s.label })) } }]}
      />
    </PanelSetting>
  )
}
