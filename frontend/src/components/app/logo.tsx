import { cn } from "@/lib/utils"

/** Four stem bars: the Stemora mark. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex h-6 items-end gap-0.5", className)} aria-hidden>
      <span className="h-3 w-1 rounded-full bg-vocals" />
      <span className="h-6 w-1 rounded-full bg-drums" />
      <span className="h-4 w-1 rounded-full bg-bass" />
      <span className="h-5 w-1 rounded-full bg-other" />
    </span>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="font-heading text-xl font-semibold tracking-tight">stemora</span>
    </span>
  )
}
