import { useEffect } from "react"
import { toast } from "sonner"
import { useRegisterSW } from "virtual:pwa-register/react"

const UPDATE_CHECK_MS = 60 * 60 * 1000

/** Registers the service worker, offers a reload when a new version is deployed and flags lost connectivity. */
export function PwaManager() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(url, reg) {
      if (!reg) return
      // Installed apps can stay open for days; look for a new deploy now and then.
      setInterval(() => {
        if (reg.installing || !navigator.onLine) return
        fetch(url, { cache: "no-store" })
          .then(async (r) => {
            if (r.ok) await reg.update()
          })
          .catch(() => {})
      }, UPDATE_CHECK_MS)
    },
  })

  useEffect(() => {
    if (!needRefresh) return
    toast("A new version of Stemora is available", {
      id: "pwa-update",
      duration: Infinity,
      action: { label: "Reload", onClick: () => void updateServiceWorker(true) },
    })
  }, [needRefresh, updateServiceWorker])

  useEffect(() => {
    const offline = () => toast.warning("You're offline", { id: "offline", duration: Infinity, description: "Songs need a connection to load." })
    const online = () => toast.dismiss("offline")
    if (!navigator.onLine) offline()
    window.addEventListener("offline", offline)
    window.addEventListener("online", online)
    return () => {
      window.removeEventListener("offline", offline)
      window.removeEventListener("online", online)
    }
  }, [])

  return null
}
