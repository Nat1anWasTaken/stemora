import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { mockApi } from "./mock/plugin.ts"

const useMock = process.env.VITE_MOCK === "1"

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(useMock ? [mockApi()] : [])],
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  server: {
    host: true,
    proxy: useMock ? undefined : { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
})
