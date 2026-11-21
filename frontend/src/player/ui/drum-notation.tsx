import { useCallback, useEffect, useRef, useState } from "react"
import { LocateFixed, RotateCcw } from "lucide-react"
import type { AlphaTabApi, model, synth } from "@coderline/alphatab"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useIsDesktop } from "@/hooks/use-media"
import { updateAfterCrash } from "@/lib/pwa-update"
import { cn } from "@/lib/utils"
import type { DrumChart } from "@/player/drums/chart"
import type { NotationPrefs } from "@/player/drums/notation-prefs"
import { getPosition, usePlayer } from "@/player/store"
import { settlePinch, usePinchZoom, type PinchAnchor } from "@/player/ui/use-pinch-zoom"

type AlphaTab = typeof import("@coderline/alphatab")

/** Room per bar (at scale 1) when a phone shows a fixed number of bars per row, plus the row's clef and margins. */
const BAR_WIDTH = 220
const ROW_EXTRA = 90

/** alphaTab cannot parse oklch(); resolve a theme token (as seen from `el`) to rgb by painting one pixel with it. */
function tokenColor(el: Element, name: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim()
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx || !value) return "#888888"
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}

const TRACK_0 = new Set([0])
/** Longest a score may take to draw before we offer Retry. */
const DRAW_TIMEOUT_MS = 20_000
const REST_TONE = 2
const REST_OCTAVE = 4

const scaleFor = (desktop: boolean, zoom: number) => (desktop ? 1 : 0.8) * zoom

/** Hands stem up, feet stem down; the kick voice's rests sit low and quiet instead of above the staff. */
function styleDrumScore(at: AlphaTab, score: model.Score) {
  for (const bar of score.tracks[0]?.staves[0]?.bars ?? []) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        beat.preferredBeamDirection = voice.index === 0 ? at.rendering.BeamDirection.Up : at.rendering.BeamDirection.Down
        if (voice.index === 1 && beat.isRest) {
          beat.restDisplayTone = REST_TONE
          beat.restDisplayOctave = REST_OCTAVE
        }
      }
    }
  }
}

function applyBreaks(score: model.Score, breaks: number[]) {
  const track = score.tracks[0]
  if (!track) return
  track.lineBreaks = new Set(breaks.filter((b) => b > 0 && b < score.masterBars.length))
}

/** Why the notation is not shown: per attempt, and for a drawing problem also per chart (another grid may draw fine). */
type Failure = { attempt: number; chart: DrumChart | null; module: boolean }

type Live = { prefs: NotationPrefs; desktop: boolean; breaks: number[]; chart: DrumChart | null }

/**
 * Drum part as standard notation (alphaTab), driven by our own audio engine: we push the playhead in, alphaTab
 * highlights the notes being played (no cursor); while paused we mark the beat under the playhead ourselves, so a
 * tapped note stays visibly selected. Tap a note to seek there. Follows playback; scrolling by hand pauses following.
 * Theme, bars per row and zoom only redraw; line breaks only re-lay out; a new chart reloads the score.
 */
export function DrumNotation({ chart, prefs, breaks, onZoom }: {
  chart: DrumChart | null
  prefs: NotationPrefs
  breaks: number[]
  onZoom: (zoom: number) => void
}) {
  const analysis = usePlayer((s) => s.analysis)
  const playing = usePlayer((s) => s.playing)
  const desktop = useIsDesktop()
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const live = useRef<Live>({ prefs, desktop, breaks, chart })
  /** Sync points and bars of the chart being loaded; they become current once alphaTab has read it. */
  const pending = useRef<DrumChart | null>(null)
  const current = useRef<DrumChart | null>(null)
  const anchor = useRef<PinchAnchor | null>(null)
  const at = useRef<AlphaTab | null>(null)
  /** The settings alphaTab last got, to skip redraws that would change nothing. */
  const displayKey = useRef("")
  const [instance, setInstance] = useState<AlphaTabApi | null>(null)
  const [following, setFollowing] = useState(true)
  /** The chart last drawn completely, and the last failure (per attempt; a drawing error also per chart). */
  const [drawn, setDrawn] = useState<DrumChart | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const drawnRef = useRef<DrumChart | null>(null)
  const ready = !!chart && drawn === chart
  // A late finish after the watchdog gave up still counts: show the drawing.
  const failed = !ready && !!failure && failure.attempt === attempt && (failure.chart === null || failure.chart === chart)
  const hasNotation = !!chart
  const wide = !desktop && prefs.barsPerRow > 0

  useEffect(() => {
    live.current = { prefs, desktop, breaks, chart }
  }, [prefs, desktop, breaks, chart])

  const setFollow = (on: boolean) => {
    follow.current = on
    setFollowing(on)
  }

  /** Push size, layout and colours into alphaTab's settings (the caller renders). */
  const applyDisplay = useCallback((api: AlphaTabApi) => {
    const el = host.current
    const lib = at.current
    if (!el || !lib) return
    const { prefs: p, desktop: d } = live.current
    const scale = scaleFor(d, p.zoom)
    const display = api.settings.display
    display.scale = scale
    display.barsPerRow = p.barsPerRow > 0 ? p.barsPerRow : -1
    const color = (name: string) => lib.model.Color.fromJson(tokenColor(el, name))!
    const fg = color("--notation-foreground")
    const muted = color("--notation-muted")
    // Both voices (hands and kick) are equally important on a drum chart, so neither is greyed out.
    Object.assign(display.resources, { mainGlyphColor: fg, secondaryGlyphColor: fg, staffLineColor: muted, barSeparatorColor: muted, barNumberColor: muted, scoreInfoColor: fg })
    // A phone with a fixed number of bars per row draws the rows at a readable size and scrolls sideways.
    if (!d && p.barsPerRow > 0) el.style.setProperty("--notation-width", `${Math.round((p.barsPerRow * BAR_WIDTH + ROW_EXTRA) * scale)}px`)
    else el.style.removeProperty("--notation-width")
    api.updateSettings()
    displayKey.current = `${p.theme}|${p.barsPerRow}|${p.zoom}|${d}`
  }, [])

  // One alphaTab instance per mount (and per retry); the module loads only when drum notation is shown.
  useEffect(() => {
    if (!hasNotation) return
    let cancelled = false
    let raf = 0
    let api: AlphaTabApi | null = null

    // Keep the highlighted notes a quarter of the way down (and, when the sheet is wider than the view, in view sideways).
    const scrollToHighlight = (smooth: boolean) => {
      const box = scroller.current
      const el = host.current?.querySelector(".at-highlight, .at-selected")
      if (!follow.current || !box || !el) return
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const top = Math.max(0, r.top - b.top + box.scrollTop - box.clientHeight / 4)
      const left = r.left - b.left + box.scrollLeft
      const inView = left >= box.scrollLeft + 16 && left <= box.scrollLeft + box.clientWidth - 48
      const target = { top: Math.abs(top - box.scrollTop) > 24 ? top : box.scrollTop, left: inView ? box.scrollLeft : Math.max(0, left - box.clientWidth / 4) }
      if (target.top !== box.scrollTop || target.left !== box.scrollLeft) box.scrollTo({ ...target, behavior: smooth ? "smooth" : "auto" })
    }

    import("@coderline/alphatab")
      .then((lib) => {
        if (cancelled || !host.current) return
        at.current = lib
        api = new lib.AlphaTabApi(host.current, {
          core: {
            engine: "svg",
            // On a retry, fetch the music font afresh: the browser keeps a failed font face for the page's life.
            smuflFontSources: new Map(
              [...lib.CoreSettings.buildDefaultSmuflFontSources(`${import.meta.env.BASE_URL}font/`)].map(([f, url]) => [f, attempt ? `${url}?retry=${attempt}` : url]),
            ),
          },
          display: { staveProfile: lib.StaveProfile.Score, layoutMode: lib.LayoutMode.Page },
          notation: {
            elements: new Map([
              [lib.NotationElement.ScoreTitle, false],
              [lib.NotationElement.ScoreSubTitle, false],
              [lib.NotationElement.ScoreArtist, false],
              [lib.NotationElement.ScoreAlbum, false],
              [lib.NotationElement.ScoreWords, false],
              [lib.NotationElement.ScoreMusic, false],
              [lib.NotationElement.ScoreWordsAndMusic, false],
              [lib.NotationElement.ScoreCopyright, false],
              [lib.NotationElement.TrackNames, false],
              [lib.NotationElement.EffectTempo, false],
              [lib.NotationElement.EffectDynamics, false],
            ]),
          },
          player: {
            playerMode: lib.PlayerMode.EnabledExternalMedia,
            enableCursor: false,
            enableElementHighlighting: true,
            // Taps are handled through beatMouseDown below (built-in seek-to-click does not reach external media).
            enableSeekToClick: false,
            enablePlaybackRangeSelection: false,
            scrollMode: lib.ScrollMode.Off,
          },
        })
        const self = api
        applyDisplay(self)
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
        // A new score reloads the MIDI, which stops alphaTab's player: start it again if our transport is playing,
        // or it would stop highlighting.
        const resume = () => {
          if (cancelled) return
          const o = output()
          if (o && o.handler !== handler) o.handler = handler
          if (usePlayer.getState().playing && self.playerState !== lib.synth.PlayerState.Playing) self.play()
        }
        resume()
        self.midiLoaded.on(resume)
        self.playerReady.on(resume)
        self.scoreLoaded.on((score) => {
          if (cancelled) return
          const next = pending.current
          if (next) {
            current.current = next
            score.applyFlatSyncPoints(next.syncPoints)
          }
          styleDrumScore(lib, score)
          applyBreaks(score, live.current.breaks)
          self.updateSyncPoints()
        })

        // While paused alphaTab highlights nothing: mark the beat under the playhead ourselves.
        let marked: Element[] = []
        let markedKey = ""
        let renders = 0
        const unmark = () => {
          for (const el of marked) el.classList.remove("at-selected")
          marked = []
          markedKey = ""
        }
        const mark = () => {
          const cache = self.tickCache
          const el = host.current
          if (!cache || !el) return
          const found = cache.findBeat(TRACK_0, self.tickPosition)
          const ids = found ? found.beatLookup.highlightedBeats.map((h) => h.beat.id) : []
          const key = `${renders}:${ids.join(",")}`
          // alphaTab inserts the drawing in chunks after it reports the render done: mark again until it is there.
          if (key === markedKey && (ids.length === 0 || (marked.length > 0 && marked[0].isConnected))) return
          const moved = key !== markedKey || marked.length === 0
          unmark()
          markedKey = key
          for (const id of ids) {
            for (const node of el.getElementsByClassName(`b${id}`)) {
              node.classList.add("at-selected")
              marked.push(node)
            }
          }
          if (moved && marked.length) requestAnimationFrame(() => scrollToHighlight(false))
        }

        self.renderFinished.on(() => {
          if (cancelled) return
          renders++
          markedKey = ""
          drawnRef.current = current.current
          setDrawn(current.current)
          const a = anchor.current
          if (a && scroller.current && host.current) {
            anchor.current = null
            settlePinch(scroller.current, host.current, a)
          } else scrollToHighlight(false)
          resume()
        })
        self.playedBeatChanged.on(() => requestAnimationFrame(() => scrollToHighlight(usePlayer.getState().playing)))
        self.error.on((e) => {
          if (cancelled) return
          console.error("Drum notation failed", e)
          setFailure({ attempt, chart: pending.current, module: false })
        })
        // Tap a note: seek to it, mapped through our own beat grid (bar position -> beat -> song time).
        self.beatMouseDown.on((beat) => {
          const bar = current.current?.bars[beat.voice.bar.index]
          const length = beat.voice.bar.masterBar.calculateDuration()
          if (!bar || !length) return
          const pos = (beat.playbackStart / length) * bar.beats.length
          const b = bar.beats[Math.min(bar.beats.length - 1, Math.floor(pos))]
          usePlayer.getState().seek(b.time + (pos - Math.floor(pos)) * (b.end - b.time))
          setFollow(true)
        })
        const tick = () => {
          output()?.updatePosition(getPosition() * 1000)
          if (usePlayer.getState().playing) {
            if (marked.length) unmark()
          } else mark()
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        setInstance(self)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        console.error("Drum notation failed to load", e)
        setFailure({ attempt, chart: null, module: true })
      })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      api?.destroy()
      setInstance(null)
      setDrawn(null)
      drawnRef.current = null
    }
  }, [hasNotation, attempt, applyDisplay])

  // Score (re)load: on a new instance or a new chart (precision, analysis).
  useEffect(() => {
    if (!chart || !instance) return
    pending.current = chart
    instance.tex(chart.tex)
    // alphaTab reports some failures (e.g. its music font not loading) only to the console and never draws:
    // give up after a while so Retry is offered instead of an endless placeholder.
    const watchdog = setTimeout(() => {
      if (drawnRef.current === chart) return
      console.error("Drum notation did not finish drawing")
      setFailure({ attempt, chart, module: false })
    }, DRAW_TIMEOUT_MS)
    return () => clearTimeout(watchdog)
  }, [chart, instance, attempt])

  // Theme, bars per row, zoom or layout size changed: redraw the loaded score with the new settings.
  useEffect(() => {
    if (!instance || !ready || displayKey.current === `${prefs.theme}|${prefs.barsPerRow}|${prefs.zoom}|${desktop}`) return
    applyDisplay(instance)
    instance.render()
  }, [instance, ready, prefs.theme, prefs.barsPerRow, prefs.zoom, desktop, applyDisplay])

  // Line breaks changed: only the layout changes (no new MIDI or sync points).
  const appliedBreaks = useRef(breaks)
  useEffect(() => {
    const score = instance?.score
    if (!instance || !score || !ready || appliedBreaks.current === breaks) return
    appliedBreaks.current = breaks
    applyBreaks(score, breaks)
    instance.render()
  }, [instance, ready, breaks])

  // Mirror our transport into alphaTab so it highlights while playing.
  useEffect(() => {
    if (!instance || !ready) return
    if (playing) instance.play()
    else instance.pause()
  }, [playing, ready, instance])

  const retry = async () => {
    // A module that failed to load stays failed until the page reloads (usually a deploy replaced it).
    if (failure?.module) {
      if (!(await updateAfterCrash())) window.location.reload()
      return
    }
    setAttempt((n) => n + 1)
  }

  usePinchZoom(scroller, host, !desktop && hasNotation && !failed, prefs.zoom, (zoom, a) => {
    anchor.current = a
    setFollow(false)
    onZoom(zoom)
  })

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
    <section aria-label="Drum notation" data-notation-theme={prefs.theme} className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className={cn(
          "drum-notation relative min-h-0 flex-1 overscroll-contain rounded-3xl border border-border bg-notation scrollbar-none",
          wide ? "overflow-auto" : "overflow-x-hidden overflow-y-auto",
          !desktop && "touch-pan",
        )}
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        {failed && (
          <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-notation-muted">
            <p>The drum notation could not be shown.</p>
            <Button variant="secondary" size="sm" onClick={retry}>
              <RotateCcw />Retry
            </Button>
          </div>
        )}
        {!ready && !failed && (
          <div className="absolute inset-x-0 top-0 flex flex-col gap-4 p-4" aria-hidden>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {/* Stays mounted and sized when drawing fails: alphaTab keeps this element (and waits while it is not
            displayed), and a slow drawing may still finish or a new chart may draw fine. */}
        <div ref={host} className={cn("notation-canvas px-2 pt-2 pb-20", failed && "invisible absolute inset-x-0 top-0")} />
      </div>
      {!following && !failed && (
        <Button variant="secondary" size="icon-lg" aria-label="Follow playback" className="absolute right-2 bottom-2" onClick={() => setFollow(true)}>
          <LocateFixed />
        </Button>
      )}
    </section>
  )
}
