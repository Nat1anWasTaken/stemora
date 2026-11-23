import type { ReactNode } from "react"

/**
 * Building blocks shared by the player's control panels (metronome, key), so they read as one family inside a
 * ResponsivePanel: the panel's switch in its header, a PanelHeadline saying what the controls act on, the main control,
 * then PanelSetting rows for the options that are rarely changed.
 */

/** Two centred lines: what the controls act on, and a quieter detail. Announced when it changes. */
export function PanelHeadline({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center text-center" aria-live="polite">
      <span className="text-sm font-semibold">{title}</span>
      {detail && <span className="max-w-full truncate text-xs text-muted-foreground tabular-nums">{detail}</span>}
    </div>
  )
}

/** A label on the left and its control (usually an ActionMenu trigger) on the right. */
export function PanelSetting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
