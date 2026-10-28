import { useEffect } from "react"

/** Resolves any CSS colour (oklch, color-mix, ...) to #rrggbb, which every browser accepts in theme-color. */
function toHex(color: string): string | null {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

// Screens that tinted the bar, innermost last; the bar shows the last one or the page default.
const stack: { hex: string }[] = []
let fallback: string | null = null

function apply() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  fallback ??= meta.content
  meta.content = stack.at(-1)?.hex ?? fallback
}

/**
 * Tints the browser / status bar with a theme token (e.g. "--sheet-top") while the calling screen is mounted,
 * so the system chrome blends into full-bleed surfaces like the player sheet.
 */
export function useThemeColor(token: string) {
  useEffect(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
    const hex = value && toHex(value)
    if (!hex) return
    const entry = { hex }
    stack.push(entry)
    apply()
    return () => {
      stack.splice(stack.indexOf(entry), 1)
      apply()
    }
  }, [token])
}
