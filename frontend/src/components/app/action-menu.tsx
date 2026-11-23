import { useState, type ReactElement, type ReactNode } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsDesktop } from "@/hooks/use-media"

export type MenuRadio = {
  /** Group heading; on mobile the radio group is otherwise labelled by the menu title. */
  label?: string
  value: string
  onValueChange: (value: string) => void
  options: readonly { value: string; label: string }[]
}

export type MenuEntry =
  | { key: string; label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean; hint?: string }
  | { key: string; separator: true }
  | { key: string; radio: MenuRadio }
  | MenuCheckbox

/** An on/off option. Toggling it leaves the menu open, so several can be set in one go. */
export type MenuCheckbox = { key: string; label: string; icon?: ReactNode; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean }

/**
 * Dropdown menu on desktop, bottom drawer on touch/mobile (Base UI Menu / Drawer). Entries are actions, separators, on/off
 * checkboxes or a single-choice radio group. `label` adds a heading to the desktop dropdown (the drawer always shows `title`).
 */
export function ActionMenu({ title, label, trigger, entries, align = "end" }: {
  title: string
  label?: string
  trigger: ReactElement
  entries: MenuEntry[]
  align?: "start" | "end"
}) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)

  if (desktop) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align={align}>
          {label && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{label}</DropdownMenuLabel>
            </DropdownMenuGroup>
          )}
          {entries.map((e) =>
            "separator" in e ? (
              <DropdownMenuSeparator key={e.key} />
            ) : "radio" in e ? (
              <DropdownMenuGroup key={e.key}>
                {e.radio.label && <DropdownMenuLabel>{e.radio.label}</DropdownMenuLabel>}
                <DropdownMenuRadioGroup value={e.radio.value} onValueChange={(v) => e.radio.onValueChange(String(v))}>
                  {e.radio.options.map((o) => <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            ) : "checked" in e ? (
              <DropdownMenuCheckboxItem key={e.key} checked={e.checked} disabled={e.disabled} onCheckedChange={e.onCheckedChange}>
                {e.icon}
                {e.label}
              </DropdownMenuCheckboxItem>
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
            ) : "radio" in e ? (
              <div key={e.key} role="radiogroup" aria-label={e.radio.label ?? title} className="flex flex-col gap-1">
                {e.radio.label && <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">{e.radio.label}</p>}
                {e.radio.options.map((o) => {
                  const checked = o.value === e.radio.value
                  return (
                    <Button
                      key={o.value}
                      variant="ghost"
                      size="lg"
                      role="radio"
                      aria-checked={checked}
                      className="justify-start"
                      onClick={() => {
                        setOpen(false)
                        if (!checked) e.radio.onValueChange(o.value)
                      }}
                    >
                      {o.label}
                      {checked && <Check className="ml-auto text-primary" />}
                    </Button>
                  )
                })}
              </div>
            ) : "checked" in e ? (
              <Button
                key={e.key}
                variant="ghost"
                size="lg"
                role="checkbox"
                aria-checked={e.checked}
                disabled={e.disabled}
                className="justify-start"
                onClick={() => e.onCheckedChange(!e.checked)}
              >
                {e.icon}
                {e.label}
                {e.checked && <Check className="ml-auto text-primary" />}
              </Button>
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
