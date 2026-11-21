import type { Precision } from "@/player/drums/quantize"

export type DrumPrecision = { precision: Precision; triplets: boolean }

const KEY = "stemora:drum-precision"
const DEFAULT: DrumPrecision = { precision: "auto", triplets: true }
/** Display order (an object literal would list the numeric keys before "auto"). */
export const PRECISIONS: Precision[] = ["auto", "8", "16", "32"]

/** The viewer's notation precision, remembered per browser. */
export function loadPrecision(): DrumPrecision {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DrumPrecision> | null
    return {
      precision: j && PRECISIONS.includes(j.precision as Precision) ? (j.precision as Precision) : DEFAULT.precision,
      triplets: typeof j?.triplets === "boolean" ? j.triplets : DEFAULT.triplets,
    }
  } catch {
    return DEFAULT
  }
}

export function savePrecision(p: DrumPrecision) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage unavailable (private mode): the choice just isn't remembered
  }
}

export const PRECISION_LABELS: Record<Precision, string> = { auto: "Auto", "8": "8th", "16": "16th", "32": "32nd" }
