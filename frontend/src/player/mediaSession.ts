export type MediaHandlers = {
  play: () => void
  pause: () => void
  seekTo: (t: number) => void
  seekBy: (delta: number) => void
}

const ms = () => (typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null)

export function setMediaMetadata(title: string, artwork: string) {
  const s = ms()
  if (!s) return
  s.metadata = new MediaMetadata({ title, artist: "Stemora", album: "Stems", artwork: [{ src: artwork, sizes: "512x512", type: "image/png" }] })
}

export function bindMediaHandlers(h: MediaHandlers) {
  const s = ms()
  if (!s) return
  const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      s.setActionHandler(a, fn)
    } catch {
      /* unsupported action */
    }
  }
  set("play", () => h.play())
  set("pause", () => h.pause())
  set("seekbackward", (d) => h.seekBy(-(d.seekOffset ?? 10)))
  set("seekforward", (d) => h.seekBy(d.seekOffset ?? 10))
  set("seekto", (d) => d.seekTime !== undefined && h.seekTo(d.seekTime))
}

export function clearMediaSession() {
  const s = ms()
  if (!s) return
  s.metadata = null
  s.playbackState = "none"
  for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto"] as const) {
    try {
      s.setActionHandler(a, null)
    } catch {
      /* ignore */
    }
  }
}

export function setPlaybackState(playing: boolean, position: number, duration: number) {
  const s = ms()
  if (!s) return
  s.playbackState = playing ? "playing" : "paused"
  try {
    if (duration > 0) s.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 })
  } catch {
    /* ignore */
  }
}
