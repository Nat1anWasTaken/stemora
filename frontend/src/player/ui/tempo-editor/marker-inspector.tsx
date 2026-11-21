import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import {
  ChevronDown, ChevronLeft, ChevronRight, Crosshair, LocateFixed, Maximize2, Minus, Plus, Redo2, Sparkles, Trash2, Undo2, ZoomIn, ZoomOut,
} from "lucide-react"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { usePlayer } from "@/player/store"
import {
  canDeleteMarker, clampBpm, COMMON_SIGNATURES, DENOMINATORS, formatTimeSignature, isImplicitStart, markerNumber, MAX_NUM, parseTimeSignature,
  visibleMarkerCount, type TempoMarker, type TimeSignature,
} from "@/player/tempo-map"
import { formatBpm } from "@/player/ui/use-playhead-tempo"
import { flagLabel } from "@/player/ui/tempo-editor/render"
import { Swap, ToolbarDivider } from "@/player/ui/workspace"
import { applyDetectedTempo, deleteMarker, nudgeMarker, replaceMarker, setBpm, setKind } from "@/player/ui/tempo-editor/actions"

/** A text field that edits a value on Enter or blur and goes back to it on Escape or invalid input. */
function useDraft<T>(value: T, format: (v: T) => string, parse: (s: string) => T | null, onCommit: (v: T) => void) {
  const [draft, setDraft] = useState(() => format(value))
  const [invalid, setInvalid] = useState(false)
  const focused = useRef(false)
  /** Set when the field already committed or cancelled (Enter, Escape), so the blur that follows does nothing. */
  const settled = useRef(false)
  const shown = format(value)
  useEffect(() => {
    if (!focused.current) setDraft(shown)
  }, [shown])
  const commit = () => {
    const v = parse(draft)
    if (v === null) {
      setInvalid(true)
      window.setTimeout(() => setInvalid(false), 600)
      setDraft(shown)
      return
    }
    onCommit(v)
    setDraft(format(v))
  }
  return {
    invalid,
    props: {
      value: draft,
      "aria-invalid": invalid || undefined,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
      onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
        focused.current = true
        e.target.select()
      },
      onBlur: () => {
        focused.current = false
        if (settled.current) settled.current = false
        else commit()
      },
    },
    /** Commit now (Enter); the blur that follows is skipped. */
    commit: () => {
      commit()
      settled.current = true
    },
    /** Drop the draft (Escape); the blur that follows is skipped. */
    revert: () => {
      setDraft(shown)
      settled.current = true
    },
    /** The value being edited: the draft if it parses, else the committed value. */
    current: () => parse(draft) ?? value,
    /** Commit `v` and show it, staying in the field (arrow keys). */
    step: (v: T) => {
      setDraft(format(v))
      onCommit(v)
    },
  }
}

/** BPM input: type a value (two decimals), or ↑/↓ for ±1 (Shift ±0.1, Alt ±0.01). */
export function BpmField({ bpm, onCommit, inputRef, large }: { bpm: number; onCommit: (bpm: number) => void; inputRef?: RefObject<HTMLInputElement | null>; large?: boolean }) {
  const d = useDraft(bpm, formatBpm, (s) => {
    const n = Number(s.replace(",", "."))
    return s.trim() && Number.isFinite(n) ? clampBpm(n) : null
  }, onCommit)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === "Enter") {
      d.commit()
      e.currentTarget.blur()
    } else if (e.key === "Escape") {
      d.revert()
      e.currentTarget.blur()
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault()
      const step = (e.altKey ? 0.01 : e.shiftKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1)
      d.step(clampBpm(d.current() + step))
    }
  }
  return (
    <Input
      ref={inputRef}
      aria-label="BPM"
      title="BPM (↑↓, Shift, Alt)"
      inputMode="decimal"
      autoComplete="off"
      variant="value"
      inputSize={large ? "lg" : "default"}
      className={large ? "w-24" : "w-20"}
      onKeyDown={onKeyDown}
      {...d.props}
    />
  )
}

/** Common meters and numerator / denominator steppers. */
export function TimeSignaturePicker({ value, onPick }: { value: TimeSignature; onPick: (s: TimeSignature) => void }) {
  const dens: readonly number[] = DENOMINATORS
  const di = dens.indexOf(value.den)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1.5">
        {COMMON_SIGNATURES.map((s) => {
          const on = s.num === value.num && s.den === value.den
          return (
            <Button key={formatTimeSignature(s)} variant="toggle" size="sm" aria-pressed={on} onClick={() => onPick(s)}>
              {formatTimeSignature(s)}
            </Button>
          )
        })}
      </div>
      <div className="flex items-center justify-center gap-4">
        <Stepper label="Beats per bar" value={value.num} onMinus={value.num > 1 ? () => onPick({ ...value, num: value.num - 1 }) : undefined} onPlus={value.num < MAX_NUM ? () => onPick({ ...value, num: value.num + 1 }) : undefined} />
        <span className="text-2xl font-light text-muted-foreground">/</span>
        <Stepper label="Beat note" value={value.den} onMinus={di > 0 ? () => onPick({ ...value, den: dens[di - 1] }) : undefined} onPlus={di < dens.length - 1 ? () => onPick({ ...value, den: dens[di + 1] }) : undefined} />
      </div>
    </div>
  )
}

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus?: () => void; onPlus?: () => void }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <Button variant="secondary" size="icon-lg" aria-label={`Fewer: ${label}`} disabled={!onMinus} onClick={onMinus}><Minus /></Button>
      <span className="w-8 text-center font-heading text-xl font-semibold tabular-nums">{value}</span>
      <Button variant="secondary" size="icon-lg" aria-label={`More: ${label}`} disabled={!onPlus} onClick={onPlus}><Plus /></Button>
    </div>
  )
}

/** Time signature input: type "6/8" (or "6 8", "6:8"), or pick from the list beside it. */
export function TimeSignatureField({ value, onCommit, picker = true }: { value: TimeSignature; onCommit: (s: TimeSignature) => void; picker?: boolean }) {
  const d = useDraft(value, formatTimeSignature, parseTimeSignature, onCommit)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === "Enter") {
      d.commit()
      e.currentTarget.blur()
    } else if (e.key === "Escape") {
      d.revert()
      e.currentTarget.blur()
    }
  }
  return (
    <div className="flex items-center">
      <Input
        aria-label="Time signature"
        title="Time signature, e.g. 6/8"
        autoComplete="off"
        variant="value"
        attached={picker}
        className="w-16"
        onKeyDown={onKeyDown}
        {...d.props}
      />
      {picker && (
        <ResponsivePanel title="Time signature" size="wide" trigger={<Button variant="addon" size="addon" aria-label="Pick a time signature"><ChevronDown /></Button>}>
          <TimeSignaturePicker value={value} onPick={onCommit} />
        </ResponsivePanel>
      )}
    </div>
  )
}

/**
 * Auto / Manual for a marker. The implicit start (the song's default, no marker yet) gets a plain "Set tempo" instead:
 * it makes the start manual, and so a marker the user can see.
 */
function KindSwitch({ marker, index, large }: { marker: TempoMarker; index: number; large?: boolean }) {
  const implicit = usePlayer((s) => isImplicitStart(s.markers, index))
  if (implicit) {
    return (
      <Button variant="secondary" size={large ? "default" : "sm"} title="Set a fixed tempo from the start of the song" onClick={() => setKind(index, "manual")}>
        Set tempo
      </Button>
    )
  }
  return (
    <Tabs value={marker.kind} onValueChange={(v) => setKind(index, v as "auto" | "manual")}>
      <TabsList variant="pill" aria-label="Marker kind">
        <TabsTrigger value="auto">Auto</TabsTrigger>
        <TabsTrigger value="manual">Manual</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export type EditorControls = {
  active: number
  onLocate: (dir: -1 | 1) => void
  onAdd: () => void
  onZoom: (factor: number) => void
  onFit: () => void
  following: boolean
  onFollow: () => void
  bpmRef: RefObject<HTMLInputElement | null>
}

const tip = (label: string, key: string) => `${label} (${key})`

/** Desktop tools for the workspace toolbar: the marker being edited, then add, history, zoom and follow. */
export function DesktopToolbar({ c }: { c: EditorControls }) {
  const markers = usePlayer((s) => s.markers)
  const canUndo = usePlayer((s) => s.canUndo)
  const canRedo = usePlayer((s) => s.canRedo)
  const analysis = usePlayer((s) => s.analysis)
  const { undo, redo } = usePlayer.getState()
  const i = Math.min(c.active, markers.length - 1)
  const m = markers[i]
  return (
    <Swap className="items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="Previous marker" title={tip("Previous marker", "Shift+B")} onClick={() => c.onLocate(-1)}><ChevronLeft /></Button>
      <MarkerCount markers={markers} index={i} />
      <Button variant="ghost" size="icon-sm" aria-label="Next marker" title={tip("Next marker", "Shift+N")} onClick={() => c.onLocate(1)}><ChevronRight /></Button>
      <ToolbarDivider />
      {m && isImplicitStart(markers, i) && <span className="px-1 text-xs text-muted-foreground">Detected beats</span>}
      {m && <KindSwitch marker={m} index={i} />}
      {m?.kind === "manual" && (
        <>
          {/* Keyed by marker so a draft never carries over to (and commits into) the next marker during playback. */}
          <BpmField key={`bpm-${i}`} bpm={m.bpm} inputRef={c.bpmRef} onCommit={(bpm) => setBpm(i, bpm)} />
          <TimeSignatureField key={`ts-${i}`} value={m} onCommit={(s) => replaceMarker(i, { ...m, ...s })} />
          <Button variant="ghost" size="icon-sm" aria-label="Detected tempo" title="Detected tempo" disabled={!analysis} onClick={() => applyDetectedTempo(i)}><Sparkles /></Button>
        </>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Delete marker" title={tip("Delete marker", "Del")} disabled={!canDeleteMarker(markers, i)} onClick={() => deleteMarker(i)}><Trash2 /></Button>
      <div className="ml-auto flex items-center gap-0.5">
        <Button variant="secondary" size="icon-sm" aria-label="Add marker" title={tip("Add marker", "T")} onClick={c.onAdd}><Plus /></Button>
        <ToolbarDivider />
        <Button variant="ghost" size="icon-sm" aria-label="Undo" title={tip("Undo", "Ctrl+Z")} disabled={!canUndo} onClick={undo}><Undo2 /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" title={tip("Redo", "Ctrl+Shift+Z")} disabled={!canRedo} onClick={redo}><Redo2 /></Button>
        <ToolbarDivider />
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title={tip("Zoom out", "G")} onClick={() => c.onZoom(1 / 1.6)}><ZoomOut /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title={tip("Zoom in", "H")} onClick={() => c.onZoom(1.6)}><ZoomIn /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Whole song" title={tip("Whole song", "Shift+F")} onClick={c.onFit}><Maximize2 /></Button>
        <Button variant="toggle" size="icon-sm" aria-label="Follow playback" title={tip("Follow playback", "F")} aria-pressed={c.following} onClick={c.onFollow}><LocateFixed /></Button>
      </div>
    </Swap>
  )
}

/** Phone tools for the workspace toolbar: markers either side, the one at the cursor (tap to edit), add, move here, undo. */
export function MobileToolbar({ c, onMoveHere }: { c: EditorControls; onMoveHere: () => void }) {
  const markers = usePlayer((s) => s.markers)
  const canUndo = usePlayer((s) => s.canUndo)
  const { undo } = usePlayer.getState()
  const i = Math.min(c.active, markers.length - 1)
  const m = markers[i]
  return (
    <Swap className="items-center gap-1">
      <Button variant="ghost" size="icon-lg" aria-label="Previous marker" onClick={() => c.onLocate(-1)}><ChevronLeft /></Button>
      {m && (
        <MarkerDrawer index={i} marker={m}>
          <Button variant="chip" className="min-w-0 flex-1" aria-label={isImplicitStart(markers, i) ? "Set tempo (now following the detected beats)" : `Edit marker ${markerNumber(markers, i)}: ${flagLabel(m)}`}>
            <span className={cn("size-2 shrink-0 rounded-full", m.kind === "manual" ? "bg-primary" : "bg-muted-foreground")} />
            <span className="truncate">{isImplicitStart(markers, i) ? "Set tempo" : flagLabel(m)}</span>
          </Button>
        </MarkerDrawer>
      )}
      <Button variant="ghost" size="icon-lg" aria-label="Next marker" onClick={() => c.onLocate(1)}><ChevronRight /></Button>
      <Button variant="secondary" size="icon-lg" aria-label="Add marker at the cursor" onClick={c.onAdd}><Plus /></Button>
      <Button variant="secondary" size="icon-lg" aria-label="Move this marker to the cursor" disabled={i === 0} onClick={onMoveHere}><Crosshair /></Button>
      <Button variant="ghost" size="icon-lg" aria-label="Undo" disabled={!canUndo} onClick={undo}><Undo2 /></Button>
    </Swap>
  )
}

/** Marker editor in a panel (a bottom sheet on phones): kind, BPM (−/+ by 1 and 0.1), meter, nudge, detected tempo, delete. */
function MarkerDrawer({ index, marker: m, children }: { index: number; marker: TempoMarker; children: React.ReactElement }) {
  const analysis = usePlayer((s) => s.analysis)
  const implicit = usePlayer((s) => isImplicitStart(s.markers, index))
  const deletable = usePlayer((s) => canDeleteMarker(s.markers, index))
  const [open, setOpen] = useState(false)
  const nudge = (dir: -1 | 1) => nudgeMarker(index, dir, 0.005)
  if (implicit) {
    return (
      <ResponsivePanel title="Tempo" open={open} onOpenChange={setOpen} trigger={children}>
        <p className="text-center text-sm text-muted-foreground">
          The beats come from the song itself. Set a fixed tempo to choose the BPM and time signature yourself, or add a marker where the tempo changes.
        </p>
        <div className="flex justify-center"><KindSwitch marker={m} index={index} large /></div>
      </ResponsivePanel>
    )
  }
  return (
    <ResponsivePanel
      title={markerClock(m.time)}
      open={open}
      onOpenChange={setOpen}
      trigger={children}
      action={<Button variant="destructive" size="icon-lg" aria-label="Delete marker" disabled={!deletable} onClick={() => {
        if (deleteMarker(index)) setOpen(false)
      }}><Trash2 /></Button>}
    >
      <div className="flex justify-center"><KindSwitch marker={m} index={index} /></div>
      {m.kind === "manual" && (
        <>
          <Row>
            <Button variant="secondary" size="icon-lg" aria-label="BPM −1" onClick={() => setBpm(index, m.bpm - 1)}><Minus /></Button>
            <Button variant="ghost" size="icon-lg" aria-label="BPM −0.1" onClick={() => setBpm(index, m.bpm - 0.1)}>−.1</Button>
            <BpmField key={`bpm-${index}`} bpm={m.bpm} onCommit={(bpm) => setBpm(index, bpm)} large />
            <Button variant="ghost" size="icon-lg" aria-label="BPM +0.1" onClick={() => setBpm(index, m.bpm + 0.1)}>+.1</Button>
            <Button variant="secondary" size="icon-lg" aria-label="BPM +1" onClick={() => setBpm(index, m.bpm + 1)}><Plus /></Button>
          </Row>
          <div className="flex flex-col items-center gap-3">
            <TimeSignatureField key={`ts-${index}`} value={m} picker={false} onCommit={(s) => replaceMarker(index, { ...m, ...s })} />
            <TimeSignaturePicker value={m} onPick={(s) => replaceMarker(index, { ...m, ...s })} />
          </div>
        </>
      )}
      <Row>
        <Button variant="secondary" size="icon-lg" aria-label="Nudge earlier" disabled={index === 0} onClick={() => nudge(-1)}><ChevronLeft /></Button>
        <Button variant="secondary" size="icon-lg" aria-label="Nudge later" disabled={index === 0} onClick={() => nudge(1)}><ChevronRight /></Button>
        {m.kind === "manual" && <Button variant="secondary" size="icon-lg" aria-label="Detected tempo" disabled={!analysis} onClick={() => applyDetectedTempo(index)}><Sparkles /></Button>}
      </Row>
    </ResponsivePanel>
  )
}

/** "2/5" for the marker being edited; "–/5" while the playhead is before the first marker the user placed; nothing without markers. */
function MarkerCount({ markers, index }: { markers: TempoMarker[]; index: number }) {
  const n = markerNumber(markers, index)
  if (!visibleMarkerCount(markers)) return null
  return <span className="min-w-8 text-center text-xs text-muted-foreground tabular-nums">{n ? n : "–"}/{visibleMarkerCount(markers)}</span>
}

/** Where a marker sits, to the millisecond: "1:04.250". */
const markerClock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`

const Row = ({ children }: { children: ReactNode }) => <div className="flex items-center justify-center gap-1.5">{children}</div>
