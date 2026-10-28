import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Scroll distance per step, measured so it follows the CSS tick width. */
const tickWidth = (el: HTMLElement, min: number, max: number) => (max > min ? (el.scrollWidth - el.clientWidth) / (max - min) : 1)

type TickDialProps = {
  label: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  /** Shown in the round bubble above the centre line. */
  display: ReactNode
  valueText: string
  /** Value the "Reset to original" button returns to. */
  original: number
  disabled?: boolean
}

/**
 * Swipeable tick dial: one tick per step on a native scroll-snap strip (momentum on touch), a fixed centre line, -/+
 * buttons and a reset. Emits while scrolling; external changes scroll the strip to match.
 */
export function TickDial({ label, min, max, value, onChange, display, valueText, original, disabled }: TickDialProps) {
  const strip = useRef<HTMLDivElement>(null)
  const emitted = useRef(value)
  const mounted = useRef(false)
  // Value we are scrolling to programmatically; scroll events are ignored until it is reached or the user takes over.
  const target = useRef<number | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  useLayoutEffect(() => {
    const el = strip.current
    if (!el) return
    emitted.current = value
    const px = tickWidth(el, min, max)
    const left = (Math.min(max, Math.max(min, value)) - min) * px
    const smooth = mounted.current
    mounted.current = true
    if (Math.abs(el.scrollLeft - left) < px / 2) return // already there, e.g. the user scrolled here
    target.current = smooth ? value : null
    el.scrollTo({ left, behavior: smooth ? "smooth" : "instant" })
  }, [value, min, max])

  const set = (v: number) => {
    const c = clamp(v)
    emitted.current = c
    if (c !== value) onChange(c)
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div aria-hidden className="flex size-14 items-center justify-center rounded-full bg-foreground text-lg font-semibold text-background tabular-nums">{display}</div>
      <div className="flex w-full items-center gap-2">
        <Button variant="ghost" size="icon-lg" aria-label={`Lower ${label}`} disabled={disabled || value <= min} onClick={() => set(value - 1)}><Minus /></Button>
        <div className="relative min-w-0 flex-1">
          <div
            ref={strip}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={valueText}
            aria-disabled={disabled}
            className={cn("dial-track fade-x flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain scrollbar-none rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50", disabled && "pointer-events-none opacity-50")}
            onPointerDown={() => (target.current = null)}
            onTouchStart={() => (target.current = null)}
            onWheel={() => (target.current = null)}
            onScroll={(e) => {
              const el = e.currentTarget
              const v = clamp(min + Math.round(el.scrollLeft / tickWidth(el, min, max)))
              if (target.current !== null) {
                if (v === target.current) target.current = null
                return
              }
              if (v !== emitted.current) set(v)
            }}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0
              if (d === 0) return
              e.preventDefault()
              set(value + d)
            }}
          >
            {Array.from({ length: max - min + 1 }, (_, i) => (
              <span key={i} className="flex h-16 w-3 shrink-0 snap-center items-center justify-center">
                <span className={cn("w-px rounded-full bg-muted-foreground/50", (min + i) % 5 === 0 ? "h-10" : "h-7")} />
              </span>
            ))}
          </div>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-foreground" />
        </div>
        <Button variant="ghost" size="icon-lg" aria-label={`Raise ${label}`} disabled={disabled || value >= max} onClick={() => set(value + 1)}><Plus /></Button>
      </div>
      <Button variant="ghost" size="sm" disabled={disabled || value === original} onClick={() => set(original)}>Reset to original</Button>
    </div>
  )
}
