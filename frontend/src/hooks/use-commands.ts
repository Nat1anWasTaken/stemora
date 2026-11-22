import { useEffect, useLayoutEffect, useRef } from "react"
import { commands, type Command, type CommandLevel } from "@/lib/commands"

/**
 * Registers commands (keyboard shortcuts and command palette entries) while the component is mounted. `build` is
 * called on every key press and palette open, never during render, so commands use the latest render's state without
 * re-registering. Pass `false` to register nothing (e.g. on phones, where a view has no keyboard). `level` says how deep
 * the component sits: `app` (shell, palette), `page` (a route such as the player) or `view` (a view inside a page, such
 * as the tempo editor); deeper levels win a shared key and are listed first.
 */
export function useCommands(build: (() => readonly Command[]) | false, level: CommandLevel = "app") {
  const ref = useRef(build)
  useLayoutEffect(() => {
    ref.current = build
  })
  const on = build !== false
  useEffect(() => {
    if (!on) return
    return commands.register(() => (ref.current ? ref.current() : []), level)
  }, [on, level])
}
