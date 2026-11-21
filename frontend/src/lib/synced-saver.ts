/** Wait this long after the last change before saving, so a burst of changes becomes one request. */
const SAVE_DELAY = 300

/**
 * Saves one value behind the UI: debounced, whole value at a time, never more than one request in flight (a newer
 * state goes out once the current request ends, so an older response can never overwrite it). `show` puts a state
 * on screen; a failed save shows what the server last confirmed again.
 */
export function createSyncedSaver<T>(opts: {
  initial: T
  same: (a: T, b: T) => boolean
  /** Sends a state; resolves with the server's (normalised) answer. */
  save: (value: T) => Promise<T>
  /** The request body for a keepalive save while the page goes away. */
  beacon: { url: string; body: (value: T) => unknown }
  onError: (e: unknown) => void
}) {
  let latest = opts.initial
  let confirmed = opts.initial
  let inFlight = false
  let timer = 0
  let show: (value: T) => void = () => {}
  const saver = {
    /** Where saved or rolled-back states are shown. */
    listen(fn: (value: T) => void) {
      show = fn
    },
    flush() {
      clearTimeout(timer)
      if (inFlight || opts.same(latest, confirmed)) return
      const sent = latest
      inFlight = true
      opts
        .save(sent)
        .then((r) => {
          confirmed = r
          // The server normalises; adopt its answer unless the user changed something meanwhile.
          if (opts.same(latest, sent) && !opts.same(r, sent)) {
            latest = r
            show(r)
          }
        })
        .catch((e: unknown) => {
          opts.onError(e)
          latest = confirmed
          show(confirmed)
        })
        .finally(() => {
          inFlight = false
          if (!opts.same(latest, confirmed)) saver.flush()
        })
    },
    /** A new state is on screen: save it shortly. */
    set(value: T) {
      if (opts.same(value, latest)) return
      latest = value
      clearTimeout(timer)
      timer = window.setTimeout(saver.flush, SAVE_DELAY)
    },
    get value() {
      return latest
    },
    /** The server already holds `value` (saved some other way): adopt it without sending. */
    reset(value: T) {
      clearTimeout(timer)
      latest = value
      confirmed = value
    },
    /** Page going away: a normal request may be cut off, so send the unsaved state with keepalive. */
    beacon() {
      clearTimeout(timer)
      // A save in flight may still land a different state, so send the latest one anyway.
      if (!inFlight && opts.same(latest, confirmed)) return
      void fetch(opts.beacon.url, {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts.beacon.body(latest)),
      }).catch(() => {})
    },
  }
  return saver
}
