import numpy as np
import pytest

import pipeline as P
import schema
import webhook as W

U, S, J = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
           "33333333-3333-4333-8333-333333333333")


def body(**kw):
    b = {"job_id": J, "attempt": 1, "user_id": U, "song_id": S,
         "original_key": f"users/{U}/songs/{S}/original.mp3", "model": "htdemucs",
         "callback_url": "https://h/api/webhooks/jobs/" + J, "callback_token": "ab12", "max_duration_s": 900}
    b.update(kw)
    return b


def test_validate_ok():
    assert schema.validate_request(body())["model"] == "htdemucs"


@pytest.mark.parametrize("kw", [
    {"model": "nope"}, {"attempt": 0}, {"attempt": True}, {"job_id": "X"},
    {"original_key": "users/other/songs/x/original.mp3"}, {"original_key": f"users/{U}/songs/{S}/../x/original.mp3"},
    {"callback_url": "ftp://x"}, {"callback_token": "zz"}, {"max_duration_s": 0}, {"max_duration_s": "9"},
])
def test_validate_bad(kw):
    with pytest.raises(schema.RequestError):
        schema.validate_request(body(**kw))


def test_validate_missing_and_nonobject():
    b = body(); del b["model"]
    with pytest.raises(schema.RequestError):
        schema.validate_request(b)
    with pytest.raises(schema.RequestError):
        schema.validate_request([1])


def test_bearer():
    assert schema.check_bearer("Bearer s3", "s3")
    assert not schema.check_bearer("Bearer x", "s3")
    assert not schema.check_bearer(None, "s3")
    assert not schema.check_bearer("Bearer ", "")


def test_payloads():
    r = W.build_payload("running", "separating", 42.4)
    assert r == {"status": "running", "stage": "separating", "progress": 42}
    f = W.build_payload("failed", "validating", 4, error="bad", retryable=False)
    assert f["retryable"] is False and f["error"] == "bad" and "stems" not in f
    d = W.build_payload("done", "done", 100, duration_s=12.34567, stems=[], peaks_key="k")
    assert d["duration_s"] == 12.346 and d["peaks_key"] == "k" and "error" not in d
    assert W.build_payload("running", "uploading", 250)["progress"] == 100


def test_post_retry():
    calls = []

    class R:
        def __init__(s, c): s.status_code = c

    seq = iter([500, Exception("net"), 200])

    def post(*a, **k):
        calls.append(1)
        v = next(seq)
        if isinstance(v, Exception):
            raise v
        return R(v)

    slept = []
    assert W.post_with_retry("u", "t", {}, post=post, sleep=slept.append)
    assert len(calls) == 3 and slept == [1.0, 3.0]
    assert not W.post_with_retry("u", "t", {}, post=lambda *a, **k: R(500), sleep=lambda s: None)
    n = []
    assert not W.post_with_retry("u", "t", {}, post=lambda *a, **k: (n.append(1), R(401))[1], sleep=lambda s: None)
    assert len(n) == 1


def test_peaks():
    sr = P.SR
    t = np.zeros((2, sr * 2 + 100), dtype=np.float32)   # 2.00227s -> 41 buckets
    t[0, 0] = 0.5
    t[1, sr] = -0.25
    pk = P.compute_peaks({"vocals": t, "drums": np.zeros_like(t)})
    assert pk["version"] == 1 and pk["samples_per_second"] == 20
    v = pk["stems"]["vocals"]
    assert len(v) == 41 and v[0] == 1.0 and v[20] == 0.5
    assert all(0 <= x <= 1 for x in v)
    assert set(pk["stems"]["drums"]) == {0.0}


def test_normalise():
    a = np.array([[2.0, np.nan, -1.0]], dtype=np.float32)
    b = np.array([[0.5, 0.5, 0.5]], dtype=np.float32)
    out = P.normalise({"a": a, "b": b})
    assert np.abs(out["a"]).max() <= 0.99 + 1e-6
    assert out["b"][0, 0] == pytest.approx(0.2475)  # common gain preserved
    quiet = P.normalise({"a": b})
    assert np.allclose(quiet["a"], b)


def test_reporter_monotonic():
    sent = []
    r = W.Reporter("u", "t", post=lambda u, t, p: sent.append(p) or True)
    r.update("separating", 50)
    r.update("separating", 30)
    assert sent[-1]["progress"] == 50
