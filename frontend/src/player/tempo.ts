/**
 * Tempo dial maths. With a detected BPM the dial shows BPM (speed = bpm / original); without one it shows percent.
 * Speed is limited to 50-150 % of the original.
 */
export const MIN_SPEED = 0.5
export const MAX_SPEED = 1.5
export const MAX_SEMITONES = 12

/** Unit of the tempo dial: the detected BPM, or 100 so the dial reads as percent. */
export const tempoUnit = (baseBpm: number | null) => baseBpm ?? 100

export function tempoRange(baseBpm: number | null): { min: number; max: number } {
  const u = tempoUnit(baseBpm)
  return { min: Math.ceil(u * MIN_SPEED), max: Math.floor(u * MAX_SPEED) }
}

/** Dial value for a speed (rounded to whole BPM / percent). */
export const tempoValue = (speed: number, baseBpm: number | null) => Math.round(speed * tempoUnit(baseBpm))

/** Speed for a dial value; the value nearest the original snaps to exactly 1 so the shifter can be bypassed. */
export function speedFor(value: number, baseBpm: number | null): number {
  const u = tempoUnit(baseBpm)
  if (value === Math.round(u)) return 1
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value / u))
}

const MARKINGS: [number, string][] = [[40, "Grave"], [60, "Largo"], [66, "Larghetto"], [76, "Adagio"], [108, "Andante"], [112, "Moderato"], [120, "Allegretto"], [156, "Allegro"], [176, "Vivace"], [200, "Presto"]]

/** Italian tempo marking for a BPM; each entry applies below its bound. */
export function tempoMarking(bpm: number): string {
  for (const [upTo, name] of MARKINGS) if (bpm < upTo) return name
  return "Prestissimo"
}
