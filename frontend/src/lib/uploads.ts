import { useSyncExternalStore } from "react"
import type { Model } from "@/lib/api"
import { UploadController, type UploadState } from "@/lib/upload"

/**
 * File uploads started in this tab. Only the byte transfer is tied to this device: once
 * `/complete` succeeds the song is in the server-side queue (visible everywhere) and the upload
 * drops out of this list. Kept outside React so uploads keep going while you navigate.
 */
export type LocalUpload = { id: string; title: string; fileName: string; size: number; ctrl: UploadController }

let items: LocalUpload[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const isTransferring = (s: UploadState) => s.phase === "creating" || s.phase === "uploading" || s.phase === "completing"

function warnBeforeLeaving(e: BeforeUnloadEvent) {
  if (items.some((u) => isTransferring(u.ctrl.state))) e.preventDefault()
}

export const uploads = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  list: () => items,

  /** Start uploading; `onStored` runs when a song has reached the server's queue. */
  start(files: { file: File; title: string }[], model: Model, onStored: () => void) {
    if (items.length === 0) window.addEventListener("beforeunload", warnBeforeLeaving)
    const added = files.map(({ file, title }) => {
      const ctrl = new UploadController(file, title, model)
      const item: LocalUpload = { id: crypto.randomUUID(), title, fileName: file.name, size: file.size, ctrl }
      let phase = ctrl.state.phase
      ctrl.subscribe(() => {
        if (ctrl.state.phase === phase) return
        phase = ctrl.state.phase
        if (phase === "done") {
          uploads.remove(item.id)
          onStored()
        } else {
          // A new snapshot so list readers see the phase change; rows follow progress themselves.
          items = [...items]
          emit()
        }
      })
      return item
    })
    items = [...items, ...added]
    emit()
    added.forEach((u) => void u.ctrl.start())
  },

  retry: (id: string) => void items.find((u) => u.id === id)?.ctrl.retry(),

  /** Stop (if still running) and forget an upload. */
  remove(id: string) {
    items.find((u) => u.id === id)?.ctrl.cancel()
    items = items.filter((u) => u.id !== id)
    if (items.length === 0) window.removeEventListener("beforeunload", warnBeforeLeaving)
    emit()
  },

  /** Signing out: stop everything. */
  reset() {
    items.forEach((u) => u.ctrl.cancel())
    items = []
    window.removeEventListener("beforeunload", warnBeforeLeaving)
    emit()
  },
}

/** Uploads in this tab; re-renders when one is added, removed or changes phase (not on progress). */
export function useUploads(): LocalUpload[] {
  return useSyncExternalStore(uploads.subscribe, uploads.list)
}
