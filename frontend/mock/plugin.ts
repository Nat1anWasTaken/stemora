/**
 * Dev-only mock of the Stemora backend (docs/contract.md). Enabled with VITE_MOCK=1.
 * In-memory state; resets when the dev server restarts. Seeded login: dev@stemora.test / password.
 * VITE_MOCK_FRESH=1 starts with zero users to exercise first-run bootstrap.
 */
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

type Role = "admin" | "user"
interface MockUser { id: string; email: string; password: string; role: Role }
interface MockSong {
  id: string
  title: string
  status: "pending" | "importing" | "uploading" | "queued" | "processing" | "ready" | "failed"
  duration_s: number | null
  size_bytes: number
  model: "htdemucs" | "htdemucs_ft" | "scnet_xl_ihf"
  progress: number
  stage: string | null
  error: string | null
  source_url: string | null
  created_at: string
  download: { downloaded_bytes: number; total_bytes: number | null; speed_bps: number | null; eta_s: number | null } | null
  /** when the song joined the queue (ms), while pending */
  queuedAt?: number
  /** link import started at this time (ms) */
  importStart?: number
  /** link import ends with this error instead */
  importFail?: string
  /** simulation start (ms) for queued/processing songs */
  simStart?: number
  /** keep failing (for the seeded failed song) */
  fixedFail?: boolean
  multipart?: boolean
}

const STEMS = ["vocals", "drums", "bass", "other"] as const
const MIB = 1024 * 1024
const mockModel = (m: unknown): MockSong["model"] => (m === "scnet_xl_ihf" ? m : "htdemucs")
const STAGES = ["downloading", "validating", "separating", "encoding", "uploading"]
/** MAX_CONCURRENT_JOBS: songs importing/queued/processing at once; more wait as `pending`. */
const MAX_ACTIVE = 2

export function mockApi(): Plugin {
  const users: MockUser[] = []
  if (process.env.VITE_MOCK_FRESH !== "1") {
    users.push({ id: randomUUID(), email: "dev@stemora.test", password: "password", role: "admin" })
  }
  const sessions = new Map<string, string>()
  // Mirrors the backend: the list never includes the token or link (stored hashed server-side).
  const invites: { id: string; created_at: string; expires_at: string; used_at: string | null; used_by_email: string | null; status: "pending" | "used" | "expired" }[] = []
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const songs: MockSong[] = [
    { id: randomUUID(), title: "Mock Song - Four Stems", status: "ready", duration_s: 20, size_bytes: 3.1 * MIB, model: "htdemucs", progress: 100, stage: "done", error: null, source_url: null, download: null, created_at: iso(now - 3600e3) },
    { id: randomUUID(), title: "Rainy Day Blues (live)", status: "processing", duration_s: null, size_bytes: 8.4 * MIB, model: "scnet_xl_ihf", progress: 0, stage: "separating", error: null, source_url: null, download: null, created_at: iso(now - 60e3), simStart: now - 5e3 },
    { id: randomUUID(), title: "corrupt-recording.mp3", status: "failed", duration_s: null, size_bytes: 0.2 * MIB, model: "htdemucs", progress: 35, stage: "validating", error: "File does not contain a decodable audio stream.", source_url: null, download: null, created_at: iso(now - 7200e3), fixedFail: true },
  ]
  songs.forEach((s) => (s.size_bytes = Math.round(s.size_bytes)))

  const IMPORT_SIZE = Math.round(6.3 * MIB)
  // Mirrors the backend's import stages: waiting -> probing -> downloading -> storing.
  function tickImport(s: MockSong) {
    if (s.importStart === undefined || s.status !== "importing") return
    const t = (Date.now() - s.importStart) / 1000
    s.download = null
    if (t < 1) { s.stage = "waiting"; s.progress = 0; return }
    if (t < 2.5) { s.stage = "probing"; return }
    if (s.importFail) { s.status = "failed"; s.stage = null; s.error = s.importFail; s.importStart = undefined; return }
    if (s.title === s.source_url) s.title = "Imported Song (mock)"
    s.duration_s = 214
    if (t < 9) {
      const f = (t - 2.5) / 6.5
      s.stage = "downloading"
      s.progress = Math.round(f * 100)
      s.download = { downloaded_bytes: Math.round(f * IMPORT_SIZE), total_bytes: IMPORT_SIZE, speed_bps: IMPORT_SIZE / 6.5, eta_s: Math.ceil(9 - t) }
      return
    }
    if (t < 10) { s.stage = "storing"; s.progress = 100; return }
    s.importStart = undefined
    s.size_bytes = IMPORT_SIZE
    s.status = "queued"
    s.simStart = Date.now()
  }

  function tick(s: MockSong) {
    tickImport(s)
    if (s.status === "importing") return
    if (s.simStart === undefined || s.fixedFail) return
    const t = (Date.now() - s.simStart) / 1000
    if (t < 2) { s.status = "queued"; s.progress = 0; s.stage = null }
    else if (t < 16) {
      s.status = "processing"
      s.progress = Math.min(99, Math.round(((t - 2) / 14) * 100))
      s.stage = STAGES[Math.min(STAGES.length - 1, Math.floor(((t - 2) / 14) * STAGES.length))]
    } else { s.status = "ready"; s.progress = 100; s.stage = "done"; s.duration_s = 20; s.simStart = undefined }
  }
  // Mirrors the backend's queue: start the oldest pending songs while there are free slots.
  const waiting = () => songs.filter((s) => s.status === "pending").sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
  function pump() {
    songs.forEach(tick)
    let free = MAX_ACTIVE - songs.filter((s) => s.status === "importing" || s.status === "queued" || s.status === "processing").length
    for (const s of waiting()) {
      if (free-- <= 0) break
      s.queuedAt = undefined
      if (s.source_url && s.size_bytes === 0) { s.status = "importing"; s.stage = "waiting"; s.importStart = Date.now() }
      else { s.status = "queued"; s.simStart = Date.now() }
    }
  }
  const enqueue = (s: MockSong) => {
    s.status = "pending"; s.stage = null; s.progress = 0; s.error = null; s.simStart = undefined; s.queuedAt = Date.now()
    pump()
  }
  const publicSong = (s: MockSong) => {
    tick(s)
    const { simStart: _a, fixedFail: _b, multipart: _c, importStart: _d, importFail: _e, queuedAt: _f, ...rest } = s
    void _a; void _b; void _c; void _d; void _e; void _f
    const position = waiting().indexOf(s)
    return { ...rest, queue_position: position < 0 ? null : position + 1 }
  }

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status
    if (body === undefined) return res.end()
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  }
  const err = (res: ServerResponse, status: number, code: string, error: string) => json(res, status, { error, code })
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString()
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }
  const cookieUser = (req: IncomingMessage) => {
    const m = /stemora_session=([^;]+)/.exec(req.headers.cookie ?? "")
    const id = m && sessions.get(m[1])
    return users.find((u) => u.id === id)
  }
  const startSession = (res: ServerResponse, u: MockUser) => {
    const sid = randomUUID()
    sessions.set(sid, u.id)
    res.setHeader("set-cookie", `stemora_session=${sid}; Path=/; HttpOnly; SameSite=Lax`)
  }
  const pubUser = (u: MockUser) => ({ id: u.id, email: u.email, role: u.role })

  return {
    name: "stemora-mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x")
        const path = url.pathname
        const method = req.method ?? "GET"

        // Fake presigned upload target: PUT /mock-upload/{id}[/part/{n}]
        const up = /^\/mock-upload\/([\w-]+)(?:\/part\/(\d+))?$/.exec(path)
        if (up && method === "PUT") {
          let size = 0
          for await (const c of req) size += (c as Buffer).length
          await new Promise((r) => setTimeout(r, 400 + Math.random() * 600))
          res.setHeader("etag", `"mock-etag-${up[1].slice(0, 6)}-${up[2] ?? "0"}-${size}"`)
          res.setHeader("access-control-expose-headers", "ETag")
          return json(res, 200)
        }
        if (!path.startsWith("/api/")) return next()

        try {
          const user = cookieUser(req)
          // ---- auth
          if (path === "/api/auth/status" && method === "GET") return json(res, 200, { needs_bootstrap: users.length === 0 })
          if (path === "/api/auth/bootstrap" && method === "POST") {
            if (users.length > 0) return err(res, 403, "bootstrap_closed", "Already bootstrapped")
            const b = await readBody(req)
            const u: MockUser = { id: randomUUID(), email: String(b.email), password: String(b.password), role: "admin" }
            users.push(u); startSession(res, u)
            return json(res, 200, pubUser(u))
          }
          if (path === "/api/auth/login" && method === "POST") {
            const b = await readBody(req)
            const u = users.find((x) => x.email === b.email && x.password === b.password)
            if (!u) return err(res, 401, "invalid_credentials", "Invalid email or password")
            startSession(res, u)
            return json(res, 200, pubUser(u))
          }
          if (path === "/api/auth/logout" && method === "POST") {
            res.setHeader("set-cookie", "stemora_session=; Path=/; Max-Age=0")
            return json(res, 204)
          }
          if (path === "/api/auth/me" && method === "GET") return user ? json(res, 200, pubUser(user)) : err(res, 401, "unauthorized", "Not signed in")
          if (path === "/api/auth/me" && method === "PATCH") {
            if (!user) return err(res, 401, "unauthorized", "Not signed in")
            const b = await readBody(req)
            if (b.current_password !== user.password) return err(res, 401, "invalid_credentials", "current password is incorrect")
            const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : undefined
            if (email && users.some((u) => u.email === email && u.id !== user.id)) return err(res, 409, "email_taken", "an account with that email already exists")
            if (typeof b.new_password === "string" && b.new_password.length < 8) return err(res, 400, "weak_password", "password must be at least 8 characters")
            if (email) user.email = email
            if (typeof b.new_password === "string") user.password = b.new_password
            return json(res, 200, pubUser(user))
          }
          const inv = /^\/api\/invites\/([^/]+)$/.exec(path)
          if (inv && method === "GET") return json(res, 200, { valid: inv[1] !== "invalid" && inv[1] !== "expired" })
          if (path === "/api/auth/accept-invite" && method === "POST") {
            const b = await readBody(req)
            const u: MockUser = { id: randomUUID(), email: String(b.email), password: String(b.password), role: "user" }
            users.push(u); startSession(res, u)
            return json(res, 200, pubUser(u))
          }

          if (!user) return err(res, 401, "unauthorized", "Not signed in")

          // ---- admin
          if (path === "/api/admin/invites") {
            if (user.role !== "admin") return err(res, 403, "forbidden", "Admins only")
            if (method === "GET") return json(res, 200, invites)
            if (method === "POST") {
              const token = randomUUID().replace(/-/g, "")
              const expires_at = iso(Date.now() + 7 * 86400e3)
              invites.unshift({ id: token.slice(0, 12), created_at: iso(Date.now()), expires_at, used_at: null, used_by_email: null, status: "pending" })
              return json(res, 200, { token, url: `http://${req.headers.host}/invite/${token}`, expires_at })
            }
          }
          if (path === "/api/me/usage") return json(res, 200, { used_bytes: songs.reduce((a, s) => a + s.size_bytes, 0), quota_bytes: 5000 * MIB })

          // ---- songs
          if (path.startsWith("/api/songs")) pump()
          if (path === "/api/songs" && method === "GET") return json(res, 200, [...songs].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicSong))
          if (path === "/api/songs" && method === "POST") {
            const b = await readBody(req)
            if (!String(b.content_type ?? "").startsWith("audio/") && !/\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(String(b.filename))) return err(res, 415, "unsupported_media_type", "That does not look like an audio file")
            if (b.size > 200 * MIB) return err(res, 413, "too_large", "File is larger than 200 MB")
            const s: MockSong = { id: randomUUID(), title: String(b.title), status: "uploading", duration_s: null, size_bytes: Number(b.size), model: mockModel(b.model), progress: 0, stage: null, error: null, source_url: null, download: null, created_at: iso(Date.now()) }
            songs.push(s)
            if (b.size <= 50 * MIB) return json(res, 200, { song: publicSong(s), upload: { mode: "single", url: `/mock-upload/${s.id}`, headers: { "Content-Type": String(b.content_type || "application/octet-stream") } } })
            s.multipart = true
            const part_size = 16 * MIB
            return json(res, 200, { song: publicSong(s), upload: { mode: "multipart", upload_id: randomUUID(), part_size, part_count: Math.ceil(b.size / part_size) } })
          }
          // Links containing "broken" cannot be read, "long" are too long, "fail" fail during the import.
          if (path === "/api/songs/import/preview" && method === "POST") {
            const b = await readBody(req)
            const link = String(b.url ?? "").trim()
            if (!/^https?:\/\/[^/\s]+\.[^/\s]+/.test(link)) return err(res, 400, "invalid_url", "not a valid link")
            await new Promise((r) => setTimeout(r, 800))
            if (link.includes("broken")) return err(res, 422, "link_unavailable", "The link is private, removed or unavailable.")
            const long = link.includes("long")
            return json(res, 200, { title: "Imported Song (mock)", duration_s: long ? 3600 : 214, uploader: "Mock Artist", site: "Youtube", filesize: IMPORT_SIZE, problem: long ? "Audio is 60.0 min long; the maximum is 15.0 min." : null })
          }
          if (path === "/api/songs/import" && method === "POST") {
            const b = await readBody(req)
            const link = String(b.url ?? "").trim()
            if (!/^https?:\/\/[^/\s]+\.[^/\s]+/.test(link)) return err(res, 400, "invalid_url", "not a valid link")
            const title = String(b.title ?? "").trim() || link.slice(0, 200)
            const s: MockSong = { id: randomUUID(), title, status: "pending", duration_s: null, size_bytes: 0, model: mockModel(b.model), progress: 0, stage: null, error: null, source_url: link, download: null, created_at: iso(Date.now()), importFail: link.includes("fail") ? "The link is private, removed or unavailable." : undefined }
            songs.push(s)
            enqueue(s)
            return json(res, 200, publicSong(s))
          }
          const m = /^\/api\/songs\/([\w-]+)(?:\/(.+))?$/.exec(path)
          if (m) {
            const s = songs.find((x) => x.id === m[1])
            if (!s) return err(res, 404, "not_found", "Song not found")
            const sub = m[2]
            if (!sub && method === "GET") {
              const p = publicSong(s)
              return json(res, 200, s.status === "ready"
                ? { song: p, stems: STEMS.map((name) => ({ name, url: `/mock/${name}.m4a`, size_bytes: 240000 })), peaks_url: "/mock/peaks.json", analysis_url: "/mock/analysis.json" }
                : { song: p, stems: [], peaks_url: null, analysis_url: null })
            }
            if (!sub && method === "PATCH") { const b = await readBody(req); s.title = String(b.title); return json(res, 200, publicSong(s)) }
            if (!sub && method === "DELETE") { songs.splice(songs.indexOf(s), 1); pump(); return json(res, 204) }
            if (sub === "upload/parts" && method === "POST") {
              const b = await readBody(req)
              return json(res, 200, { urls: (b.part_numbers as number[]).map((n) => ({ part_number: n, url: `/mock-upload/${s.id}/part/${n}` })) })
            }
            if (sub === "cancel" && method === "POST") {
              tick(s)
              if (s.status !== "importing" && s.status !== "pending") return err(res, 409, "not_cancellable", "the song is no longer waiting or importing")
              const link = s.source_url !== null && s.size_bytes === 0
              s.status = "failed"; s.stage = null; s.download = null; s.importStart = undefined; s.queuedAt = undefined
              s.error = link ? "The import was cancelled." : "Cancelled before processing started."
              pump()
              return json(res, 200, publicSong(s))
            }
            if (sub === "complete" && method === "POST") {
              if (s.status === "uploading") enqueue(s)
              return json(res, 200, publicSong(s))
            }
            if (sub === "reprocess" && method === "POST") {
              const b = await readBody(req)
              s.model = mockModel(b.model)
              s.fixedFail = false
              enqueue(s)
              return json(res, 200, publicSong(s))
            }
            const dl = /^stems\/(\w+)\/download$/.exec(sub ?? "")
            if (dl && method === "GET") {
              res.statusCode = 302
              res.setHeader("location", `/mock/${dl[1]}.m4a`)
              return res.end()
            }
          }
          return err(res, 404, "not_found", `No mock route for ${method} ${path}`)
        } catch (e) {
          return err(res, 500, "mock_error", String(e))
        }
      })
    },
  }
}
