import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { useRegisterSW } from "virtual:pwa-register/react"
import { checkForUpdate, setRegistration } from "@/lib/pwa-update"

const UPDATE_CHECK_MS = 60 * 60 * 1000
// Returning to the app is the most reliable moment to look: background timers are suspended.
const RESUME_CHECK_MS = 5 * 60 * 1000

/** Registers the service worker, offers a reload when a new version is deployed and flags lost connectivity. */
export function PwaManager() {
  const timer = useRef<number | undefined>(undefined)
  const lastCheck = useRef(0)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(url, reg) {
      if (!reg) return
      setRegistration(url, reg, () => updateServiceWorker(true))
      const check = () => {
        if (reg.installing || !navigator.onLine) return
        lastCheck.current = Date.now()
        checkForUpdate().catch(() => {})
      }
      // Installed apps can stay open for days; look for a new deploy now and then.
      window.clearInterval(timer.current)
      timer.current = window.setInterval(check, UPDATE_CHECK_MS)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastCheck.current > RESUME_CHECK_MS) check()
      })
    },
  })

  useEffect(() => () => window.clearInterval(timer.current), [])

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
