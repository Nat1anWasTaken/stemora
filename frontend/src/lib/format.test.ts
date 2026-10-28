import { describe, expect, it } from "vitest"
import { formatBytes, formatClock, formatRemaining, relativeTime, stageLabel, titleFromFilename } from "@/lib/format"

describe("format", () => {
  it("formats clocks", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(65.9)).toBe("1:05")
    expect(formatClock(3723)).toBe("1:02:03")
    expect(formatClock(NaN)).toBe("0:00")
  })
  it("formats remaining", () => {
    expect(formatRemaining(10, 20)).toBe("-0:10")
    expect(formatRemaining(30, 20)).toBe("-0:00")
  })
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(16 * 1024 * 1024)).toBe("16.0 MB")
    expect(formatBytes(5000 * 1024 * 1024)).toBe("4.9 GB")
  })
  it("formats relative time", () => {
    const now = Date.parse("2026-01-02T12:00:00Z")
    expect(relativeTime("2026-01-02T11:59:50Z", now)).toBe("just now")
    expect(relativeTime("2026-01-02T11:30:00Z", now)).toBe("30 min ago")
    expect(relativeTime("2026-01-02T07:00:00Z", now)).toBe("5 h ago")
    expect(relativeTime("2025-12-30T12:00:00Z", now)).toBe("3 d ago")
  })
  it("derives titles and stage labels", () => {
    expect(titleFromFilename("my_song  v2.final.mp3")).toBe("my song v2.final")
    expect(titleFromFilename(".mp3")).toBe("Untitled")
    expect(stageLabel("separating")).toBe("Separating stems")
    expect(stageLabel(null)).toBe("Waiting for a worker")
  })
})
