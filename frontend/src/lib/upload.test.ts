import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { planParts, PART_SIZE, UploadController, withRetry, type PutFn } from "@/lib/upload"

const MIB = 1024 * 1024

describe("planParts", () => {
  it("splits into 16 MiB parts with a short tail", () => {
    const parts = planParts(40 * MIB, PART_SIZE)
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3])
    expect(parts[0]).toEqual({ partNumber: 1, start: 0, end: 16 * MIB })
    expect(parts[2]).toEqual({ partNumber: 3, start: 32 * MIB, end: 40 * MIB })
  })
  it("handles exact multiples and empty files", () => {
    expect(planParts(32 * MIB, PART_SIZE)).toHaveLength(2)
    expect(planParts(0, PART_SIZE)).toEqual([])
  })
})

describe("withRetry", () => {
  it("retries with exponential backoff then succeeds", async () => {
    const sleeps: number[] = []
    let n = 0
    const r = await withRetry(async () => { if (++n < 3) throw new Error("x"); return "ok" }, { retries: 3, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) })
    expect(r).toBe("ok")
    expect(sleeps).toEqual([100, 200])
  })
  it("gives up after the retry budget", async () => {
    await expect(withRetry(async () => { throw new Error("nope") }, { retries: 1, baseDelayMs: 1, sleep: async () => {} })).rejects.toThrow("nope")
  })
})

describe("UploadController multipart", () => {
  afterEach(() => vi.restoreAllMocks())

  it("retries only the failed part and completes with ETags in order", async () => {
    const size = 40 * MIB
    vi.spyOn(api, "createSong").mockResolvedValue({
      song: { id: "s1" } as never,
      upload: { mode: "multipart", upload_id: "u", part_size: PART_SIZE, part_count: 3 },
    })
    vi.spyOn(api, "partUrls").mockImplementation(async (_id, nums) => ({ urls: nums.map((n) => ({ part_number: n, url: `http://r2/part/${n}` })) }))
    const complete = vi.spyOn(api, "complete").mockResolvedValue({} as never)
    const calls: string[] = []
    let failPart2 = 4 // fails initial attempt + 3 retries => part fails
    const put: PutFn = async (url, body, _h, onProgress) => {
      calls.push(url)
      if (url.endsWith("/2") && failPart2-- > 0) throw new Error("boom")
      onProgress(body.size)
      return { etag: `"e${url.slice(-1)}"` }
    }
    const file = new File([new Uint8Array(size)], "big.wav", { type: "audio/wav" })
    const c = new UploadController(file, "Big", "htdemucs", put, 1, 0)
    await c.start()
    expect(c.state.phase).toBe("error")
    expect(c.state.parts.map((p) => p.status)).toEqual(["done", "failed", "done"])
    expect(complete).not.toHaveBeenCalled()

    calls.length = 0
    await c.retry()
    expect(calls).toEqual(["http://r2/part/2"])
    expect(c.state.phase).toBe("done")
    expect(complete).toHaveBeenCalledWith("s1", [
      { part_number: 1, etag: '"e1"' },
      { part_number: 2, etag: '"e2"' },
      { part_number: 3, etag: '"e3"' },
    ])
    expect(c.state.loaded).toBe(size)
  })

  it("fails clearly when the ETag header is not exposed", async () => {
    vi.spyOn(api, "createSong").mockResolvedValue({ song: { id: "s" } as never, upload: { mode: "multipart", upload_id: "u", part_size: PART_SIZE, part_count: 1 } })
    vi.spyOn(api, "partUrls").mockResolvedValue({ urls: [{ part_number: 1, url: "http://r2/1" }] })
    const c = new UploadController(new File([new Uint8Array(10)], "a.mp3"), "A", "htdemucs", async () => ({ etag: null }), 1, 0)
    await c.start()
    expect(c.state.error).toMatch(/ETag/)
  })
})

describe("UploadController single", () => {
  afterEach(() => vi.restoreAllMocks())
  it("PUTs with the given headers then completes", async () => {
    vi.spyOn(api, "createSong").mockResolvedValue({ song: { id: "s" } as never, upload: { mode: "single", url: "http://r2/x", headers: { "Content-Type": "audio/mpeg" } } })
    const complete = vi.spyOn(api, "complete").mockResolvedValue({} as never)
    const put = vi.fn<PutFn>(async (_u, b, _h, p) => { p(b.size); return { etag: null } })
    const c = new UploadController(new File([new Uint8Array(100)], "a.mp3"), "A", "scnet_xl_ihf", put, 1, 0)
    await c.start()
    expect(put.mock.calls[0][2]).toEqual({ "Content-Type": "audio/mpeg" })
    expect(complete).toHaveBeenCalledWith("s")
    expect(c.state.phase).toBe("done")
  })
})
