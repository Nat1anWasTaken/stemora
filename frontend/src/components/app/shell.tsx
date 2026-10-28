import { Library, LogOut, Plus, RotateCw, UserRound, Users, WifiOff } from "lucide-react"
import { NavLink, Navigate, Outlet, useNavigate } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Logo } from "@/components/app/logo"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { api } from "@/lib/api"
import { formatBytes } from "@/lib/format"
import { keys, useMe, useUsage } from "@/lib/queries"
import { cn } from "@/lib/utils"

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn("flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors", isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")

function UsageMeter() {
  const { data } = useUsage()
  if (!data) return null
  const pct = Math.min(100, Math.round((data.used_bytes / Math.max(1, data.quota_bytes)) * 100))
  return (
    <Progress value={pct} aria-label="Storage used">
      <div className="flex w-full justify-between text-xs text-muted-foreground">
        <span>Storage</span>
        <span>{formatBytes(data.used_bytes)} of {formatBytes(data.quota_bytes)}</span>
      </div>
    </Progress>
  )
}

export function RequireAuth() {
  const me = useMe()
  if (me.isLoading) return <div className="grid min-h-app place-items-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
  // A network failure (e.g. the installed app opened offline) is not a signed-out user.
  if (me.isError)
    return (
      <div className="flex min-h-app flex-col items-center justify-center gap-4 px-6 pt-safe pb-safe text-center">
        <WifiOff className="size-10 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Can't reach Stemora</h1>
          <p className="text-sm text-muted-foreground">{navigator.onLine ? "The server isn't responding." : "You're offline."} Check your connection and try again.</p>
        </div>
        <Button variant="secondary" size="lg" onClick={() => void me.refetch()} disabled={me.isFetching}>
          {me.isFetching ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Try again
        </Button>
      </div>
    )
  if (!me.data) return <Navigate to="/login" replace />
  return <Outlet />
}

export function AppShell() {
  const me = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const admin = me.data?.role === "admin"
  const logout = async () => {
    await api.logout().catch(() => {})
    qc.clear()
    qc.setQueryData(keys.me, null)
    nav("/login", { replace: true })
  }
  return (
    <div className="min-h-app md:flex">
      <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-4 md:sticky md:top-0 md:flex md:h-app">
        <Logo className="px-2 pt-2" />
        <Button size="lg" render={<NavLink to="/upload" />}><Plus />Upload song</Button>
        <nav className="flex flex-col gap-1" aria-label="Main">
          <NavLink to="/" end className={linkClass}><Library className="size-5" />Library</NavLink>
          {admin && <NavLink to="/admin/invites" className={linkClass}><Users className="size-5" />Invites</NavLink>}
        </nav>
        <div className="mt-auto flex flex-col gap-4">
          <UsageMeter />
          <div className="flex items-center justify-between gap-2">
            <NavLink to="/account" className={(a) => cn(linkClass(a), "min-w-0 flex-1")}>
              <UserRound className="size-5 shrink-0" />
              <span className="truncate">{me.data?.email}</span>
            </NavLink>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out"><LogOut /></Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-nav md:pb-0">
        <Outlet />
      </main>

      <nav className="glass fixed inset-x-4 bottom-nav z-30 mx-auto flex max-w-sm items-center justify-around rounded-full border border-border p-1.5 md:hidden" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => cn("flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium", isActive ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
          <Library className="size-5" />Library
        </NavLink>
        <NavLink to="/upload" className={({ isActive }) => cn("flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium", isActive ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
          <Plus className="size-5" />Upload
        </NavLink>
        {admin && (
          <NavLink to="/admin/invites" className={({ isActive }) => cn("flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium", isActive ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
            <Users className="size-5" />Invites
          </NavLink>
        )}
        <NavLink to="/account" className={({ isActive }) => cn("flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium", isActive ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
          <UserRound className="size-5" />Account
        </NavLink>
      </nav>
    </div>
  )
}
