"""Request validation for the `spawn` endpoint (pure Python, no Modal needed)."""
import re
import uuid

MODELS = ("htdemucs", "scnet_xl_ihf")
REQUIRED = (
    "job_id", "attempt", "user_id", "song_id", "original_key",
    "model", "callback_url", "callback_token", "max_duration_s",
)
_HEX = re.compile(r"^[0-9a-f]+$")
_CALL_ID = re.compile(r"^fc-[0-9A-Za-z]{1,64}$")


class RequestError(ValueError):
    pass


def _uuid(body, key):
    v = body.get(key)
    if not isinstance(v, str):
        raise RequestError(f"{key} must be a string uuid")
    try:
        if str(uuid.UUID(v)) != v:
            raise ValueError
    except ValueError:
        raise RequestError(f"{key} must be a lowercase hyphenated uuid") from None
    return v


def validate_request(body) -> dict:
    """Return a cleaned job dict or raise RequestError."""
    if not isinstance(body, dict):
        raise RequestError("body must be a JSON object")
    missing = [k for k in REQUIRED if k not in body]
    if missing:
        raise RequestError("missing fields: " + ", ".join(missing))
    job = {k: body[k] for k in REQUIRED}
    for k in ("job_id", "user_id", "song_id"):
        _uuid(job, k)
    a = job["attempt"]
    if isinstance(a, bool) or not isinstance(a, int) or a < 1:
        raise RequestError("attempt must be an integer >= 1")
    if job["model"] not in MODELS:
        raise RequestError("model must be one of " + ", ".join(MODELS))
    m = job["max_duration_s"]
    if isinstance(m, bool) or not isinstance(m, (int, float)) or m <= 0 or m > 7200:
        raise RequestError("max_duration_s must be a number in (0, 7200]")
    key = job["original_key"]
    prefix = f"users/{job['user_id']}/songs/{job['song_id']}/original."
    if not isinstance(key, str) or not key.startswith(prefix) or ".." in key or len(key) > 300:
        raise RequestError("original_key must be users/{user_id}/songs/{song_id}/original.{ext}")
    url = job["callback_url"]
    if not isinstance(url, str) or not re.match(r"^https?://[^\s]+$", url):
        raise RequestError("callback_url must be an http(s) url")
    tok = job["callback_token"]
    if not isinstance(tok, str) or not tok or not _HEX.match(tok):
        raise RequestError("callback_token must be a hex string")
    return job


def validate_call_id(body) -> str:
    """Return the `call_id` of a cancel request or raise RequestError."""
    v = body.get("call_id") if isinstance(body, dict) else None
    if not isinstance(v, str) or not _CALL_ID.match(v):
        raise RequestError("call_id must be a Modal function call id (fc-...)")
    return v


def check_bearer(header: str | None, secret: str | None) -> bool:
    import hmac
    if not secret or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].encode(), secret.encode())
