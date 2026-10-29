import { describe, expect, it } from "vitest"
import type { Song, SongStatus } from "@/lib/api"
import { buildQueue, trackSeen } from "@/lib/queue"
import type { UploadState } from "@/lib/upload"
import type { LocalUpload } from "@/lib/uploads"

let n = 0
const song = (status: SongStatus, extra: Partial<Song> = {}): Song => ({
  id: `s${++n}`,
  title: "t",
  status,
  duration_s: null,
  size_bytes: 1,
  model: "htdemucs",
  progress: 0,
  stage: null,
  error: null,
  source_url: null,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  download: null,
  queue_position: null,
  ...extra,
})

const upload = (phase: UploadState["phase"], songId: string | null): LocalUpload =>
  ({ id: `u${++n}`, title: "f", fileName: "f.mp3", size: 1, ctrl: { state: { phase, songId } } }) as unknown as LocalUpload

describe("buildQueue", () => {
  it("sorts songs into sections", () => {
    const later = song("pending", { queue_position: 2 })
    const next = song("pending", { queue_position: 1 })
    const older = song("processing")
    const newer = song("importing")
    const failed = song("failed")
    const ready = song("ready")
    const q = buildQueue([newer, later, failed, ready, next, older], [], new Set())
    expect(q.running.map((s) => s.id)).toEqual([older.id, newer.id])
    expect(q.waiting.map((s) => s.id)).toEqual([next.id, later.id])
    expect(q.failed).toEqual([failed])
    expect(q.finished).toEqual([])
    expect(q.count).toBe(4)
  })

  it("keeps this tab's uploads apart from uploads sent elsewhere", () => {
    const mine = song("uploading")
    const theirs = song("uploading")
    const sending = upload("uploading", mine.id)
    const starting = upload("creating", null)
    const broken = upload("error", null)
    const q = buildQueue([mine, theirs], [sending, starting, broken], new Set())
    expect(q.elsewhere).toEqual([theirs])
    expect(q.uploads).toHaveLength(3)
    // Failed transfers and other devices' uploads are not counted.
    expect(q.count).toBe(2)
  })

  it("lists ready songs seen in the queue as finished", () => {
    const a = song("ready")
    const b = song("ready")
    expect(buildQueue([a, b], [], new Set([a.id])).finished).toEqual([a])
  })
})

describe("trackSeen", () => {
  it("adds in-flight songs and keeps the set when nothing is new", () => {
    const busy = song("pending")
    const done = song("ready")
    const seen = trackSeen(new Set(), [busy, done])
    expect([...seen]).toEqual([busy.id])
    expect(trackSeen(seen, [busy, done])).toBe(seen)
  })
})
