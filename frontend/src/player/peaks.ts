import type { StemName } from "@/lib/api"

export type Peaks = { samplesPerSecond: number; stems: Partial<Record<StemName, number[]>> }

export function parsePeaks(json: unknown): Peaks | null {
  if (!json || typeof json !== "object") return null
  const j = json as { version?: number; samples_per_second?: number; stems?: Record<string, unknown> }
  if (j.version !== 1 || typeof j.samples_per_second !== "number" || !j.stems) return null
  const stems: Peaks["stems"] = {}
  for (const [k, v] of Object.entries(j.stems)) {
    if (Array.isArray(v)) stems[k as StemName] = v.map((x) => (typeof x === "number" ? Math.min(1, Math.max(0, x)) : 0))
  }
  return { samplesPerSecond: j.samples_per_second, stems }
}

export async function fetchPeaks(url: string): Promise<Peaks | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return parsePeaks(await res.json())
  } catch {
    return null
  }
}

/** Fallback when peaks.json is missing: compute max-abs buckets from decoded audio. */
export function computePeaks(channels: Float32Array[], sampleRate: number, samplesPerSecond = 20): number[] {
  const per = Math.max(1, Math.floor(sampleRate / samplesPerSecond))
  const len = channels[0]?.length ?? 0
  const out: number[] = []
  for (let i = 0; i < len; i += per) {
    let m = 0
    for (const ch of channels) for (let j = i; j < Math.min(len, i + per); j++) m = Math.max(m, Math.abs(ch[j]))
    out.push(Math.min(1, m))
  }
  return out
}

/** Reduce (or stretch) `peaks` into exactly `bins` max-values, covering `duration` seconds. */
export function binPeaks(peaks: number[], samplesPerSecond: number, duration: number, bins: number): number[] {
  const out = new Array<number>(Math.max(0, bins)).fill(0)
  if (bins <= 0 || duration <= 0 || peaks.length === 0) return out
  const perBin = (duration * samplesPerSecond) / bins
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * perBin)
    const to = Math.max(from + 1, Math.ceil((b + 1) * perBin))
    let m = 0
    for (let i = from; i < Math.min(to, peaks.length); i++) m = Math.max(m, peaks[i])
    out[b] = m
  }
  return out
}
