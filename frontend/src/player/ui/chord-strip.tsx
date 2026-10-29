import { useEffect, useRef } from "react"
import type { Analysis } from "@/player/analysis"
import { getPosition } from "@/player/store"
import { BarBeats, beatAt, useBeats } from "@/player/ui/beats"

/**
 * One-row version of the chord chart (same beat cells), gliding with the playhead so the current beat always lights
 * up at the same spot. Tap to open the chord chart.
 */
export function ChordStrip({ analysis, onExpand }: { analysis: Analysis; onExpand: () => void }) {
  const { cells, bars, times, active } = useBeats(analysis)
  const scroller = useRef<HTMLDivElement>(null)
  const current = active >= 0 ? cells[active] : null

  // Scroll every frame from the audio clock rather than per beat: a smooth scroll that starts when the highlight moves
  // makes it look like it jumps ahead and slides back to the previous beat.
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const els = Array.from(box.querySelectorAll<HTMLElement>("[data-time]"))
    let raf = 0
    let last = Number.NaN
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const pos = getPosition()
      const i = beatAt(times, pos)
      let x = 0
      if (i >= 0 && els[i]) {
        const next = els[i + 1]
        const left = els[i].offsetLeft
        const span = (next ? next.offsetLeft : left + els[i].offsetWidth) - left
        const len = (times[i + 1] ?? times[i] + 1) - times[i]
        x = left + span * Math.min(1, Math.max(0, (pos - times[i]) / len))
      }
      // Only write when the target moves, so the strip can still be swiped while paused.
      if (Math.abs(x - last) < 0.5) return
      last = x
      box.scrollLeft = x - box.clientWidth / 4
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [times])

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Open chord chart${current ? `, bar ${current.bar} beat ${current.beat}` : ""}`}
      className="pressable flex min-w-0 flex-1 rounded-2xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div ref={scroller} className="fade-x relative flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-none" aria-hidden>
        {bars.map((b) => (
          <BarBeats key={b.start} bar={b} activeTime={current?.time ?? null} beatsPerBar={analysis.beatsPerBar} compact />
        ))}
      </div>
    </button>
  )
}
