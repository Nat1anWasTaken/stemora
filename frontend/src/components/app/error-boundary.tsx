import { Component, useEffect, useState, type ReactNode } from "react"
import { AlertTriangle, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { updateAfterCrash } from "@/lib/pwa-update"

/** Shown instead of a blank page when rendering throws; moves to a newer deploy when there is one. */
function CrashScreen() {
  const [updating, setUpdating] = useState(true)
  useEffect(() => {
    let live = true
    void updateAfterCrash().then((found) => {
      if (live && !found) setUpdating(false)
    })
    return () => {
      live = false
    }
  }, [])
  return (
    <div role="alert" className="flex min-h-app flex-col items-center justify-center gap-4 px-6 pt-safe pb-safe text-center">
      <AlertTriangle className="size-10 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">{updating ? "Checking for a newer version of Stemora…" : "Reload to try again."}</p>
      </div>
      <Button variant="secondary" size="lg" disabled={updating} onClick={() => window.location.reload()}>
        {updating ? <Loader2 className="animate-spin" /> : <RotateCw />}
        Reload
      </Button>
    </div>
  )
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }
  static getDerivedStateFromError() {
    return { crashed: true }
  }
  render() {
    return this.state.crashed ? <CrashScreen /> : this.props.children
  }
}
