import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={props.destructive ? "destructive" : "default"}
            onClick={() => {
              props.onOpenChange(false)
              props.onConfirm()
            }}
          >
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Asks for one line of text: a song's name by default; `heading`, `description`, `label` and `submit` reword it (setlist names, notes). */
export function RenameDialog(props: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  onRename: (t: string) => void
  heading?: string
  description?: string
  label?: string
  submit?: string
  maxLength?: number
  /** Whether an empty value may be saved (clearing notes). */
  allowEmpty?: boolean
}) {
  const [value, setValue] = useState(props.title)
  return (
    <Dialog open={props.open} onOpenChange={(o) => { if (o) setValue(props.title); props.onOpenChange(o) }}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const t = value.trim()
            if (t || props.allowEmpty) {
              props.onRename(t)
              props.onOpenChange(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.heading ?? "Rename song"}</DialogTitle>
            <DialogDescription>{props.description ?? "Only changes the name shown in your library."}</DialogDescription>
          </DialogHeader>
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={props.maxLength ?? 200} aria-label={props.label ?? "Song title"} />
          <DialogFooter>
            <Button type="submit" disabled={!value.trim() && !props.allowEmpty}>{props.submit ?? "Save name"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
