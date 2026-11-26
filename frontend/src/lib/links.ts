/**
 * Links that hold more than one song, or a song that has to be found elsewhere first, are looked up
 * (`POST /api/songs/import/resolve`) before importing, so the user can choose what to add. Every other
 * link is queued as it is.
 */
export function needsLookup(link: string): boolean {
  if (link.startsWith("spotify:")) return true
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return false
  }
  const host = u.hostname.replace(/^(www|m)\./, "")
  const path = u.pathname
  if (host === "open.spotify.com" || host === "spotify.link" || host === "spotify.app.link") return true
  if (host === "youtube.com" || host === "music.youtube.com") {
    // A video in a playlist (watch?v=...&list=...) is one song; the playlist page and albums are not.
    return path === "/playlist" || path.startsWith("/browse/")
  }
  if (host === "soundcloud.com") return path.includes("/sets/")
  if (host.endsWith(".bandcamp.com")) return path.startsWith("/album/")
  return false
}

/** Whether a link is a Spotify one (its songs are matched to YouTube uploads). */
export const isSpotify = (link: string) => link.startsWith("spotify:") || /^https?:\/\/(open\.spotify\.com|spotify(\.app)?\.link)\//.test(link)
