import { useState, type ReactElement, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useIsDesktop } from "@/hooks/use-media"

/**
 * A panel of controls: popover on desktop, bottom drawer on touch/mobile, with a centred title and an optional control on the right.
 * Use this (or ActionMenu for a list of actions) instead of Popover/Drawer directly so phones always get a sheet; lint enforces it.
 */
export function ResponsivePanel({ title, action, trigger, size = "default", open: openProp, onOpenChange, children }: {
  title: string
  /** Controlled open state (optional), e.g. to close the panel from inside it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  action?: ReactNode
  trigger: ReactElement
  /** Popover width on desktop; the drawer is always full width. */
  size?: "default" | "wide"
  children: ReactNode
}) {
  const desktop = useIsDesktop()
  const [own, setOwn] = useState(false)
  const open = openProp ?? own
  const setOpen = (o: boolean) => {
    setOwn(o)
    onOpenChange?.(o)
  }
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 pt-3">
          <div className="px-5">{header(DrawerTitle)}</div>
          {/* A panel taller than the drawer allows (a long metronome pattern) scrolls under the fixed header. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-safe">
            {children}
            <div className="h-2 shrink-0" />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * A dialog opened by the app rather than a trigger (e.g. once a lookup finishes): centred dialog on desktop, bottom drawer
 * on touch/mobile. The body scrolls between the fixed header and `footer` (the dialog's buttons).
 */
export function ResponsiveDialog({ title, description, open, onOpenChange, footer, children }: {
  title: string
  description?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  footer: ReactNode
  children: ReactNode
}) {
  const desktop = useIsDesktop()
  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4">{children}</div>
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent>
        <div className="flex min-h-0 flex-1 flex-col gap-4 pt-3">
          <div className="flex flex-col gap-1 px-5 text-center">
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-5">{children}</div>
          {/* Buttons are given cancel first (left on desktop); stacked, the main action goes on top. */}
          <div className="shrink-0 border-t border-border px-5 pt-3 pb-safe">
            <div className="flex flex-col-reverse gap-2 pb-3">{footer}</div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
