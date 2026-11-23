import type { StemName } from "@/lib/api"
import { STEM_LABEL, STEM_NAMES } from "@/player/mixer"

/**
 * Which stems follow a key change. Drums are unpitched, and transposing them only makes the kit sound smaller or
 * larger, so by default they keep their original pitch (they still follow the speed).
 */
export const DEFAULT_TRANSPOSED: readonly StemName[] = ["vocals", "bass", "other"]

const KEY = "stemora:transposed-stems"

/** Validates untrusted JSON into a list of stems, in STEM_NAMES order (anything invalid falls back to the default). */
export function parseTransposed(raw: unknown): StemName[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TRANSPOSED]
  return STEM_NAMES.filter((n) => raw.includes(n))
}

/** The stems that follow the key, kept per browser: it is a judgement about instruments, not about one song. */
export function loadTransposed(): StemName[] {
  try {
    const raw = localStorage.getItem(KEY)
    return parseTransposed(raw ? JSON.parse(raw) : null)
  } catch {
    return [...DEFAULT_TRANSPOSED]
  }
}

export function saveTransposed(stems: readonly StemName[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stems))
  } catch {
    /* storage unavailable (private mode / quota): ignore */
  }
}

/** `stems` with `name` added or removed, kept in STEM_NAMES order. */
export function toggleTransposed(stems: readonly StemName[], name: StemName): StemName[] {
  return STEM_NAMES.filter((n) => (n === name ? !stems.includes(n) : stems.includes(n)))
}

/** The key change heard: the dial's value while the key switch is on, otherwise none. */
export const heardSemitones = (semitones: number, enabled: boolean) => (enabled ? semitones : 0)

/** The key change `name` is played at. */
export const stemSemitones = (name: StemName, semitones: number, stems: readonly StemName[]) => (stems.includes(name) ? semitones : 0)

/** Short summary for the Stems picker: "All stems", "All but drums", "Vocals, Bass" or "None". */
export function transposedLabel(stems: readonly StemName[]): string {
  if (stems.length === 0) return "None"
  if (stems.length === STEM_NAMES.length) return "All stems"
  if (stems.length === STEM_NAMES.length - 1) return `All but ${STEM_LABEL[STEM_NAMES.find((n) => !stems.includes(n))!].toLowerCase()}`
  return stems.map((n) => STEM_LABEL[n]).join(", ")
}

/** "+2", "−3" or "0" (a real minus sign). */
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0")
