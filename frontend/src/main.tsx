import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import "./index.css"
import { PwaManager } from "@/components/app/pwa"
import { CommandPalette } from "@/components/app/command-palette"
import { AppErrorBoundary } from "@/components/app/error-boundary"
import { NavDirection } from "@/components/app/page-transition"
import { AppShell, RequireAuth } from "@/components/app/shell"
import { Toaster } from "@/components/ui/sonner"
import { queryClient } from "@/lib/query-client"
import { AccountPage } from "@/pages/account"
import { BootstrapPage, InvitePage, LoginPage } from "@/pages/auth"
import { InvitesPage } from "@/pages/invites"
import { LibraryPage } from "@/pages/library"
import { ProcessingPage } from "@/pages/processing"
import { SetlistPage } from "@/pages/setlists"
import { SongPage } from "@/pages/song"
import { StagePage } from "@/pages/stage"
import { UploadPage } from "@/pages/upload"


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <BrowserRouter>
          <NavDirection />
          <CommandPalette />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/bootstrap" element={<BootstrapPage />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route element={<RequireAuth />}>
              <Route path="/songs/:id" element={<SongPage />} />
              <Route path="/setlists/:id/stage" element={<StagePage />} />
              <Route element={<AppShell />}>
                <Route index element={<LibraryPage />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/processing" element={<ProcessingPage />} />
                <Route path="/setlists/:id" element={<SetlistPage />} />
                <Route path="/queue" element={<Navigate to="/processing" replace />} />
                <Route path="/admin/invites" element={<InvitesPage />} />
                <Route path="/account" element={<AccountPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AppErrorBoundary>
      <Toaster />
      <PwaManager />
    </QueryClientProvider>
  </StrictMode>,
)
