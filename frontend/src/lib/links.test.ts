import { describe, expect, it } from "vitest"
import { isSpotify, needsLookup } from "@/lib/links"

describe("needsLookup", () => {
  it("looks up Spotify links and playlists", () => {
    for (const l of [
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x",
      "https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy",
      "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      "https://spotify.link/abc",
      "https://www.youtube.com/playlist?list=PL123",
      "https://music.youtube.com/playlist?list=OLAK5uy",
      "https://music.youtube.com/browse/MPREb_abc",
      "https://soundcloud.com/artist/sets/album",
      "https://artist.bandcamp.com/album/name",
    ]) expect(needsLookup(l), l).toBe(true)
  })
  it("queues single songs directly", () => {
    for (const l of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=abc",
      "https://soundcloud.com/artist/track",
      "https://artist.bandcamp.com/track/name",
      "not a link",
    ]) expect(needsLookup(l), l).toBe(false)
  })
  it("recognises Spotify", () => {
    expect(isSpotify("spotify:track:1")).toBe(true)
    expect(isSpotify("https://open.spotify.com/track/1")).toBe(true)
    expect(isSpotify("https://www.youtube.com/watch?v=1")).toBe(false)
  })
})
