/**
 * The app's command registry: every keyboard shortcut is a command, and every command can be run from the command
 * palette (Ctrl/⌘+K). Components register layers of commands while they are mounted (`useCommands`); one window
 * `keydown` listener (`handleKeydown`) runs the command bound to the pressed chord. Deeper layers (`CommandLevel`) win,
 * then newer ones, so a view inside a page can take over a key, and a command whose `enabled()` is false lets the key
 * fall through to the next one bound to it.
 *
 * Shortcuts are written like `Mod+Shift+Z`, `Space`, `Shift+ArrowLeft` or `1`. `Mod` is ⌘ on Apple platforms and
 * Ctrl elsewhere (either is accepted when matching, as is `Ctrl` written out).
 */
export type Command = {
  /** Unique, stable id, e.g. `player.toggle-play`. */
  id: string
  title: string
  /** Heading the palette lists it under. */
  group: string
  /** Extra words the palette search matches. */
  keywords?: string[]
  /** Key chords that run it; the first is the one shown. */
  shortcut?: string | string[]
  run: () => void
  /** Checked on every key press and palette open; false hides it from the palette and lets its keys fall through. */
  enabled?: () => boolean
  /** Run again while the key is held (auto-repeat). */
  repeat?: boolean
  /** Also fires while typing in a field or inside a dialog or menu (only for keys that never mean anything there). */
  global?: boolean
  /** Not listed in the palette (keyboard aliases). */
  hidden?: boolean
}

/**
 * How deep in the app a layer sits; deeper layers win and are listed first. Needed because React mounts (and so
 * registers) children before their parents.
 */
export type CommandLevel = "app" | "page" | "view"
const LEVEL_RANK: Record<CommandLevel, number> = { app: 0, page: 1, view: 2 }

type Layer = { get: () => readonly Command[]; rank: number }

const MODS = ["Mod", "Alt", "Shift"] as const
const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  Spacebar: "Space",
  Esc: "Escape",
  Del: "Delete",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Return: "Enter",
}

/** Canonical form of a written shortcut: modifiers in a fixed order, the key last (`Mod+Shift+Z`). */
export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split("+").map((p) => p.trim())
  // "Mod++" (a literal plus) leaves an empty last part.
  const rawKey = parts.pop() || "+"
  const mods = new Set(parts.map((p) => p.toLowerCase()).map((p) => (p === "ctrl" || p === "cmd" || p === "meta" || p === "control" || p === "command" ? "mod" : p === "option" ? "alt" : p)))
  return [...MODS.filter((m) => mods.has(m.toLowerCase())), normalizeKey(rawKey)].join("+")
}

const NAMED_KEYS = ["Space", "Escape", "Delete", "Backspace", "Enter", "Tab", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
const KEY_NAMES = new Map([...NAMED_KEYS.map((k) => [k.toLowerCase(), k] as const), ...Object.entries(KEY_ALIASES).map(([a, k]) => [a.toLowerCase(), k] as const)])

function normalizeKey(key: string): string {
  if (key === " ") return "Space"
  if (key.length === 1) return key.toUpperCase()
  return KEY_NAMES.get(key.toLowerCase()) ?? key
}

/**
 * The chord a key event stands for, in the same canonical form. Letters and digits come from the physical key when the
 * layout produced something else (Shift+1 gives "!", ⌥+N on a Mac gives "˜", a Zhuyin or Cyrillic layout gives its
 * own letters), so a shortcut means the same key everywhere.
 */
export function eventChord(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  let key = normalizeKey(e.key)
  const physical = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1]
  if (physical && !/^[A-Z0-9]$/.test(key)) key = physical
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push("Mod")
  if (e.altKey) mods.push("Alt")
  if (e.shiftKey) mods.push("Shift")
  return [...mods, key].join("+")
}

export const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Delete: "Del",
  Backspace: "⌫",
  Enter: "↵",
}

/** A shortcut as the platform writes it: `⌘⇧Z` on Apple, `Ctrl+Shift+Z` elsewhere. */
export function formatShortcut(shortcut: string, apple = isApple()): string {
  const parts = normalizeShortcut(shortcut).split("+")
  const key = parts.pop()!
  const label = KEY_LABELS[key] ?? key
  if (apple) return parts.map((m) => ({ Mod: "⌘", Alt: "⌥", Shift: "⇧" })[m]).join("") + label
  return [...parts.map((m) => (m === "Mod" ? "Ctrl" : m)), label].join("+")
}

const shortcutsOf = (c: Command) => (c.shortcut === undefined ? [] : Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut])

const isEnabled = (c: Command) => {
  try {
    return c.enabled?.() ?? true
  } catch {
    return false
  }
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
/** Open overlays own the keyboard while focus is in them (they move focus inside when they open). */
const OVERLAY = ["dialog", "alertdialog", "menu", "listbox"].map((r) => `[role='${r}']:not([data-closed])`).join(", ")
/** Space and Enter activate these. */
const ACTIVATES = "button, a[href], summary, [role='button'], [role='switch'], [role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], [role='option'], [role='slider']"
/** Arrows, Home and End move inside these. */
const NAVIGATES = "[role='slider'], [role='tablist'], [role='radiogroup'], [role='spinbutton'], [role='listbox'], [role='menu'], [role='grid']"
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])

/** Whether the focused element already gives this chord a meaning of its own, so a command must not take it. */
export function ownedByTarget(target: EventTarget | null, chord: string): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  const el = target as Element
  if (el.closest(EDITABLE) || el.closest(OVERLAY)) return true
  const key = chord.slice(chord.lastIndexOf("+") + 1) || "+"
  if ((key === "Space" || key === "Enter") && el.closest(ACTIVATES)) return true
  return NAV_KEYS.has(key) && !!el.closest(NAVIGATES)
}

export class CommandRegistry {
  private layers: Layer[] = []
  private listeners = new Set<() => void>()
  private version = 0

  /** Adds a layer; `get` is read on every use, so its commands can close over current state. Returns the remover. */
  register(get: () => readonly Command[], level: CommandLevel = "app"): () => void {
    const layer: Layer = { get, rank: LEVEL_RANK[level] }
    // Kept sorted by level, newest last within one.
    const at = this.layers.findIndex((l) => l.rank > layer.rank)
    this.layers.splice(at === -1 ? this.layers.length : at, 0, layer)
    this.changed()
    return () => {
      const i = this.layers.indexOf(layer)
      if (i === -1) return
      this.layers.splice(i, 1)
      this.changed()
    }
  }

  /** Every command, the deepest and then most recently registered layer first; a later layer's command replaces an earlier one with the same id. */
  all(): Command[] {
    const seen = new Set<string>()
    const out: Command[] = []
    for (let i = this.layers.length - 1; i >= 0; i--) {
      for (const c of this.layers[i].get()) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c)
      }
    }
    return out
  }

  /** The commands the palette lists right now. */
  available(): Command[] {
    return this.all().filter((c) => !c.hidden && isEnabled(c))
  }

  /** The enabled command bound to `chord` that wins, if any. */
  match(chord: string): Command | undefined {
    return this.all().find((c) => shortcutsOf(c).some((s) => normalizeShortcut(s) === chord) && isEnabled(c))
  }

  run(id: string): boolean {
    const c = this.all().find((x) => x.id === id)
    if (!c || !isEnabled(c)) return false
    c.run()
    return true
  }

  /** The window keydown handler: runs the matching command and swallows the key. Returns whether it ran one. */
  handleKeydown = (e: KeyboardEvent): boolean => {
    if (e.defaultPrevented || e.isComposing || ["Control", "Meta", "Alt", "Shift"].includes(e.key)) return false
    const chord = eventChord(e)
    const c = this.match(chord)
    if (!c) return false
    if (!c.global && ownedByTarget(e.target, chord)) return false
    e.preventDefault()
    if (e.repeat && !c.repeat) return true
    c.run()
    return true
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Changes whenever a layer is added or removed (for `useSyncExternalStore`). */
  getVersion = () => this.version

  private changed() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}

export const commands = new CommandRegistry()
