import { useLayoutEffect, useRef, ViewTransition, type ReactNode } from "react"
import { useLocation, useNavigationType } from "react-router"

// iOS edge-swipe back (and similar) already animates the page; don't animate it a second time.
let uaTransition = false
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (e) => {
    uaTransition = (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true
  })
}

/**
 * Tells the page transition CSS (index.css, `html[data-nav]`) whether to animate the current navigation.
 * Shell pages are bottom-nav tabs and fade through (like a native tab bar); "none" when the player sheet is
 * involved (it slides on its own) or the browser already animated a back swipe.
 * Runs in a layout effect so the attribute is set before the view transition snapshots are styled.
 */
export function NavDirection() {
  const { pathname } = useLocation()
  const type = useNavigationType()
  const prev = useRef(pathname)
  useLayoutEffect(() => {
    const from = prev.current
    prev.current = pathname
    if (from === pathname) return
    const sheet = from.startsWith("/songs/") || pathname.startsWith("/songs/")
    document.documentElement.dataset.nav = sheet || (type === "POP" && uaTransition) ? "none" : "tab"
    if (type !== "POP") uaTransition = false
  }, [pathname, type])
  return null
}

/** Animates routed content when the location changes (router updates run in transitions, so React starts a view transition). */
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <ViewTransition key={pathname} enter="page-enter" exit="page-exit" default="none">
      <div>{children}</div>
    </ViewTransition>
  )
}
