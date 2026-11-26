import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"

/** The app's one query client, also used outside React (Up Next fetches the songs it plays next). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
})
