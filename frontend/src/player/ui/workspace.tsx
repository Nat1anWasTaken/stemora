import type { ReactNode, Ref } from "react"
import { cn } from "@/lib/utils"

/**
 * The player workspace's toolbar strip. Every view (mixer, tempo, practice) puts its tools in this one frame, so
 * switching views only swaps what is inside it; the strip itself never moves or changes size.
 */
export function WorkspaceToolbar({ label, children, slotRef }: { label: string; children?: ReactNode; slotRef?: Ref<HTMLDivElement> }) {
  return (
    <div role="toolbar" aria-label={label} className="flex min-h-12 min-w-0 shrink-0 items-center rounded-2xl border border-border bg-surface/70 p-1 md:px-1.5">
      {children}
      {/* Portal target for tools owned by a view component (the tempo editor's). */}
      {slotRef && <div ref={slotRef} className="contents" />}
    </div>
  )
}

/** Thin vertical rule between groups of toolbar buttons. */
export function ToolbarDivider() {
  return <div aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border" />
}

/** Contents of a toolbar or the workspace that fade in when they replace others (key it by what it shows). */
export function Swap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("animate-swap flex min-h-0 min-w-0 flex-1", className)}>{children}</div>
}
