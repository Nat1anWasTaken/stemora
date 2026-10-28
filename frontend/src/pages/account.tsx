import { useState, type ComponentProps, type FormEvent, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Download, Loader2, LogOut, Share } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"
import { promptInstall, useInstallState } from "@/lib/install"
import { keys, useMe } from "@/lib/queries"

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="surface-soft flex flex-col gap-5 rounded-2xl border border-border p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

function Field({ id, label, hint, ...input }: { id: string; label: string; hint?: string } & ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} required className="h-11" {...input} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function useUpdateMe(onDone: () => void, success: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.updateMe,
    onSuccess: (user) => {
      qc.setQueryData(keys.me, user)
      toast.success(success)
      onDone()
    },
  })
}

function EmailForm({ current }: { current: string }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const m = useUpdateMe(() => {
    setEmail("")
    setPassword("")
  }, "Email updated")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate({ current_password: password, email: email.trim() })
  }
  return (
    <Section title="Email" description={`You sign in as ${current}.`}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="new-email" label="New email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="email-current-password" label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {m.error && <p role="alert" className="text-sm text-destructive">{m.error.message}</p>}
        <Button type="submit" size="lg" className="self-start" disabled={m.isPending}>
          {m.isPending && <Loader2 className="animate-spin" />}
          Change email
        </Button>
      </form>
    </Section>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [mismatch, setMismatch] = useState(false)
  const m = useUpdateMe(() => {
    setCurrent("")
    setNext("")
    setConfirm("")
  }, "Password changed. Other devices were signed out.")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (next !== confirm) return setMismatch(true)
    setMismatch(false)
    m.mutate({ current_password: current, new_password: next })
  }
  const error = mismatch ? "New passwords don't match." : m.error?.message
  return (
    <Section title="Password" description="Changing your password signs out your other devices.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="current-password" label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field id="new-password" label="New password" type="password" autoComplete="new-password" minLength={8} hint="At least 8 characters." value={next} onChange={(e) => setNext(e.target.value)} />
        <Field id="confirm-password" label="Confirm new password" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="self-start" disabled={m.isPending}>
          {m.isPending && <Loader2 className="animate-spin" />}
          Change password
        </Button>
      </form>
    </Section>
  )
}

function InstallSection() {
  const state = useInstallState()
  if (state === "installed" || state === "unavailable") return null
  return (
    <Section title="Install app" description="Add Stemora to your home screen for a full-screen player and lock-screen controls.">
      {state === "prompt" ? (
        <Button size="lg" className="self-start" onClick={() => void promptInstall()}><Download />Install Stemora</Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          In Safari, tap <Share className="inline size-4 align-text-bottom" /> Share, then <span className="font-medium text-foreground">Add to Home Screen</span>.
        </p>
      )}
    </Section>
  )
}

export function AccountPage() {
  const me = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const logout = async () => {
    await api.logout().catch(() => {})
    qc.clear()
    qc.setQueryData(keys.me, null)
    nav("/login", { replace: true })
  }
  if (!me.data) return null
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-page md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">Account</h1>
          <p className="text-muted-foreground">{me.data.role === "admin" ? "Administrator" : "Member"}</p>
        </div>
        <Button variant="secondary" size="lg" onClick={() => void logout()}><LogOut />Sign out</Button>
      </header>
      <EmailForm current={me.data.email} />
      <PasswordForm />
      <InstallSection />
    </div>
  )
}
