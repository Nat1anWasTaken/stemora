import { describe, expect, it, vi } from "vitest"

vi.mock("@/player/store", () => ({ usePlayer: { getState: () => ({}) }, getPosition: () => 0, setSongEndedHandler: () => {}, settingsOf: () => ({}) }))
vi.mock("@/lib/query-client", () => ({ queryClient: {} }))
vi.mock("@/player/offline", () => ({ offlineDetail: async () => null, offlineSetlist: async () => null }))

const { effectiveSource, insertNext, moveItem, removeItem, transitionAfter } = await import("@/player/up-next")

const it_ = (key: string, extra = {}) => ({ key, songId: key, title: key, ...extra })
const list = { items: [it_("a"), it_("b"), it_("c")], index: 1 }

describe("Up Next lists", () => {
  it("inserts after the current song", () => {
    expect(insertNext(list, [it_("x")]).items.map((x) => x.key)).toEqual(["a", "b", "x", "c"])
    expect(insertNext({ items: [], index: -1 }, [it_("x")])).toEqual({ items: [it_("x")], index: -1 })
  })
  it("removes others but never the current one", () => {
    expect(removeItem(list, "b")).toBe(list)
    expect(removeItem(list, "a")).toEqual({ items: [it_("b"), it_("c")], index: 0 })
  })
  it("moves items and follows the current one", () => {
    expect(moveItem(list, "c", -1)).toEqual({ items: [it_("a"), it_("c"), it_("b")], index: 2 })
    expect(moveItem(list, "b", -1)).toEqual({ items: [it_("b"), it_("a"), it_("c")], index: 0 })
    expect(moveItem(list, "a", -1)).toBe(list)
  })
  it("decides what follows a song", () => {
    const setlist = { id: "s", name: "S", transition: "stop" as const }
    const items = [it_("a", { entryId: "1", transition: "continue" }), it_("b", { entryId: "2", transition: null }), it_("c")]
    expect(transitionAfter(items, 0, setlist)).toBe("continue")
    expect(transitionAfter(items, 1, setlist)).toBe("stop")
    expect(transitionAfter(items, 2, setlist)).toBe("stop")
    expect(transitionAfter(items, 2, null)).toBe("continue")
  })
  it("uses setlist settings only for the setlist's songs", () => {
    const setlist = { id: "s", name: "S", transition: "stop" as const }
    expect(effectiveSource("setlist", it_("a", { entryId: "1" }), setlist)).toBe("setlist")
    expect(effectiveSource("setlist", it_("a"), setlist)).toBe("song")
    expect(effectiveSource("listening", it_("a"), null)).toBe("listening")
  })
})
