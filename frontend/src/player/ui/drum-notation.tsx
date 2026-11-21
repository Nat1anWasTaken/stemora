import { useEffect, useMemo, useRef, useState } from "react"
import { LocateFixed } from "lucide-react"
import type { AlphaTabApi, synth } from "@coderline/alphatab"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useIsDesktop } from "@/hooks/use-media"
import { toAlphaTex, type FlatSyncPoint } from "@/player/drums/alphatex"
import type { DrumPrecision } from "@/player/drums/precision"
import { quantize, type QBar } from "@/player/drums/quantize"
import { getPosition, usePlayer } from "@/player/store"

/** alphaTab cannot parse oklch(); resolve a theme token to rgb by painting one pixel with it. */
function tokenColor(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx || !value) return "#888888"
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}

/**
 * Drum part as standard notation (alphaTab), driven by our own audio engine: we push the playhead in, alphaTab
 * highlights the notes being played (no cursor). Tap a note to seek there. Follows playback; scrolling by hand
 * pauses following.
 */
export function DrumNotation({ precision }: { precision: DrumPrecision }) {
  const analysis = usePlayer((s) => s.analysis)
  const duration = usePlayer((s) => s.duration)
  const playing = usePlayer((s) => s.playing)
  const desktop = useIsDesktop()
  const notation = useMemo(() => {
    if (!analysis?.drums) return null
    const bars = quantize(analysis, precision.precision, precision.triplets, duration)
    return { bars, ...toAlphaTex(bars, analysis.bpm) }
  }, [analysis, precision, duration])
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const syncPoints = useRef<FlatSyncPoint[]>([])
  const qbars = useRef<QBar[]>([])
  const follow = useRef(true)
  const [instance, setInstance] = useState<AlphaTabApi | null>(null)
  const [following, setFollowing] = useState(true)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const hasNotation = !!notation

  const setFollow = (on: boolean) => {
    follow.current = on
    setFollowing(on)
  }

  // One alphaTab instance per mount (and per layout scale); the module loads only when drum notation is shown.
  useEffect(() => {
    if (!hasNotation) return
    let cancelled = false
    let raf = 0
    let api: AlphaTabApi | null = null

    // Keep the highlighted notes a quarter of the way down the view.
    const scrollToHighlight = (smooth: boolean) => {
      const box = scroller.current
      const el = host.current?.querySelector(".at-highlight")
      if (!follow.current || !box || !el) return
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      const target = Math.max(0, top - box.clientHeight / 4)
      if (Math.abs(target - box.scrollTop) > 24) box.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" })
    }

    import("@coderline/alphatab")
      .then((at) => {
        if (cancelled || !host.current) return
        const fg = tokenColor("--foreground")
        const muted = tokenColor("--muted-foreground")
        api = new at.AlphaTabApi(host.current, {
          core: { fontDirectory: `${import.meta.env.BASE_URL}font/`, engine: "svg" },
          display: {
            staveProfile: at.StaveProfile.Score,
            layoutMode: at.LayoutMode.Page,
            scale: desktop ? 1 : 0.8,
            resources: { mainGlyphColor: fg, secondaryGlyphColor: muted, staffLineColor: muted, barSeparatorColor: muted, barNumberColor: muted, scoreInfoColor: fg },
          },
          notation: {
            elements: new Map([
              [at.NotationElement.ScoreTitle, false],
              [at.NotationElement.ScoreSubTitle, false],
              [at.NotationElement.ScoreArtist, false],
              [at.NotationElement.ScoreAlbum, false],
              [at.NotationElement.ScoreWords, false],
              [at.NotationElement.ScoreMusic, false],
              [at.NotationElement.ScoreWordsAndMusic, false],
              [at.NotationElement.ScoreCopyright, false],
              [at.NotationElement.TrackNames, false],
              [at.NotationElement.EffectTempo, false],
              [at.NotationElement.EffectDynamics, false],
            ]),
          },
          player: {
            playerMode: at.PlayerMode.EnabledExternalMedia,
            enableCursor: false,
            enableElementHighlighting: true,
            // Taps are handled through beatMouseDown below (built-in seek-to-click does not reach external media).
            enableSeekToClick: false,
            enablePlaybackRangeSelection: false,
            scrollMode: at.ScrollMode.Off,
          },
        })
        const self = api
        const handler: synth.IExternalMediaHandler = {
          get backingTrackDuration() {
            return usePlayer.getState().duration * 1000
          },
          // We report song time, so alphaTab must not rescale it.
          playbackRate: 1,
          masterVolume: 1,
          seekTo: (ms) => usePlayer.getState().seek(ms / 1000),
          // Our transport owns play state; alphaTab only mirrors it.
          play: () => {},
          pause: () => {},
        }
        const output = () => self.player?.output as synth.IExternalMediaSynthOutput | undefined
        const attach = () => {
          const o = output()
          if (o && o.handler !== handler) o.handler = handler
        }
        attach()
        self.midiLoaded.on(attach)
        self.scoreLoaded.on((score) => {
          score.applyFlatSyncPoints(syncPoints.current)
          self.updateSyncPoints()
        })
        self.renderFinished.on(() => {
          setReady(true)
          scrollToHighlight(false)
        })
        self.playedBeatChanged.on(() => requestAnimationFrame(() => scrollToHighlight(usePlayer.getState().playing)))
        self.error.on(() => setFailed(true))
        // Tap a note: seek to it, mapped through our own beat grid (bar position -> beat -> song time).
        self.beatMouseDown.on((beat) => {
          const bar = qbars.current[beat.voice.bar.index]
          const length = beat.voice.bar.masterBar.calculateDuration()
          if (!bar || !length) return
          const at = (beat.playbackStart / length) * bar.beats.length
          const b = bar.beats[Math.min(bar.beats.length - 1, Math.floor(at))]
          usePlayer.getState().seek(b.time + (at - Math.floor(at)) * (b.end - b.time))
          setFollow(true)
        })
        const tick = () => {
          output()?.updatePosition(getPosition() * 1000)
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        setInstance(self)
      })
      .catch(() => setFailed(true))
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      api?.destroy()
      setInstance(null)
    }
  }, [hasNotation, desktop])

  // Score (re)load: on a new instance, precision or analysis.
  useEffect(() => {
    if (!notation || !instance) return
    syncPoints.current = notation.syncPoints
    qbars.current = notation.bars
    instance.tex(notation.tex)
  }, [notation, instance])

  // Mirror our transport into alphaTab so it highlights while playing.
  useEffect(() => {
    if (!instance || !ready) return
    if (playing) instance.play()
    else instance.pause()
  }, [playing, ready, instance])

  if (!analysis?.drums) {
    return (
      <section aria-label="Drum notation" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-3xl border border-border bg-surface/70 p-6 text-center text-sm text-muted-foreground">
          {analysis ? (
            <>
              <p className="font-medium text-foreground">No drums detected</p>
              <p>Songs processed before drum charts existed can be reprocessed from the menu to get one.</p>
            </>
          ) : (
            <p>No beat analysis for this song.</p>
          )}
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Drum notation" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="drum-notation relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-3xl border border-border bg-surface/70 scrollbar-none"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        {failed ? (
          <p className="p-6 text-center text-sm text-muted-foreground">The drum notation could not be shown.</p>
        ) : (
          <>
            {!ready && (
              <div className="flex flex-col gap-4 p-4" aria-hidden>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            <div ref={host} className="px-2 pt-2 pb-20" />
          </>
        )}
      </div>
      {!following && (
        <Button variant="secondary" size="icon-lg" aria-label="Follow playback" className="absolute right-2 bottom-2" onClick={() => setFollow(true)}>
          <LocateFixed />
        </Button>
      )}
    </section>
  )
}
