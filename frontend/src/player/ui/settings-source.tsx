import { ChevronDown } from "lucide-react"
import { ActionMenu, type MenuEntry } from "@/components/app/action-menu"
import { Button } from "@/components/ui/button"
import type { SettingsSource } from "@/lib/api"
import { effectiveSource, upNext, useUpNext } from "@/player/up-next"

export const SOURCE_LABEL: Record<SettingsSource, string> = { song: "Song settings", setlist: "Setlist settings", listening: "Listening settings" }

/** The settings source in force for the current song, and whether it is the switch's choice (a song outside the setlist is not). */
export function useEffectiveSource(): { source: SettingsSource; chosen: SettingsSource; inSetlist: boolean } {
  const chosen = useUpNext((s) => s.source)
  const item = useUpNext((s) => s.items[s.index])
  const setlist = useUpNext((s) => s.setlist)
  return { source: effectiveSource(chosen, item, setlist), chosen, inSetlist: !!setlist && !!item?.entryId }
}

/** The menu of settings sources and the copy actions (docs/playback.md), shared by the player header and the palette. */
export function sourceEntries(chosen: SettingsSource, source: SettingsSource, playingSetlist: boolean, inSetlist: boolean): MenuEntry[] {
  const options = (["song", ...(playingSetlist ? (["setlist"] as const) : []), "listening"] as const).map((v) => ({ value: v, label: SOURCE_LABEL[v] }))
  const copies: MenuEntry[] = [
    ...(source !== "song" ? [{ key: "to-song", label: "Save as song settings", onSelect: () => void upNext.copyTo("song") }] : []),
    ...(inSetlist && source !== "setlist" ? [{ key: "to-entry", label: "Copy to setlist entry", onSelect: () => void upNext.copyTo("entry") }] : []),
  ]
  return [
    { key: "source", radio: { label: "Play with", value: chosen, onValueChange: (v) => void upNext.setSource(v as SettingsSource), options } },
    ...(copies.length ? [{ key: "sep", separator: true } as MenuEntry, ...copies] : []),
  ]
}

/**
 * Which settings set the player reads and writes: one switch, one home (the player header's subtitle line). Quiet for
 * Song settings, accented otherwise; a song played from a setlist that is not in it says so.
 */
export function SettingsSourceMenu() {
  const { source, chosen, inSetlist } = useEffectiveSource()
  const playingSetlist = useUpNext((s) => s.setlist !== null)
  const outside = chosen === "setlist" && source === "song"
  const label = outside ? "Song settings (not in setlist)" : SOURCE_LABEL[source]
  return (
    <ActionMenu
      title="Settings"
      label="Settings"
      align="start"
      entries={sourceEntries(chosen, source, playingSetlist, inSetlist)}
      trigger={
        <Button variant="meta" size="inline" data-accent={source !== "song" || undefined} aria-label={`Settings: ${label}. Change`}>
          {label}<ChevronDown />
        </Button>
      }
    />
  )
}
