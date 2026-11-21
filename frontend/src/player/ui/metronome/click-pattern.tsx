import { Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  addSubdivision, cycleLevel, MAX_SUBDIVISIONS, patternFor, removeSubdivision, setLevel, storedPattern, type ClickLevel, type ClickPattern,
  type ManualMarker,
} from "@/player/tempo-map"
import { replaceMarker, setKind } from "@/player/ui/tempo-editor/actions"
import { usePlayingClick } from "@/player/ui/metronome/use-playhead-marker"

/** Most beat columns on one line; wider bars wrap onto balanced lines (9 → 5 + 4) so phones need no scrolling. */
const PER_LINE = 7

const LEVEL_NAME: Record<ClickLevel, string> = { accent: "accent", normal: "normal", soft: "soft", muted: "muted" }

/** The marker with `pattern` stored on it (left off when it is the default, so plain markers stay plain). */
function withPattern(m: ManualMarker, pattern: ClickPattern): ManualMarker {
  const next: ManualMarker = { time: m.time, kind: "manual", bpm: m.bpm, num: m.num, den: m.den }
  const stored = storedPattern(pattern)
  return stored ? { ...next, clicks: stored } : next
}

function lines(n: number): number[][] {
  const count = Math.ceil(n / PER_LINE)
  const per = Math.ceil(n / count)
  return Array.from({ length: count }, (_, l) => Array.from({ length: Math.min(per, n - l * per) }, (_, j) => l * per + j))
}

/**
 * A manual marker's click pattern, laid out like Impulse: a column per beat of the bar, a row per click within the
 * beat (the beat on top, its subdivisions below). Tap a dot to cycle accent → normal → soft → muted. The small − / + above
 * and below a column take a subdivision off or add one to that beat; the outer ones do it for every beat.
 */
export function ClickPatternGrid({ marker, index }: { marker: ManualMarker; index: number }) {
  const pattern = patternFor(marker)
  const playing = usePlayingClick(index)
  const update = (p: ClickPattern) => replaceMarker(index, withPattern(marker, p))
  const canRemoveAll = pattern.some((c) => c.length > 1)
  const canAddAll = pattern.some((c) => c.length < MAX_SUBDIVISIONS)
  return (
    <div className="flex flex-col items-center gap-1" role="group" aria-label="Click pattern">
      <Button variant="ghost" size="icon-sm" aria-label="Remove a subdivision from every beat" disabled={!canRemoveAll} onClick={() => update(removeSubdivision(pattern, "all"))}><Minus /></Button>
      {lines(pattern.length).map((cols) => (
        <div key={cols[0]} className="flex items-stretch justify-center">
          {cols.map((b) => (
            <div key={b} className="flex flex-col items-center">
              <Button variant="ghost" size="icon-sm" aria-label={`Remove a subdivision from beat ${b + 1}`} disabled={pattern[b].length <= 1} onClick={() => update(removeSubdivision(pattern, b))}><Minus /></Button>
              {pattern[b].map((level, s) => (
                <Button
                  key={s}
                  variant="click"
                  size={s === 0 ? "click-beat" : "click-sub"}
                  data-level={level}
                  data-playing={playing === `${b}:${s}` ? "" : undefined}
                  aria-label={`Beat ${b + 1}${s === 0 ? "" : `, subdivision ${s + 1} of ${pattern[b].length}`}: ${LEVEL_NAME[level]}`}
                  onClick={() => update(setLevel(pattern, b, s, cycleLevel(level)))}
                />
              ))}
              <div className="flex-1" />
              <Button variant="ghost" size="icon-sm" aria-label={`Add a subdivision to beat ${b + 1}`} disabled={pattern[b].length >= MAX_SUBDIVISIONS} onClick={() => update(addSubdivision(pattern, b))}><Plus /></Button>
            </div>
          ))}
        </div>
      ))}
      <Button variant="ghost" size="icon-sm" aria-label="Add a subdivision to every beat" disabled={!canAddAll} onClick={() => update(addSubdivision(pattern, "all"))}><Plus /></Button>
    </div>
  )
}

/** In place of the grid for an auto marker: it clicks on the detected beats; making it manual gives it a pattern. */
export function AutoClickNote({ index }: { index: number }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <p className="text-sm text-muted-foreground">This section follows the detected beats: the click sounds on every beat, accented on downbeats.</p>
      <Button variant="outline" size="sm" onClick={() => setKind(index, "manual")}>Make manual to set a pattern</Button>
    </div>
  )
}
