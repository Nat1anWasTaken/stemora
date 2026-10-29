import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./index.css"
import { PwaManager } from "@/components/app/pwa"
import { NavDirection } from "@/components/app/page-transition"
import { AppShell, RequireAuth } from "@/components/app/shell"
import { Toaster } from "@/components/ui/sonner"
import { ApiError } from "@/lib/api"
import { AccountPage } from "@/pages/account"
import { BootstrapPage, InvitePage, LoginPage } from "@/pages/auth"
import { InvitesPage } from "@/pages/invites"
import { LibraryPage } from "@/pages/library"
import { QueuePage } from "@/pages/queue"
import { SongPage } from "@/pages/song"
import { UploadPage } from "@/pages/upload"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NavDirection />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/bootstrap" element={<BootstrapPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route element={<RequireAuth />}>
            <Route path="/songs/:id" element={<SongPage />} />
            <Route element={<AppShell />}>
              <Route index element={<LibraryPage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/admin/invites" element={<InvitesPage />} />
              <Route path="/account" element={<AccountPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
      <PwaManager />
    </QueryClientProvider>
  </StrictMode>,
)
