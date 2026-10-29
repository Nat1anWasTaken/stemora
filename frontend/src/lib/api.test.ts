import { describe, expect, it } from "vitest"
import { songsQuery } from "@/lib/api"

describe("songsQuery", () => {
  it("leaves out defaults", () => {
    expect(songsQuery({})).toBe("")
    expect(songsQuery({ q: "  ", sort: "newest", cursor: null })).toBe("")
  })
  it("encodes search, sort, limit and cursor", () => {
    expect(songsQuery({ q: " 100% & co ", sort: "title_desc", limit: 30, cursor: "7b22" })).toBe("?q=100%25+%26+co&sort=title_desc&limit=30&cursor=7b22")
    expect(songsQuery({ status: ["pending", "failed"] })).toBe("?status=pending%2Cfailed")
  })
})
