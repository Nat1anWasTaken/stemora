import type { ReactElement } from "react"
import { ArrowDown, ArrowUp, AudioLines, ListX, MoreHorizontal, Play, SkipBack, SkipForward, X } from "lucide-react"
import { ActionMenu } from "@/components/app/action-menu"
import { PanelHeadline } from "@/components/app/panel-parts"
import { ResponsivePanel } from "@/components/app/responsive-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { transitionAfter, upNext, useUpNext, type UpNextItem } from "@/player/up-next"

function Row({ item, i }: { item: UpNextItem; i: number }) {
  const { index, items, setlist } = useUpNext()
  const current = i === index
  const after = transitionAfter(items, i, setlist)
  const last = i === items.length - 1
  return (
    <li className={cn("flex items-center gap-1 rounded-xl", current && "bg-primary/10")}>
      <button type="button" onClick={() => !current && upNext.jump(item.key)} aria-current={current || undefined} className="pressable flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left">
        <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{current ? <AudioLines className="mx-auto size-4 text-primary" /> : i + 1}</span>
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate text-sm font-medium", current && "text-primary", i < index && "text-muted-foreground")}>{item.title}</span>
          {setlist && !last && <span className="text-xs text-muted-foreground">{after === "continue" ? "Then plays on" : "Then waits"}</span>}
        </span>
      </button>
      <ActionMenu
        title={item.title}
        entries={[
          ...(current ? [] : [{ key: "play", label: "Play now", icon: <Play />, onSelect: () => upNext.jump(item.key) }]),
          { key: "up", label: "Move up", icon: <ArrowUp />, disabled: i === 0, onSelect: () => upNext.move(item.key, -1) },
          { key: "down", label: "Move down", icon: <ArrowDown />, disabled: last, onSelect: () => upNext.move(item.key, 1) },
          ...(current ? [] : [{ key: "sep", separator: true as const }, { key: "remove", label: "Remove from Up Next", icon: <X />, destructive: true, onSelect: () => upNext.remove(item.key) }]),
        ]}
        trigger={<Button variant="ghost" size="icon" aria-label={`Options for ${item.title}`}><MoreHorizontal /></Button>}
      />
    </li>
  )
}

/** What plays on this device, the current song included: jump, reorder, remove; previous/next. */
export function UpNextPanel({ trigger }: { trigger: ReactElement }) {
  const { items, index, setlist } = useUpNext()
  const after = Math.max(0, items.length - index - 1)
  return (
    <ResponsivePanel title="Up next" size="wide" trigger={trigger}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-lg" aria-label="Previous song" onClick={upNext.previous}><SkipBack /></Button>
        <PanelHeadline title={setlist ? setlist.name : items.length > 0 ? `Song ${index + 1} of ${items.length}` : "Nothing playing"} detail={after === 0 ? "Nothing after this song" : `${after} ${after === 1 ? "song" : "songs"} after this one`} />
        <Button variant="ghost" size="icon-lg" aria-label="Next song" disabled={after === 0} onClick={upNext.next}><SkipForward /></Button>
      </div>
      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Add songs with Play next or Add to Up Next in the Library, or play a setlist.</p>
      ) : (
        <ol className="-mx-1 flex max-h-96 flex-col gap-0.5 overflow-y-auto overscroll-contain">
          {items.map((it, i) => <Row key={it.key} item={it} i={i} />)}
        </ol>
      )}
      {items.length > 1 && (
        <Button variant="secondary" onClick={upNext.clear}><ListX />{setlist ? "Clear and leave the setlist" : "Clear Up Next"}</Button>
      )}
    </ResponsivePanel>
  )
}
