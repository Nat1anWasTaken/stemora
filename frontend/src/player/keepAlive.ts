/**
 * Best-effort background playback. iOS/Android only treat a page as "media" (lock-screen controls, keeps running with
 * the screen off, ignores the silent switch) while an HTMLMediaElement plays, so we loop a silent clip in parallel
 * with the Web Audio graph. Failures are ignored.
 */
let el: HTMLAudioElement | null = null

function silentWavUrl(): string {
  const sampleRate = 8000
  const samples = sampleRate // 1 second
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, "RIFF")
  v.setUint32(4, 36 + samples * 2, true)
  w(8, "WAVEfmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, "data")
  v.setUint32(40, samples * 2, true)
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }))
}

export function startKeepAlive() {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = "playback"
    if (!el) {
      el = new Audio(silentWavUrl())
      el.loop = true
      el.setAttribute("playsinline", "")
    }
    void el.play().catch(() => {})
  } catch {
    /* ignore */
  }
}

export function stopKeepAlive() {
  try {
    el?.pause()
  } catch {
    /* ignore */
  }
}
