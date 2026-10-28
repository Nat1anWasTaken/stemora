import { useSyncExternalStore } from "react"

// Chromium fires `beforeinstallprompt` once, early; capture it at module load so the
// account page can offer an Install button later. Safari has no such event: there the
// app is added through Share > Add to Home Screen.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

const standaloneQuery = typeof window !== "undefined" ? window.matchMedia("(display-mode: standalone)") : null

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    emit()
  })
  window.addEventListener("appinstalled", () => {
    deferred = null
    emit()
  })
  standaloneQuery?.addEventListener("change", emit)
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const isStandalone = () =>
  standaloneQuery?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

export type InstallState = "installed" | "prompt" | "ios" | "unavailable"

const getState = (): InstallState => {
  if (isStandalone()) return "installed"
  if (deferred) return "prompt"
  if (isIos()) return "ios"
  return "unavailable"
}

export const useInstallState = () => useSyncExternalStore(subscribe, getState, () => "unavailable" as const)

/** Shows the browser's install dialog; resolves true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  emit()
  await e.prompt()
  return (await e.userChoice).outcome === "accepted"
}
