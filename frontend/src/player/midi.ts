import type { Section } from "@/player/analysis"
import type { BeatGrid } from "@/player/tempo-map"

/**
 * Tempo map export: the song's beat grid as a Standard MIDI File (format 1, one conductor track) holding only the
 * track name, time signatures, tempos and section markers, so a DAW lines its bars and click up with the audio.
 *
 * MIDI counts time in ticks and derives seconds from tempo events, so every beat of the grid becomes `PPQ * 4 / den`
 * ticks at the tempo that makes it last exactly until the next beat. A manual stretch therefore needs one tempo event;
 * detected beats need one per beat (like any DAW's tempo-mapped export). Set Tempo holds whole microseconds per quarter
 * note, so each beat's tempo is worked out from where the beat should end, not from its own length: rounding never
 * adds up along the song (every beat stays within MAX_DRIFT_US of its real time).
 */

/** Ticks per quarter note; divisible down to sixteenths. */
export const PPQ = 960
/** Slowest tempo Set Tempo can hold: 0xFFFFFF microseconds a quarter note. */
const MAX_US_PER_QUARTER = 0xffffff
/** A gap this short before the first beat is no lead-in (the song starts on the beat). */
const EPS = 1e-4
/** How far (µs) a beat may drift from its real time before its tempo is nudged; keeps steady stretches to one event. */
const MAX_DRIFT_US = 50

export type TempoMidiOptions = { title?: string; sections?: Section[] }

/** One beat as MIDI sees it: where it starts in seconds and which `den` note it is. */
type Span = { time: number; den: number }
/** One bar: `count` spans of `den` notes from span `first`. */
type MBar = { first: number; count: number; den: number }

const ticksOf = (den: number) => (PPQ * 4) / den

/** The grid as spans and bars, with the time before the first beat made into lead-in beats of the pickup bar. */
function layout(grid: BeatGrid): { spans: Span[]; bars: MBar[] } {
  const first = grid.beats[0]
  const spans: Span[] = grid.beats.map((b) => ({ time: b.time, den: b.den }))
  const bars: MBar[] = grid.bars.map((b) => ({ first: b.first, count: b.count, den: b.den }))
  if (first.time <= EPS) return { spans, bars }
  // Set Tempo cannot make one beat longer than this, so a long silence becomes several beats.
  const longest = ((MAX_US_PER_QUARTER / 1e6) * first.den) / 4
  const n = Math.ceil(first.time / longest)
  const lead: Span[] = Array.from({ length: n }, (_, i) => ({ time: (i * first.time) / n, den: first.den }))
  const shifted = bars.map((b) => ({ ...b, first: b.first + n }))
  // A pickup bar takes the lead-in; a song that starts on a downbeat gets a pickup bar of its own.
  const pickup = grid.bars[0]?.bar === 0 && grid.bars[0].den === first.den
  if (pickup) shifted[0] = { first: 0, count: shifted[0].count + n, den: first.den }
  else shifted.unshift({ first: 0, count: n, den: first.den })
  return { spans: [...lead, ...spans], bars: shifted }
}

/** Variable-length quantity: 7 bits a byte, most significant first, the high bit on every byte but the last. */
export function vlq(n: number): number[] {
  const out = [n & 0x7f]
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80)
  return out
}

const meta = (type: number, data: number[]) => [0xff, type, ...vlq(data.length), ...data]
const text = (s: string) => [...new TextEncoder().encode(s)]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

/** The tempo map as a .mid file, or null when the grid has no beats (no analysis or length yet). */
export function tempoMidi(grid: BeatGrid, duration: number, opts: TempoMidiOptions = {}): Uint8Array<ArrayBuffer> | null {
  if (grid.beats.length === 0) return null
  const { spans, bars } = layout(grid)
  // `order` keeps events of one tick in the order they were added: signature, then tempo, then marker.
  const events: { tick: number; order: number; bytes: number[] }[] = []
  const add = (tick: number, bytes: number[]) => events.push({ tick, order: events.length, bytes })
  if (opts.title) add(0, meta(0x03, text(opts.title)))

  const startTick: number[] = []
  let tick = 0
  for (const s of spans) {
    startTick.push(tick)
    tick += ticksOf(s.den)
  }
  let endTick = tick

  // The song usually ends inside a bar: that bar keeps the meter before it (the file ends where the bar would).
  const last = bars[bars.length - 1]
  const before = bars[bars.length - 2]
  if (before && last.den === before.den && last.count < before.count) {
    endTick += (before.count - last.count) * ticksOf(last.den)
    bars.pop()
  }

  let sig = ""
  for (const b of bars) {
    const key = `${b.count}/${b.den}`
    if (key === sig) continue
    sig = key
    add(startTick[b.first], meta(0x58, [b.count, Math.log2(b.den), 96 / b.den, 8]))
  }

  // Exact microseconds the file has reached; each beat's tempo aims for the next beat's real time from there.
  let reached = 0
  let tempo = -1
  spans.forEach((s, i) => {
    const quarters = 4 / s.den
    const next = spans[i + 1]?.time
    // The last beat keeps the tempo before it (or lasts until the song ends when it is the only one).
    const us = next !== undefined
      ? Math.round((next * 1e6 - reached) / quarters)
      : tempo > 0 ? tempo : Math.round((Math.max(duration - s.time, 0.5) * 1e6) / quarters)
    let t = Math.min(MAX_US_PER_QUARTER, Math.max(1, us))
    // The tempo already playing still lands this beat's end close enough: keep it (no event).
    if (tempo > 0 && (next === undefined || Math.abs(reached + tempo * quarters - next * 1e6) < MAX_DRIFT_US)) t = tempo
    if (t !== tempo) add(startTick[i], meta(0x51, [(t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff]))
    tempo = t
    reached += t * quarters
  })

  // Section markers sit where their start falls inside its beat.
  for (const sec of opts.sections ?? []) {
    if (sec.kind === "silence" || sec.start < 0 || sec.start >= duration) continue
    let i = 0
    while (i + 1 < spans.length && spans[i + 1].time <= sec.start) i++
    const end = spans[i + 1]?.time ?? duration
    const share = end > spans[i].time ? Math.min(1, Math.max(0, (sec.start - spans[i].time) / (end - spans[i].time))) : 0
    add(Math.round(startTick[i] + share * ticksOf(spans[i].den)), meta(0x06, text(sec.name)))
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const track: number[] = []
  let at = 0
  for (const e of events) {
    track.push(...vlq(e.tick - at), ...e.bytes)
    at = e.tick
  }
  track.push(...vlq(endTick - at), ...meta(0x2f, []))

  const header = [...text("MThd"), ...u32(6), 0, 1, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff]
  return new Uint8Array([...header, ...text("MTrk"), ...u32(track.length), ...track])
}
