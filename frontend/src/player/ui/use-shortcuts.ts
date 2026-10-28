import { useEffect } from "react"
import { STEM_NAMES } from "@/player/mixer"
import { usePlayer } from "@/player/store"
import type { StemName } from "@/lib/api"

/** Desktop keyboard shortcuts. `selected` is the stem that M / S act on (change it with 1-4). */
export function useShortcuts(selected: StemName, select: (n: StemName) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return
      const onWidget = !!t?.closest('[role="slider"],[role="menuitem"],[role="dialog"],[role="switch"]')
      const st = usePlayer.getState()
      if (st.status !== "ready") return
      switch (e.key) {
        case " ":
          if (tag === "BUTTON" || onWidget) return
          e.preventDefault()
          st.toggle()
          break
        case "ArrowLeft":
          if (onWidget) return
          e.preventDefault()
          st.skip(e.shiftKey ? -30 : -10)
          break
        case "ArrowRight":
          if (onWidget) return
          e.preventDefault()
          st.skip(e.shiftKey ? 30 : 10)
          break
        case "m":
        case "M":
          st.toggleMute(selected)
          break
        case "s":
        case "S":
          st.toggleSolo(selected)
          break
        case "l":
        case "L":
          st.cycleLoop()
          break
        case "Home":
          st.seek(0)
          break
        default:
          if (e.key >= "1" && e.key <= "4") select(STEM_NAMES[Number(e.key) - 1])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected, select])
}
