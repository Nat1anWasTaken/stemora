"""Webhook payload building + delivery + heartbeat reporter."""
import threading
import time

import requests

STAGES = ("downloading", "validating", "separating", "encoding", "analyzing", "uploading", "done")
BACKOFF_S = (1.0, 3.0)  # sleeps between the 3 attempts


def build_payload(status, stage, progress, *, error=None, retryable=None,
                  duration_s=None, stems=None, peaks_key=None, analysis_key=None) -> dict:
    assert status in ("running", "done", "failed")
    assert stage in STAGES
    p = {"status": status, "stage": stage, "progress": int(max(0, min(100, round(progress))))}
    if status == "failed":
        p["error"] = str(error or "unknown error")[:1000]
        p["retryable"] = bool(retryable)
    if status == "done":
        p["duration_s"] = round(float(duration_s), 3)
        p["stems"] = stems
        p["peaks_key"] = peaks_key
    if analysis_key is not None:
        p["analysis_key"] = analysis_key
    return p


class Cancelled(Exception):
    """The backend no longer wants this attempt (song deleted, attempt superseded, job finished)."""


OK, CANCEL, GONE, ERROR = "ok", "cancel", "gone", "error"


def _wants_cancel(r) -> bool:
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        return False
    return isinstance(body, dict) and body.get("cancel") is True


def post_with_retry(url, token, payload, *, attempts=3, backoff=BACKOFF_S,
                    post=requests.post, sleep=time.sleep, timeout=15) -> str:
    """Returns OK, CANCEL (2xx with `cancel: true`: attempt superseded or job finished),
    GONE (410: the song was deleted) or ERROR."""
    for i in range(attempts):
        try:
            r = post(url, json=payload, headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
            if r.status_code < 300:
                return CANCEL if _wants_cancel(r) else OK
            if r.status_code == 410:
                return GONE
            # 4xx other than 408/429 will not get better by retrying
            if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                print(f"webhook rejected: HTTP {r.status_code}")
                return ERROR
            print(f"webhook HTTP {r.status_code} (attempt {i + 1})")
        except Exception as e:  # noqa: BLE001
            print(f"webhook error (attempt {i + 1}): {type(e).__name__}: {e}")
        if i < attempts - 1:
            sleep(backoff[min(i, len(backoff) - 1)])
    return ERROR


class Reporter:
    """Sends status updates; a background thread re-sends the latest running
    state every `heartbeat_s` so the backend sees a heartbeat while we separate.
    When the backend answers CANCEL or GONE, `cancelled` is set and `check()`
    raises `Cancelled` so the job stops before writing to R2; `gone` is also set
    for GONE, meaning anything this run uploaded is orphaned."""

    def __init__(self, url, token, heartbeat_s=15.0, post=post_with_retry):
        self.url, self.token, self.heartbeat_s, self._post = url, token, heartbeat_s, post
        self._lock = threading.Lock()
        self._stage, self._progress = "downloading", 0
        self._stop = threading.Event()
        self.cancelled = threading.Event()
        self.gone = threading.Event()
        self._thread = None
        self._last_sent = 0.0

    def _send(self, payload):
        self._last_sent = time.monotonic()
        result = self._post(self.url, self.token, payload)
        if result in (CANCEL, GONE):
            if result == GONE:
                self.gone.set()
            if not self.cancelled.is_set():
                print(f"backend cancelled the job ({result}); stopping")
                self.cancelled.set()
                self._stop.set()
        return result

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled()

    def update(self, stage, progress):
        with self._lock:
            self._stage = stage
            self._progress = max(self._progress, progress)  # monotonic
            payload = build_payload("running", self._stage, self._progress)
        self._send(payload)

    def set_progress(self, progress):
        """Cheap in-memory update (picked up by the heartbeat thread)."""
        with self._lock:
            self._progress = max(self._progress, progress)

    def start_heartbeat(self):
        def loop():
            while not self._stop.wait(self.heartbeat_s):
                with self._lock:
                    payload = build_payload("running", self._stage, self._progress)
                self._send(payload)
        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop_heartbeat(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def done(self, duration_s, stems, peaks_key, analysis_key=None):
        self.stop_heartbeat()
        return self._send(build_payload("done", "done", 100, duration_s=duration_s,
                                        stems=stems, peaks_key=peaks_key, analysis_key=analysis_key))

    def failed(self, error, retryable):
        self.stop_heartbeat()
        if self.cancelled.is_set():
            return GONE if self.gone.is_set() else CANCEL
        with self._lock:
            stage, prog = self._stage, self._progress
        return self._send(build_payload("failed", stage, prog, error=error, retryable=retryable))
