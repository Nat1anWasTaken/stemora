/** How the drum notation looks on this device; the line breaks belong to the song and live on the server. */
export type NotationTheme = "dark" | "light"
/** Bars per row; 0 lets alphaTab fit as many as the width allows. */
export type NotationPrefs = { theme: NotationTheme; barsPerRow: number; zoom: number }

const KEY = "stemora:drum-notation"
export const BARS_PER_ROW = [0, 2, 3, 4, 5, 6, 8]
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
const DEFAULT: NotationPrefs = { theme: "dark", barsPerRow: 0, zoom: 1 }

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

export function loadNotationPrefs(): NotationPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotationPrefs> | null
    return {
      theme: j?.theme === "light" ? "light" : DEFAULT.theme,
      barsPerRow: BARS_PER_ROW.includes(j?.barsPerRow as number) ? (j!.barsPerRow as number) : DEFAULT.barsPerRow,
      zoom: typeof j?.zoom === "number" && Number.isFinite(j.zoom) ? clampZoom(j.zoom) : DEFAULT.zoom,
    }
  } catch {
    return DEFAULT
  }
}

export function saveNotationPrefs(p: NotationPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage unavailable (private mode): the choice just isn't remembered
  }
}
