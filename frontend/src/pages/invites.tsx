import { useState } from "react"
import { Navigate } from "react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Clock, Copy, Link2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, type Invite, type InviteSummary } from "@/lib/api"
import { keys, useMe } from "@/lib/queries"

export function InvitesPage() {
  const me = useMe()
  const qc = useQueryClient()
  // The link is only returned at creation (tokens are stored hashed), so keep the latest one on screen.
  const [fresh, setFresh] = useState<Invite | null>(null)
  const list = useQuery({ queryKey: keys.invites, queryFn: api.listInvites, enabled: me.data?.role === "admin" })
  const create = useMutation({
    mutationFn: api.createInvite,
    onSuccess: async (inv) => {
      setFresh(inv)
      void qc.invalidateQueries({ queryKey: keys.invites })
      await copy(inv.url)
    },
    onError: (e) => toast.error(e.message),
  })
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Invite link copied")
    } catch {
      toast.message("Copy this link", { description: text })
    }
  }
  if (me.data && me.data.role !== "admin") return <Navigate to="/" replace />
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Invites</h1>
          <p className="text-muted-foreground">Share a link so someone can create an account.</p>
        </div>
        <Button size="lg" onClick={() => create.mutate()} disabled={create.isPending}><Plus />New invite</Button>
      </header>
      {fresh && (
        <div className="surface-soft flex items-center gap-3 rounded-2xl border border-primary/40 p-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary"><Link2 /></span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{fresh.url}</span>
            <span className="text-xs text-muted-foreground">New link · copy it now, it won't be shown again</span>
          </div>
          <Button variant="ghost" size="icon-lg" aria-label="Copy invite link" onClick={() => void copy(fresh.url)}><Copy /></Button>
        </div>
      )}
      {list.data?.length === 0 && <p className="rounded-2xl border border-dashed border-border p-8 text-center text-muted-foreground">No invites yet.</p>}
      <ul className="flex flex-col gap-3">
        {list.data?.map((inv) => <InviteRow key={inv.id} inv={inv} />)}
      </ul>
    </div>
  )
}

const STATUS = {
  pending: { icon: Clock, label: (i: InviteSummary) => `Unused · expires ${new Date(i.expires_at).toLocaleDateString()}` },
  used: { icon: Check, label: (i: InviteSummary) => `Used by ${i.used_by_email ?? "a deleted account"}` },
  expired: { icon: X, label: (i: InviteSummary) => `Expired ${new Date(i.expires_at).toLocaleDateString()}` },
} as const

function InviteRow({ inv }: { inv: InviteSummary }) {
  const { icon: Icon, label } = STATUS[inv.status]
  return (
    <li className="surface-soft flex items-center gap-3 rounded-2xl border border-border p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><Icon /></span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">Invite created {new Date(inv.created_at).toLocaleDateString()}</span>
        <span className="truncate text-xs text-muted-foreground">{label(inv)}</span>
      </div>
    </li>
  )
}
