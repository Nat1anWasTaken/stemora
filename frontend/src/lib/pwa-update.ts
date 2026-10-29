// The service worker registration lives in <PwaManager>; this module shares it so the
// account page can run a manual update check. Installed apps (iOS especially) suspend
// timers in the background and only look for a new service worker on navigation, so
// a deploy can go unnoticed for a long time.

let registration: ServiceWorkerRegistration | undefined
let swUrl = ""
let apply: (() => Promise<void>) | undefined

export function setRegistration(url: string, reg: ServiceWorkerRegistration, applyUpdate: () => Promise<void>) {
  swUrl = url
  registration = reg
  apply = applyUpdate
}

export const updatesSupported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator

/** Resolves once a freshly found worker has finished installing (or failed to). */
function settled(reg: ServiceWorkerRegistration) {
  const sw = reg.installing
  if (!sw) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      if (sw.state === "installing") return
      sw.removeEventListener("statechange", done)
      resolve()
    }
    sw.addEventListener("statechange", done)
  })
}

export type UpdateCheck = "available" | "latest" | "unavailable"

/** Asks the server for a newer service worker. Throws when the server can't be reached. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const reg = registration
  if (!reg) return "unavailable"
  if (!reg.waiting) {
    // Probe first: `reg.update()` rejects with an unhelpful error when offline.
    const r = await fetch(swUrl, { cache: "no-store" })
    if (!r.ok) throw new Error(`Update check failed (${r.status})`)
    await reg.update()
    await settled(reg)
  }
  return reg.waiting ? "available" : "latest"
}

/** Activates the waiting service worker and reloads the page. */
export function applyUpdate() {
  // workbox-window only arms its own reload once it has reported the waiting worker, which
  // lags behind `checkForUpdate()`; reload on the controller switch regardless.
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true })
  return apply?.() ?? Promise.resolve()
}
