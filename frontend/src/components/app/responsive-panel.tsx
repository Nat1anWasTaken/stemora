import { useState, type ReactElement, type ReactNode } from "react"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useIsDesktop } from "@/hooks/use-media"

/**
 * A panel of controls: popover on desktop, bottom drawer on touch/mobile, with a centred title and an optional control on the right.
 * Use this (or ActionMenu for a list of actions) instead of Popover/Drawer directly so phones always get a sheet; lint enforces it.
 */
export function ResponsivePanel({ title, action, trigger, size = "default", children }: {
  title: string
  action?: ReactNode
  trigger: ReactElement
  /** Popover width on desktop; the drawer is always full width. */
  size?: "default" | "wide"
  children: ReactNode
}) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)
  const header = (Title: typeof DrawerTitle | typeof PopoverTitle) => (
    <div className="relative flex min-h-9 items-center justify-center">
      <Title className="text-lg font-semibold">{title}</Title>
      {action && <div className="absolute right-0">{action}</div>}
    </div>
  )

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={trigger} />
        <PopoverContent size={size}>
          <div className="flex flex-col gap-4 p-1">
            {header(PopoverTitle)}
            {children}
          </div>
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
      <DrawerTrigger render={trigger} />
      <DrawerContent>
        <div className="flex flex-col gap-4 px-5 pt-3 pb-safe">
          {header(DrawerTitle)}
          {children}
          <div className="h-2" />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
