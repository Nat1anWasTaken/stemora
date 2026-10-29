// Types and client for the Stemora HTTP API (see docs/contract.md).

export type StemName = "vocals" | "drums" | "bass" | "other"
export type Role = "admin" | "user"
export type User = { id: string; email: string; role: Role }
export type SongStatus = "importing" | "uploading" | "queued" | "processing" | "ready" | "failed"
/** Models a new job can use. */
export type Model = "htdemucs" | "scnet_xl_ihf"
/** What the "High quality" option runs. */
export const HQ_MODEL: Model = "scnet_xl_ihf"
/** htdemucs_ft is retired (it was the high quality model before SCNet) but older songs still carry it. */
export type SongModel = Model | "htdemucs_ft"
export const isHighQuality = (m: SongModel) => m !== "htdemucs"
/** The model to retry a song with: retired models map to what replaced them. */
export const retryModel = (m: SongModel): Model => (m === "htdemucs_ft" ? HQ_MODEL : m)
export type Song = {
  id: string
  title: string
  status: SongStatus
  duration_s: number | null
  size_bytes: number
  model: SongModel
  progress: number
  stage: string | null
  error: string | null
  /** Link the song was imported from (yt-dlp on the server). */
  source_url: string | null
  created_at: string
  /** Live download state while a link import is downloading. */
  download: Download | null
}
export type Download = {
  downloaded_bytes: number
  /** Exact, or estimated for streamed (HLS/DASH) sources. */
  total_bytes: number | null
  speed_bps: number | null
  eta_s: number | null
}
/** What a link points to, looked up before importing it. */
export type LinkPreview = {
  title: string | null
  duration_s: number | null
  uploader: string | null
  site: string | null
  filesize: number | null
  /** Why importing it would fail, if it would. */
  problem: string | null
}
export type Stem = { name: StemName; url: string; size_bytes: number }
export type SongDetail = { song: Song; stems: Stem[]; peaks_url: string | null; analysis_url: string | null }
export type Usage = { used_bytes: number; quota_bytes: number }
export type Upload =
  | { mode: "single"; url: string; headers: Record<string, string> }
  | { mode: "multipart"; upload_id: string; part_size: number; part_count: number }
/** Returned once, at creation: the token is stored hashed and can't be listed later. */
export type Invite = { token: string; url: string; expires_at: string }
export type InviteSummary = {
  id: string
  created_at: string
  expires_at: string
  used_at: string | null
  used_by_email: string | null
  status: "pending" | "used" | "expired"
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = undefined
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    /* non-JSON error page from a proxy */
  }
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; code?: string }
    throw new ApiError(res.status, e.code ?? "http_error", e.error ?? `Request failed (${res.status})`)
  }
  return data as T
}

export const api = {
  authStatus: () => request<{ needs_bootstrap: boolean }>("/auth/status"),
  bootstrap: (email: string, password: string) => request<User>("/auth/bootstrap", { method: "POST", body: { email, password } }),
  login: (email: string, password: string) => request<User>("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: async (): Promise<User | null> => {
    try {
      return await request<User>("/auth/me")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  updateMe: (b: { current_password: string; email?: string; new_password?: string }) =>
    request<User>("/auth/me", { method: "PATCH", body: b }),
  inviteValid: (token: string) => request<{ valid: boolean }>(`/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, email: string, password: string) =>
    request<User>("/auth/accept-invite", { method: "POST", body: { token, email, password } }),
  createInvite: () => request<Invite>("/admin/invites", { method: "POST" }),
  listInvites: () => request<InviteSummary[]>("/admin/invites"),

  songs: () => request<Song[]>("/songs"),
  song: (id: string) => request<SongDetail>(`/songs/${id}`),
  createSong: (b: { title: string; filename: string; content_type: string; size: number; model: Model }) =>
    request<{ song: Song; upload: Upload }>("/songs", { method: "POST", body: b }),
  importSong: (b: { url: string; title?: string; model: Model }) => request<Song>("/songs/import", { method: "POST", body: b }),
  previewLink: (url: string) => request<LinkPreview>("/songs/import/preview", { method: "POST", body: { url } }),
  cancelImport: (id: string) => request<Song>(`/songs/${id}/cancel`, { method: "POST" }),
  partUrls: (id: string, part_numbers: number[]) =>
    request<{ urls: { part_number: number; url: string }[] }>(`/songs/${id}/upload/parts`, { method: "POST", body: { part_numbers } }),
  complete: (id: string, parts?: { part_number: number; etag: string }[]) =>
    request<Song>(`/songs/${id}/complete`, { method: "POST", body: parts ? { parts } : {} }),
  rename: (id: string, title: string) => request<Song>(`/songs/${id}`, { method: "PATCH", body: { title } }),
  remove: (id: string) => request<void>(`/songs/${id}`, { method: "DELETE" }),
  reprocess: (id: string, model: Model) => request<Song>(`/songs/${id}/reprocess`, { method: "POST", body: { model } }),
  usage: () => request<Usage>("/me/usage"),
}

export const stemDownloadUrl = (songId: string, name: StemName, format: "m4a" | "flac") =>
  `/api/songs/${songId}/stems/${name}/download?format=${format}`

export const isActive = (s: Pick<Song, "status">) =>
  s.status === "queued" || s.status === "processing" || s.status === "uploading" || s.status === "importing"

/** Determinate progress (0-100) when known, else null for an indeterminate bar. */
export const progressValue = (s: Pick<Song, "status" | "stage" | "progress" | "download">): number | null => {
  if (s.status === "processing") return s.progress
  if (s.status === "importing" && (s.stage === "storing" || s.download?.total_bytes)) return s.progress
  return null
}

/** A failed link import never stored an original, so it can only be imported again. */
export const isFailedImport = (s: Pick<Song, "status" | "source_url" | "size_bytes">) =>
  s.status === "failed" && s.source_url !== null && s.size_bytes === 0
