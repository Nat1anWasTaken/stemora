import { getPosition, usePlayer } from "@/player/store"
import {
  beatLength, clampBpm, detectedTempo, insertMarker, isLocked, markerIndexAt, moveMarker, removeMarker, updateMarker,
  type ManualMarker, type TempoMarker,
} from "@/player/tempo-map"

/**
 * Tempo map edits, each one undoable step on the player store. They return the index of the marker they leave
 * selected (or null), or `false` when the edit does not fit (markers would cross or leave the song).
 */
const st = () => usePlayer.getState()
const commit = (next: TempoMarker[] | null, from: TempoMarker[]) => {
  if (!next) return false
  // An edit that changes nothing (same BPM typed again) is not an undo step.
  if (JSON.stringify(next) === JSON.stringify(from)) return true
  st().setMarkers(next, { from })
  return true
}

/** The tempo a new manual marker at `t` starts from: the manual marker before it, else the detected tempo there. */
export function startingTempo(t: number): Omit<ManualMarker, "time" | "kind"> {
  const { markers, analysis, duration } = st()
  const prev = markers[markerIndexAt(markers, t)]
  if (prev?.kind === "manual") return { bpm: prev.bpm, num: prev.num, den: prev.den }
  const next = markers[markerIndexAt(markers, t) + 1]?.time ?? duration
  return detectedTempo(analysis, t, Math.min(next, t + 16)) ?? { bpm: 120, num: 4, den: 4 }
}

export function addMarker(t: number, kind: "auto" | "manual" = "manual"): number | false {
  const { markers, duration } = st()
  const m: TempoMarker = kind === "auto" ? { time: t, kind } : { time: t, kind, ...startingTempo(t) }
  const r = insertMarker(markers, m, duration)
  if (!r || !commit(r.markers, markers)) return false
  return r.index
}

export function moveMarkerTo(i: number, t: number): boolean {
  const { markers, duration } = st()
  return commit(moveMarker(markers, i, t, duration), markers)
}

export function replaceMarker(i: number, next: TempoMarker): boolean {
  const { markers, duration } = st()
  return commit(updateMarker(markers, i, next, duration), markers)
}

export function deleteMarker(i: number): boolean {
  const { markers, duration } = st()
  return commit(removeMarker(markers, i, duration), markers)
}

/** Switches a marker between auto and manual (a new manual marker starts from the detected tempo of its segment). */
export function setKind(i: number, kind: "auto" | "manual"): boolean {
  const { markers, analysis, duration } = st()
  const m = markers[i]
  if (!m || m.kind === kind) return false
  if (kind === "auto") return replaceMarker(i, { time: m.time, kind })
  const end = markers[i + 1]?.time ?? duration
  return replaceMarker(i, { time: m.time, kind, ...(detectedTempo(analysis, m.time, end) ?? { bpm: 120, num: 4, den: 4 }) })
}

/** BPM of a manual marker from the beats detected in its segment. */
export function applyDetectedTempo(i: number): boolean {
  const { markers, analysis, duration } = st()
  const m = markers[i]
  if (m?.kind !== "manual") return false
  const d = detectedTempo(analysis, m.time, markers[i + 1]?.time ?? duration)
  return !!d && replaceMarker(i, { ...m, bpm: d.bpm })
}

export function setBpm(i: number, bpm: number): boolean {
  const m = st().markers[i]
  return m?.kind === "manual" && replaceMarker(i, { ...m, bpm: clampBpm(bpm) })
}

/** Nudges a marker: a beat at a time when locked to a grid, else by `seconds`. */
export function nudgeMarker(i: number, dir: -1 | 1, seconds: number): boolean {
  const { markers } = st()
  if (i <= 0 || !markers[i]) return false
  const prev = markers[i - 1]
  const step = isLocked(markers, i) && prev.kind === "manual" ? beatLength(prev) : seconds
  return moveMarkerTo(i, markers[i].time + dir * step)
}

/** Moves the playhead to the marker after (or before) the one at the playhead; returns its index. */
export function locateMarker(dir: -1 | 1): number | null {
  const { markers, seek } = st()
  const pos = getPosition()
  const i = dir > 0 ? markers.findIndex((m) => m.time > pos + 0.005) : markers.findLastIndex((m) => m.time < pos - 0.005)
  if (i < 0) return null
  seek(markers[i].time)
  return i
}
