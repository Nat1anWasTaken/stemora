import { defaultMixer, STEM_NAMES, type MixerState } from "@/player/mixer"

const key = (songId: string) => `stemora:mixer:${songId}`

/** Validate untrusted JSON into a MixerState (missing/invalid fields fall back to defaults). */
export function parseMixer(raw: unknown): MixerState {
  const d = defaultMixer()
  if (!raw || typeof raw !== "object") return d
  const r = raw as Partial<MixerState>
  for (const n of STEM_NAMES) {
    const v = r.volumes?.[n]
    if (typeof v === "number" && Number.isFinite(v)) d.volumes[n] = Math.min(1, Math.max(0, v))
  }
  const names = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is MixerState["muted"][number] => STEM_NAMES.includes(n)) : [])
  d.muted = names(r.muted)
  d.soloed = names(r.soloed)
  return d
}

export function loadMixer(songId: string): MixerState {
  try {
    const raw = localStorage.getItem(key(songId))
    return parseMixer(raw ? JSON.parse(raw) : null)
  } catch {
    return defaultMixer()
  }
}

export function saveMixer(songId: string, m: MixerState) {
  try {
    localStorage.setItem(key(songId), JSON.stringify(m))
  } catch {
    /* storage unavailable (private mode / quota): ignore */
  }
}
