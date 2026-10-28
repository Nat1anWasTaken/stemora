import { useState, type ReactElement, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useIsDesktop } from "@/hooks/use-media"

export type MenuEntry =
  | { key: string; label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean; hint?: string }
  | { key: string; separator: true }

/** Dropdown menu on desktop, bottom drawer on touch/mobile (Base UI Menu / Drawer). */
export function ActionMenu({ title, trigger, entries, align = "end" }: { title: string; trigger: ReactElement; entries: MenuEntry[]; align?: "start" | "end" }) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)

  if (desktop) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align={align}>
          {entries.map((e) =>
            "separator" in e ? (
              <DropdownMenuSeparator key={e.key} />
            ) : (
              <DropdownMenuItem key={e.key} variant={e.destructive ? "destructive" : "default"} disabled={e.disabled} onClick={e.onSelect}>
                {e.icon}
                {e.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
      <DrawerTrigger render={trigger} />
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-1 px-3 pb-safe">
          {entries.map((e) =>
            "separator" in e ? (
              <div key={e.key} className="my-1 h-px bg-border" />
            ) : (
              <Button
                key={e.key}
                variant={e.destructive ? "destructive" : "ghost"}
                size="lg"
                disabled={e.disabled}
                className="justify-start"
                onClick={() => {
                  setOpen(false)
                  e.onSelect()
                }}
              >
                {e.icon}
                {e.label}
              </Button>
            ),
          )}
        </div>
        <div className="h-3" />
      </DrawerContent>
    </Drawer>
  )
}
