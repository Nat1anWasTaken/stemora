import type { MenuEntry } from "@/components/app/action-menu"
import { useCommands } from "@/hooks/use-commands"
import type { StemName } from "@/lib/api"
import type { Command } from "@/lib/commands"
import { currentPreset, STEM_LABEL, STEM_NAMES } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import type { Chart } from "@/player/ui/chart-header"

type Tab = "mixer" | "tempo" | "practice"

export type PlayerCommandOptions = {
  /** The stem M / S act on (pick it with 1-4). */
  selected: StemName
  select: (n: StemName) => void
  desktop: boolean
  /** Desktop main area. */
  view: "tempo" | "practice"
  toggleView: () => void
  /** Phone tab. */
  tab: Tab
  setTab: (t: Tab) => void
  /** Whether the practice chart is showing (either layout). */
  practice: boolean
  chart: Chart
  cycleChart: () => void
  /** Line break before the bar at the playhead in the drum notation. */
  toggleBreak: () => void
  close: () => void
  /** The song's "More options" menu, offered in the palette too. */
  menu: MenuEntry[]
}

const ready = () => usePlayer.getState().status === "ready"
const player = () => usePlayer.getState()

/**
 * The player's keyboard shortcuts and palette commands. Space play/pause, Left/Right skip 10 s (Shift: 30 s), Home
 * restart, L cycle loop, 1-4 pick a stem, M / S mute / solo it, V Tempo/Practice (desktop), C chords/drums and B line
 * break (practice). The tempo editor adds its own (tempo-editor.tsx).
 */
export function usePlayerCommands(o: PlayerCommandOptions) {
  const stem = STEM_LABEL[o.selected].toLowerCase()
  useCommands(() => [
    { id: "player.toggle-play", title: "Play / pause", group: "Playback", keywords: ["start", "stop"], shortcut: "Space", enabled: ready, run: () => player().toggle() },
    { id: "player.back-10", title: "Skip back 10 s", group: "Playback", keywords: ["rewind"], shortcut: "ArrowLeft", repeat: true, enabled: ready, run: () => player().skip(-10) },
    { id: "player.forward-10", title: "Skip forward 10 s", group: "Playback", keywords: ["fast forward"], shortcut: "ArrowRight", repeat: true, enabled: ready, run: () => player().skip(10) },
    { id: "player.back-30", title: "Skip back 30 s", group: "Playback", keywords: ["rewind"], shortcut: "Shift+ArrowLeft", repeat: true, enabled: ready, run: () => player().skip(-30) },
    { id: "player.forward-30", title: "Skip forward 30 s", group: "Playback", keywords: ["fast forward"], shortcut: "Shift+ArrowRight", repeat: true, enabled: ready, run: () => player().skip(30) },
    { id: "player.restart", title: "Back to the start", group: "Playback", keywords: ["restart", "beginning"], shortcut: "Home", enabled: ready, run: () => player().seek(0) },
    { id: "player.cycle-loop", title: "Loop: set A, set B, clear", group: "Playback", keywords: ["repeat", "a-b"], shortcut: "L", enabled: ready, run: () => player().cycleLoop() },
    { id: "player.clear-loop", title: "Clear loop", group: "Playback", keywords: ["repeat", "a-b"], enabled: () => ready() && (player().loop !== null || player().pendingA !== null), run: () => player().clearLoop() },
    { id: "player.metronome", title: "Metronome on / off", group: "Playback", keywords: ["click", "tempo"], enabled: ready, run: () => player().setMetronome(!player().metronome) },
    { id: "player.reset-speed", title: "Reset speed", group: "Playback", keywords: ["tempo", "original"], enabled: () => ready() && player().speed !== 1, run: () => player().setSpeed(1) },
    { id: "player.reset-key", title: "Reset song key", group: "Playback", keywords: ["transpose", "pitch", "original"], enabled: () => ready() && player().semitones !== 0, run: () => player().setSemitones(0) },
    { id: "player.key-switch", title: "Key change on / off", group: "Playback", keywords: ["transpose", "pitch", "compare", "original"], enabled: () => ready() && player().canShift !== false && player().semitones !== 0, run: () => player().setKeyEnabled(!player().keyEnabled) },
    ...STEM_NAMES.map((n): Command => {
      const name = STEM_LABEL[n].toLowerCase()
      const title = player().transposed.includes(n) ? `Keep ${name} in the original key` : `Transpose ${name} with the song key`
      return { id: `player.follow-key.${n}`, title, group: "Playback", keywords: ["transpose", "pitch", "key", "stem"], enabled: () => ready() && player().canShift !== false, run: () => player().toggleTransposed(n) }
    }),

    ...STEM_NAMES.map((n, i): Command => ({ id: `mixer.select.${n}`, title: `Select ${STEM_LABEL[n].toLowerCase()}`, group: "Mixer", keywords: ["stem"], shortcut: String(i + 1), enabled: ready, run: () => o.select(n) })),
    { id: "mixer.mute-selected", title: `Mute / unmute ${stem}`, group: "Mixer", keywords: ["selected stem"], shortcut: "M", enabled: ready, run: () => player().toggleMute(o.selected) },
    { id: "mixer.solo-selected", title: `Solo / unsolo ${stem}`, group: "Mixer", keywords: ["selected stem"], shortcut: "S", enabled: ready, run: () => player().toggleSolo(o.selected) },
    ...STEM_NAMES.filter((n) => n !== o.selected).flatMap((n): Command[] => [
      { id: `mixer.mute.${n}`, title: `Mute / unmute ${STEM_LABEL[n].toLowerCase()}`, group: "Mixer", keywords: ["stem"], enabled: ready, run: () => player().toggleMute(n) },
      { id: `mixer.solo.${n}`, title: `Solo / unsolo ${STEM_LABEL[n].toLowerCase()}`, group: "Mixer", keywords: ["stem"], enabled: ready, run: () => player().toggleSolo(n) },
    ]),
    { id: "mixer.all-stems", title: "All stems (clear mutes and solos)", group: "Mixer", keywords: ["reset", "unmute"], enabled: () => ready() && currentPreset(player().mixer).kind !== "all", run: () => player().preset({ kind: "all" }) },

    ...(o.desktop
      ? [{ id: "view.toggle", title: o.view === "tempo" ? "Switch to Practice" : "Switch to Tempo", group: "View", keywords: ["tempo", "practice", "view"], shortcut: "V", run: o.toggleView }]
      : (["mixer", "tempo", "practice"] as const).filter((t) => t !== o.tab).map((t): Command => ({ id: `view.${t}`, title: `Show ${t}`, group: "View", run: () => o.setTab(t) }))),
    ...(o.practice
      ? [{ id: "practice.cycle-chart", title: o.chart === "chords" ? "Show drums" : "Show chords", group: "Practice", keywords: ["chart", "chords", "drums", "notation"], shortcut: "C", run: o.cycleChart }]
      : []),
    ...(o.practice && o.chart === "drums"
      ? [{ id: "practice.line-break", title: "Line break at the playhead", group: "Practice", keywords: ["drums", "row", "notation"], shortcut: "B", enabled: ready, run: o.toggleBreak }]
      : []),

    ...o.menu.flatMap((e): Command[] => ("onSelect" in e && !e.disabled ? [{ id: `song.${e.key}`, title: e.label, group: "Song", run: e.onSelect }] : [])),
    { id: "song.close", title: "Close player", group: "Song", keywords: ["back", "library"], run: o.close },
  ], "page")
}
