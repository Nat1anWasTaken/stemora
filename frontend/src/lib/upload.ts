import { api, type Model, type Upload } from "@/lib/api"

export const PART_SIZE = 16 * 1024 * 1024
const PART_URL_BATCH = 50

export type PartPlan = { partNumber: number; start: number; end: number }

/** Split `size` bytes into 1-based, contiguous parts of at most `partSize`. */
export function planParts(size: number, partSize: number): PartPlan[] {
  const parts: PartPlan[] = []
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(size, start + partSize) })
  }
  return parts
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs: number; sleep?: (ms: number) => Promise<void>; shouldRetry?: (e: unknown) => boolean },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  let attempt = 0
  for (;;) {
    try {
      return await fn(attempt)
    } catch (e) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(e))) throw e
      await sleep(opts.baseDelayMs * 2 ** attempt)
      attempt++
    }
  }
}

export type PutResult = { etag: string | null }
export type PutFn = (url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<PutResult>

/** PUT with upload progress (fetch cannot report upload progress, XHR can). */
export const xhrPut: PutFn = (url, body, headers, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader("ETag") })
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error("Network error during upload"))
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"))
    signal.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(body)
  })

export type PartStatus = "pending" | "uploading" | "done" | "failed"
export type UploadState = {
  phase: "idle" | "creating" | "uploading" | "completing" | "done" | "error"
  total: number
  loaded: number
  parts: { partNumber: number; status: PartStatus; loaded: number; size: number }[]
  error: string | null
  songId: string | null
}

/**
 * Uploads one file: creates the song, PUTs bytes (single or 16 MiB multipart parts with per-part retry),
 * then calls /complete. After a failure `retry()` re-uploads only the parts that failed.
 */
export class UploadController {
  state: UploadState
  private listeners = new Set<() => void>()
  private abort = new AbortController()
  private upload: Upload | null = null
  private etags = new Map<number, string>()
  private plan: PartPlan[] = []

  private file: File
  private title: string
  private model: Model
  private put: PutFn
  private concurrency: number
  private retryDelayMs: number

  constructor(file: File, title: string, model: Model, put: PutFn = xhrPut, concurrency = 3, retryDelayMs = 800) {
    this.file = file
    this.title = title
    this.model = model
    this.put = put
    this.concurrency = concurrency
    this.retryDelayMs = retryDelayMs
    this.state = { phase: "idle", total: file.size, loaded: 0, parts: [], error: null, songId: null }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private set(patch: Partial<UploadState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }
  private setPart(i: number, patch: Partial<UploadState["parts"][number]>) {
    const parts = this.state.parts.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    this.set({ parts, loaded: parts.reduce((a, p) => a + p.loaded, 0) })
  }

  cancel() {
    this.abort.abort()
  }

  async start() {
    try {
      this.set({ phase: "creating", error: null })
      const { song, upload } = await api.createSong({
        title: this.title,
        filename: this.file.name,
        content_type: this.file.type || "application/octet-stream",
        size: this.file.size,
        model: this.model,
      })
      this.upload = upload
      this.set({ songId: song.id })
      await this.run()
    } catch (e) {
      this.fail(e)
    }
  }

  /** Re-upload failed parts (or re-run completion) after an error. */
  async retry() {
    if (!this.upload || !this.state.songId) return this.start()
    try {
      this.abort = new AbortController()
      this.set({ error: null })
      await this.run()
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") return this.set({ phase: "error", error: "Upload cancelled" })
    this.set({ phase: "error", error: e instanceof Error ? e.message : "Upload failed" })
  }

  private async run() {
    const upload = this.upload!
    const songId = this.state.songId!
    const signal = this.abort.signal
    this.set({ phase: "uploading" })
    if (upload.mode === "single") {
      if (this.state.parts.length === 0) this.set({ parts: [{ partNumber: 1, status: "pending", loaded: 0, size: this.file.size }] })
      this.setPart(0, { status: "uploading", loaded: 0 })
      try {
        await withRetry(() => this.put(upload.url, this.file, upload.headers, (l) => this.setPart(0, { loaded: l }), signal), { retries: 2, baseDelayMs: this.retryDelayMs, shouldRetry: notAbort })
      } catch (e) {
        this.setPart(0, { status: "failed", loaded: 0 })
        throw e
      }
      this.setPart(0, { status: "done", loaded: this.file.size })
      this.set({ phase: "completing" })
      await api.complete(songId)
    } else {
      if (this.plan.length === 0) {
        this.plan = planParts(this.file.size, upload.part_size)
        this.set({ parts: this.plan.map((p) => ({ partNumber: p.partNumber, status: "pending", loaded: 0, size: p.end - p.start })) })
      }
      const todo = this.plan.filter((p) => !this.etags.has(p.partNumber))
      await this.uploadParts(songId, todo, signal)
      this.set({ phase: "completing" })
      const parts = [...this.etags.entries()].sort((a, b) => a[0] - b[0]).map(([part_number, etag]) => ({ part_number, etag }))
      await api.complete(songId, parts)
    }
    this.set({ phase: "done", loaded: this.file.size })
  }

  private async uploadParts(songId: string, todo: PartPlan[], signal: AbortSignal) {
    // Presigned URLs may have expired on a retry, so fetch fresh ones for just the parts that remain.
    const urls = new Map<number, string>()
    for (let i = 0; i < todo.length; i += PART_URL_BATCH) {
      const res = await api.partUrls(songId, todo.slice(i, i + PART_URL_BATCH).map((p) => p.partNumber))
      res.urls.forEach((u) => urls.set(u.part_number, u.url))
    }
    const queue = [...todo]
    let firstError: unknown = null
    const worker = async () => {
      for (let p = queue.shift(); p && !signal.aborted; p = queue.shift()) {
        const idx = p.partNumber - 1
        const url = urls.get(p.partNumber)
        if (!url) throw new Error(`Missing upload URL for part ${p.partNumber}`)
        this.setPart(idx, { status: "uploading", loaded: 0 })
        try {
          const { etag } = await withRetry(
            () => this.put(url, this.file.slice(p.start, p.end), {}, (l) => this.setPart(idx, { loaded: l }), signal),
            { retries: 3, baseDelayMs: this.retryDelayMs, shouldRetry: notAbort },
          )
          if (!etag) throw new Error("The storage server did not return an ETag. Its CORS rules must expose the ETag header.")
          this.etags.set(p.partNumber, etag)
          this.setPart(idx, { status: "done", loaded: p.end - p.start })
        } catch (e) {
          this.setPart(idx, { status: "failed", loaded: 0 })
          firstError ??= e
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length) }, worker))
    if (firstError) throw firstError
  }
}

const notAbort = (e: unknown) => !(e instanceof DOMException && e.name === "AbortError")
