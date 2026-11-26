import type { PlaybackSettings } from "@/lib/api"
import { CLICK_SOUNDS, DEFAULT_CLICK_SOUND, loadClickSound } from "@/player/click-sounds"
import { defaultMixer } from "@/player/mixer"
import { parseMixer } from "@/player/mixerStorage"
import { MAX_SEMITONES, MAX_SPEED, MIN_SPEED } from "@/player/tempo"
import { DEFAULT_TRANSPOSED, loadTransposed, parseTransposed } from "@/player/transpose"

/**
 * Playback settings sets (docs/playback.md). The server stores one per song (and one listening set per user); this
 * file turns untrusted JSON into a complete set, compares sets, and keeps the browser-side copies: a set that has not
 * reached the server yet ("pending"), and the per-song mixer older versions kept in this browser ("legacy").
 */

export type { PlaybackSettings }

export function defaultSettings(): PlaybackSettings {
  return { mixer: defaultMixer(), speed: 1, semitones: 0, key_enabled: true, transposed: [...DEFAULT_TRANSPOSED], metronome: false, click_sound: DEFAULT_CLICK_SOUND }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)

/** A complete set from untrusted JSON, normalised like the server does (missing or malformed fields take their defaults). */
export function parseSettings(raw: unknown): PlaybackSettings {
  const d = defaultSettings()
  if (!raw || typeof raw !== "object") return d
  const r = raw as Record<string, unknown>
  const speed = num(r.speed)
  const semitones = num(r.semitones)
  const click = typeof r.click_sound === "string" && CLICK_SOUNDS.some((s) => s.id === r.click_sound) ? r.click_sound : d.click_sound
  return {
    mixer: parseMixer(r.mixer),
    speed: speed === null ? 1 : Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)),
    semitones: semitones === null ? 0 : Math.min(MAX_SEMITONES, Math.max(-MAX_SEMITONES, Math.round(semitones))),
    key_enabled: bool(r.key_enabled, true),
    transposed: Array.isArray(r.transposed) ? parseTransposed(r.transposed) : d.transposed,
    metronome: bool(r.metronome, false),
    click_sound: click,
  }
}

/** Whether two sets sound the same; compared after the server's rounding, so its answer never counts as a change. */
export function sameSettings(a: PlaybackSettings, b: PlaybackSettings): boolean {
  const r = (x: number) => Math.round(x * 1000)
  const list = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((n) => y.includes(n))
  return (
    Object.keys(a.mixer.volumes).every((n) => r(a.mixer.volumes[n as keyof typeof a.mixer.volumes]) === r(b.mixer.volumes[n as keyof typeof b.mixer.volumes])) &&
    list(a.mixer.muted, b.mixer.muted) &&
    list(a.mixer.soloed, b.mixer.soloed) &&
    r(a.speed) === r(b.speed) &&
    a.semitones === b.semitones &&
    a.key_enabled === b.key_enabled &&
    list(a.transposed, b.transposed) &&
    a.metronome === b.metronome &&
    a.click_sound === b.click_sound
  )
}

/** Where a set is stored: one song's settings, the user's listening settings, or a setlist entry's. */
export type SettingsScope = { kind: "song"; id: string } | { kind: "listening" } | { kind: "entry"; setlistId: string; entryId: string }

/** A stable name for a scope (React keys, storage keys). */
export const scopeKey = (s: SettingsScope) => (s.kind === "song" ? `song:${s.id}` : s.kind === "entry" ? `entry:${s.setlistId}:${s.entryId}` : "listening")

const pendingKey = (s: SettingsScope) => `stemora:settings-pending:${scopeKey(s)}`
const legacyMixerKey = (songId: string) => `stemora:mixer:${songId}`

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** A set changed in this browser that the server has not confirmed yet (it is newer than the server's copy). */
export function loadPending(scope: SettingsScope): PlaybackSettings | null {
  const raw = read(pendingKey(scope))
  return raw ? parseSettings(raw) : null
}

export function savePending(scope: SettingsScope, s: PlaybackSettings) {
  try {
    localStorage.setItem(pendingKey(scope), JSON.stringify(s))
  } catch {
    /* storage unavailable (private mode / quota): the in-memory saver still retries */
  }
}

export function clearPending(scope: SettingsScope) {
  try {
    localStorage.removeItem(pendingKey(scope))
  } catch {
    /* ignore */
  }
}

/**
 * The settings older versions kept in this browser for a song: its mixer, and the browser-wide stems that follow the
 * key and click sound. Null when the song has no mixer here (the browser-wide choices still seed `initialSettings`).
 */
export function legacySettings(songId: string): PlaybackSettings | null {
  const raw = read(legacyMixerKey(songId))
  if (!raw) return null
  return { ...defaultSettings(), mixer: parseMixer(raw), transposed: loadTransposed(), click_sound: loadClickSound() }
}

export function clearLegacy(songId: string) {
  try {
    localStorage.removeItem(legacyMixerKey(songId))
  } catch {
    /* ignore */
  }
}

/**
 * The set a song opens with, newest first: changes this browser has not sent yet, then the server's copy, then what an
 * older version kept here, then defaults (with this browser's last stems-that-follow-the-key and click sound, so a new
 * song starts the way the previous ones were set up).
 */
export function initialSettings(songId: string, server: PlaybackSettings | null | undefined): PlaybackSettings {
  return (
    loadPending({ kind: "song", id: songId }) ??
    (server ? parseSettings(server) : null) ??
    legacySettings(songId) ?? { ...defaultSettings(), transposed: loadTransposed(), click_sound: loadClickSound() }
  )
}
