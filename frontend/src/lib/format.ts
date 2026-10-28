/** "3:05" / "1:02:03" */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** "-4:19" style remaining time */
export function formatRemaining(position: number, duration: number): string {
  return `-${formatClock(Math.max(0, Math.ceil(duration - position)))}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime()) / 1000
  if (diff < 60) return "just now"
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

/** "my_song-v2.mp3" -> "my song v2" */
export function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled"
}

const STAGE_LABELS: Record<string, string> = {
  downloading: "Fetching file",
  validating: "Checking audio",
  separating: "Separating stems",
  encoding: "Encoding",
  uploading: "Saving stems",
  done: "Done",
}
export function stageLabel(stage: string | null): string {
  return stage ? (STAGE_LABELS[stage] ?? stage) : "Waiting for a worker"
}
