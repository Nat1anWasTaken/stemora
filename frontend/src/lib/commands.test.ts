import { describe, expect, it, vi } from "vitest"
import { CommandRegistry, eventChord, formatShortcut, normalizeShortcut, ownedByTarget, type Command } from "@/lib/commands"

const key = (k: string, code = "", mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

/** A keydown event stand-in with the fields the registry reads. */
function keydown(k: string, code = "", mods: Parameters<typeof key>[2] & { repeat?: boolean } = {}) {
  const e = { ...key(k, code, mods), repeat: mods.repeat ?? false, isComposing: false, defaultPrevented: false, target: null, preventDefault: vi.fn() }
  e.preventDefault.mockImplementation(() => (e.defaultPrevented = true))
  return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

const cmd = (id: string, shortcut: string | string[] | undefined, run = vi.fn(), extra: Partial<Command> = {}): Command => ({ id, title: id, group: "Test", shortcut, run, ...extra })

describe("shortcuts", () => {
  it("normalizes modifier names and order", () => {
    expect(normalizeShortcut("shift+ctrl+z")).toBe("Mod+Shift+Z")
    expect(normalizeShortcut("Cmd+Shift+P")).toBe("Mod+Shift+P")
    expect(normalizeShortcut("Option+ArrowLeft")).toBe("Alt+ArrowLeft")
    expect(normalizeShortcut("space")).toBe("Space")
    expect(normalizeShortcut("Esc")).toBe("Escape")
    expect(normalizeShortcut("Space")).toBe("Space")
    expect(normalizeShortcut("Mod++")).toBe("Mod++")
  })

  it("turns key events into the same form", () => {
    expect(eventChord(key(" "))).toBe("Space")
    expect(eventChord(key("z", "KeyZ", { metaKey: true }))).toBe("Mod+Z")
    expect(eventChord(key("Z", "KeyZ", { ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+Z")
    expect(eventChord(key("ArrowLeft", "ArrowLeft", { shiftKey: true }))).toBe("Shift+ArrowLeft")
  })

  it("falls back to the physical key when the layout gives another character", () => {
    expect(eventChord(key("!", "Digit1", { shiftKey: true }))).toBe("Shift+1")
    expect(eventChord(key("˜", "KeyN", { altKey: true }))).toBe("Alt+N")
    expect(eventChord(key("ㄙ", "KeyN"))).toBe("N")
    expect(eventChord(key("?", "Slash", { shiftKey: true }))).toBe("Shift+?")
  })

  it("formats per platform", () => {
    expect(formatShortcut("Mod+Shift+Z", true)).toBe("⌘⇧Z")
    expect(formatShortcut("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z")
    expect(formatShortcut("Shift+ArrowLeft", false)).toBe("Shift+←")
    expect(formatShortcut("Space", true)).toBe("Space")
  })
})

/** An element stand-in matching the given selectors' parts (enough for `closest`). */
const el = (...matches: string[]) => ({ closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null) }) as unknown as Element

describe("ownedByTarget", () => {
  it("leaves every key to fields and open overlays", () => {
    expect(ownedByTarget(el("input"), "M")).toBe(true)
    expect(ownedByTarget(el("[role='dialog']"), "Space")).toBe(true)
  })

  it("leaves Space and Enter to buttons, and arrows to sliders and tabs", () => {
    const button = el("button, a[href]")
    expect(ownedByTarget(button, "Space")).toBe(true)
    expect(ownedByTarget(button, "Enter")).toBe(true)
    expect(ownedByTarget(button, "M")).toBe(false)
    expect(ownedByTarget(button, "ArrowLeft")).toBe(false)
    expect(ownedByTarget(el("[role='slider']"), "Shift+ArrowLeft")).toBe(true)
    expect(ownedByTarget(el("[role='tablist']"), "Home")).toBe(true)
    expect(ownedByTarget(null, "Space")).toBe(false)
  })
})

describe("CommandRegistry", () => {
  it("runs the command bound to the pressed chord and swallows the key", () => {
    const r = new CommandRegistry()
    const run = vi.fn()
    r.register(() => [cmd("undo", ["Mod+Z"], run)])
    const e = keydown("z", "KeyZ", { ctrlKey: true })
    expect(r.handleKeydown(e)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalled()
    expect(r.handleKeydown(keydown("z", "KeyZ"))).toBe(false)
  })

  it("lets a later layer take over a key, and an earlier one have it back when removed", () => {
    const r = new CommandRegistry()
    const outer = vi.fn()
    const inner = vi.fn()
    r.register(() => [cmd("a", "B", outer)])
    const remove = r.register(() => [cmd("b", "B", inner)])
    r.handleKeydown(keydown("b", "KeyB"))
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
    remove()
    r.handleKeydown(keydown("b", "KeyB"))
    expect(outer).toHaveBeenCalledOnce()
  })

  it("puts deeper levels first, whatever order they mount in", () => {
    const r = new CommandRegistry()
    const view = vi.fn()
    const page = vi.fn()
    r.register(() => [cmd("view", "B", view)], "view")
    r.register(() => [cmd("page", "B", page)], "page")
    r.register(() => [cmd("app", undefined)])
    r.handleKeydown(keydown("b", "KeyB"))
    expect(view).toHaveBeenCalledOnce()
    expect(page).not.toHaveBeenCalled()
    expect(r.all().map((c) => c.id)).toEqual(["view", "page", "app"])
  })

  it("lets keys of disabled commands fall through", () => {
    const r = new CommandRegistry()
    const outer = vi.fn()
    const inner = vi.fn()
    r.register(() => [cmd("a", "Escape", outer)])
    r.register(() => [cmd("b", "Escape", inner, { enabled: () => false })])
    const e = keydown("Escape", "Escape")
    r.handleKeydown(e)
    expect(inner).not.toHaveBeenCalled()
    expect(outer).toHaveBeenCalledOnce()
    expect(r.available().map((c) => c.id)).toEqual(["a"])
  })

  it("ignores auto-repeat unless the command asks for it", () => {
    const r = new CommandRegistry()
    const toggle = vi.fn()
    const skip = vi.fn()
    r.register(() => [cmd("toggle", "Space", toggle), cmd("skip", "ArrowRight", skip, { repeat: true })])
    const held = keydown(" ", "Space", { repeat: true })
    expect(r.handleKeydown(held)).toBe(true)
    expect(held.preventDefault).toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    r.handleKeydown(keydown("ArrowRight", "ArrowRight", { repeat: true }))
    expect(skip).toHaveBeenCalledOnce()
  })

  it("does not take keys from a focused field unless global", () => {
    const r = new CommandRegistry()
    const mute = vi.fn()
    const palette = vi.fn()
    r.register(() => [cmd("mute", "M", mute), cmd("palette", "Mod+K", palette, { global: true })])
    const typing = Object.assign(keydown("m", "KeyM"), { target: el("input") })
    expect(r.handleKeydown(typing)).toBe(false)
    expect(typing.preventDefault).not.toHaveBeenCalled()
    r.handleKeydown(Object.assign(keydown("k", "KeyK", { metaKey: true }), { target: el("input") }))
    expect(mute).not.toHaveBeenCalled()
    expect(palette).toHaveBeenCalledOnce()
  })

  it("leaves keys another handler already took", () => {
    const r = new CommandRegistry()
    const run = vi.fn()
    r.register(() => [cmd("a", "ArrowLeft", run)])
    const e = keydown("ArrowLeft", "ArrowLeft")
    e.preventDefault()
    expect(r.handleKeydown(e)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("reads layers fresh, lists the newest first and hides hidden commands", () => {
    const r = new CommandRegistry()
    let title = "Old"
    r.register(() => [cmd("x", undefined, vi.fn(), { title })])
    r.register(() => [cmd("y", undefined), cmd("z", undefined, vi.fn(), { hidden: true })])
    title = "New"
    expect(r.available().map((c) => c.title)).toEqual(["y", "New"])
    expect(r.run("z")).toBe(true)
    expect(r.run("missing")).toBe(false)
  })

  it("notifies subscribers when layers change", () => {
    const r = new CommandRegistry()
    const fn = vi.fn()
    r.subscribe(fn)
    const v = r.getVersion()
    const remove = r.register(() => [])
    remove()
    remove()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(r.getVersion()).toBe(v + 2)
  })
})
