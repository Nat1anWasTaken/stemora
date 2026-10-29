import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import { defineConfig } from "vitest/config"
import { mockApi } from "./mock/plugin.ts"

const useMock = process.env.VITE_MOCK === "1"

export default defineConfig({
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    react(),
    tailwindcss(),
    // Service worker precaches the app shell so the installed app opens instantly and offline.
    // API calls and presigned stem URLs (they expire after 1h) are never cached.
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: false, // public/manifest.webmanifest is the source of truth
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
        globIgnores: ["mock/**", "splash/**"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/mock/],
        cleanupOutdatedCaches: true,
      },
    }),
    ...(useMock ? [mockApi()] : []),
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  server: {
    host: true,
    proxy: useMock ? undefined : { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
})
