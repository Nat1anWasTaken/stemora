import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  Command as CommandRoot,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useCommands } from "@/hooks/use-commands"
import { commands, formatShortcut, type Command } from "@/lib/commands"

export const PALETTE_SHORTCUT = "Mod+K"

/** Opens (or closes) the command palette, e.g. from a button. */
export const toggleCommandPalette = () => commands.run("app.command-palette")

function groupsOf(list: Command[]) {
  const groups = new Map<string, Command[]>()
  for (const c of list) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  return [...groups]
}

/**
 * The command palette (Ctrl/⌘+K or Ctrl/⌘+Shift+P) and the app's single keyboard listener: every shortcut in the app
 * is a registered command (`useCommands`), so everything the keyboard can do is listed and searchable here, with its
 * shortcut. The views that are mounted decide what is offered: their commands come first.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  /** The picked command runs once the palette has closed and handed focus back, so it can move focus itself. */
  const pending = useRef<Command | null>(null)
  // Re-render when views mount or unmount while the palette is open.
  useSyncExternalStore(commands.subscribe, commands.getVersion)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void commands.handleKeydown(e)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useCommands(() => [
    {
      id: "app.command-palette",
      title: "Command palette",
      group: "General",
      keywords: ["search", "commands", "shortcuts", "keyboard"],
      shortcut: [PALETTE_SHORTCUT, "Mod+Shift+P"],
      global: true,
      hidden: true,
      run: () => setOpen((o) => !o),
    },
  ])

  const pick = (c: Command) => {
    pending.current = c
    setOpen(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(o) => {
        if (o) return
        setSearch("")
        const c = pending.current
        pending.current = null
        if (c) commands.run(c.id)
      }}
      title="Command palette"
      description="Search for a command to run"
    >
      {open && <PaletteBody search={search} onSearch={setSearch} onPick={pick} />}
    </CommandDialog>
  )
}

function PaletteBody({ search, onSearch, onPick }: { search: string; onSearch: (s: string) => void; onPick: (c: Command) => void }) {
  const groups = groupsOf(commands.available())
  return (
    <CommandRoot>
      <CommandInput value={search} onValueChange={onSearch} placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        {groups.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((c) => {
              const shortcut = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut
              return (
                <CommandItem key={c.id} value={c.id} keywords={[c.title, group, ...(c.keywords ?? [])]} onSelect={() => onPick(c)}>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {shortcut && <CommandShortcut>{formatShortcut(shortcut)}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandRoot>
  )
}
