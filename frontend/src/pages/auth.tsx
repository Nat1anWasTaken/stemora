import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/app/logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"
import { keys, useMe } from "@/lib/queries"

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="player-sheet flex min-h-app flex-col items-center justify-center px-4 py-10 pt-safe pb-safe">
      <div className="stagger-children flex w-full max-w-sm flex-col gap-8">
        <Logo />
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

function CredentialsForm(props: { submitLabel: string; pending: boolean; error: string | null; onSubmit: (email: string, password: string) => void; newPassword?: boolean }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    props.onSubmit(email.trim(), password)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete={props.newPassword ? "new-password" : "current-password"} required minLength={props.newPassword ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} className="h-11" />
        {props.newPassword && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
      </div>
      {props.error && <p role="alert" className="text-sm text-destructive">{props.error}</p>}
      <Button type="submit" size="lg" disabled={props.pending}>
        {props.pending && <Loader2 className="animate-spin" />}
        {props.submitLabel}
      </Button>
    </form>
  )
}

function useAuthSuccess() {
  const qc = useQueryClient()
  const nav = useNavigate()
  return (user: Awaited<ReturnType<typeof api.login>>) => {
    qc.setQueryData(keys.me, user)
    nav("/", { replace: true })
  }
}

export function LoginPage() {
  const me = useMe()
  const status = useQuery({ queryKey: keys.status, queryFn: api.authStatus })
  const done = useAuthSuccess()
  const m = useMutation({ mutationFn: (v: { e: string; p: string }) => api.login(v.e, v.p), onSuccess: done })
  if (me.data) return <Navigate to="/" replace />
  if (status.data?.needs_bootstrap) return <Navigate to="/bootstrap" replace />
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your stems.">
      <CredentialsForm submitLabel="Sign in" pending={m.isPending} error={m.error?.message ?? null} onSubmit={(e, p) => m.mutate({ e, p })} />
    </AuthLayout>
  )
}

export function BootstrapPage() {
  const status = useQuery({ queryKey: keys.status, queryFn: api.authStatus })
  const done = useAuthSuccess()
  const m = useMutation({ mutationFn: (v: { e: string; p: string }) => api.bootstrap(v.e, v.p), onSuccess: done })
  if (status.data && !status.data.needs_bootstrap) return <Navigate to="/login" replace />
  return (
    <AuthLayout title="Set up Stemora" subtitle="Create the first account. It becomes the admin and can invite everyone else.">
      <CredentialsForm newPassword submitLabel="Create admin account" pending={m.isPending} error={m.error?.message ?? null} onSubmit={(e, p) => m.mutate({ e, p })} />
    </AuthLayout>
  )
}

export function InvitePage() {
  const { token = "" } = useParams()
  const valid = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteValid(token) })
  const done = useAuthSuccess()
  const m = useMutation({ mutationFn: (v: { e: string; p: string }) => api.acceptInvite(token, v.e, v.p), onSuccess: done })
  useEffect(() => {
    if (m.error) toast.error(m.error.message)
  }, [m.error])
  if (valid.isLoading) return <AuthLayout title="Checking invite" subtitle="One moment."><Loader2 className="animate-spin text-muted-foreground" /></AuthLayout>
  if (!valid.data?.valid) {
    return (
      <AuthLayout title="Invite not valid" subtitle="This invite link has expired or was already used. Ask the admin for a new one.">
        <Button size="lg" variant="secondary" render={<Link to="/login" />}>Go to sign in</Button>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout title="You are invited" subtitle="Choose an email and password to join.">
      <CredentialsForm newPassword submitLabel="Create account" pending={m.isPending} error={m.error?.message ?? null} onSubmit={(e, p) => m.mutate({ e, p })} />
    </AuthLayout>
  )
}
