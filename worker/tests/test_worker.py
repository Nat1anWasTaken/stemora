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
    {"model": "nope"}, {"model": "htdemucs_ft"}, {"attempt": 0}, {"attempt": True}, {"job_id": "X"},
    {"original_key": "users/other/songs/x/original.mp3"}, {"original_key": f"users/{U}/songs/{S}/../x/original.mp3"},
    {"callback_url": "ftp://x"}, {"callback_token": "zz"}, {"max_duration_s": 0}, {"max_duration_s": "9"},
])
def test_validate_bad(kw):
    with pytest.raises(schema.RequestError):
        schema.validate_request(body(**kw))


def test_models_are_wired():
    assert set(P.SCNET_MODELS) <= set(schema.MODELS)
    assert set(P.SCNET_SOURCES) == set(P.STEMS)
    for spec in P.SCNET_MODELS.values():
        assert spec["config"]["sources"] == list(P.SCNET_SOURCES) and len(spec["sha256"]) == 64


def test_scnet_overlap_add_reconstructs_the_mix(monkeypatch):
    # A stand-in "model" that hands each source a quarter of its input: if the chunking,
    # padding and cross-fade weights are right, the stems sum back to the mix everywhere.
    torch = pytest.importorskip("torch")

    class Quarter(torch.nn.Module):
        sources = P.SCNET_SOURCES

        def forward(self, x):
            return (x / 4)[:, None].expand(-1, 4, -1, -1)

    monkeypatch.setattr(P, "load_scnet", lambda name: Quarter())
    rng = np.random.default_rng(1)
    prog = []
    for n in (500, 1000, 9001):  # shorter than a chunk, too short to pad, reflect-padded
        wav = rng.standard_normal((2, n)).astype(np.float32)
        out = P._separate_scnet(wav, "scnet_xl_ihf", prog.append, "cpu", chunk=800, batch=3)
        assert set(out) == set(P.STEMS) and out["vocals"].shape == wav.shape
        assert np.allclose(sum(out.values()), wav, atol=1e-5)
        assert prog[-1] == 1.0 and prog == sorted(prog)
        prog.clear()


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


def test_validate_call_id():
    assert schema.validate_call_id({"call_id": "fc-01ABCxyz"}) == "fc-01ABCxyz"
    for bad in ({}, {"call_id": "ap-123"}, {"call_id": "fc-../x"}, {"call_id": 5}, []):
        with pytest.raises(schema.RequestError):
            schema.validate_call_id(bad)


def test_payloads():
    r = W.build_payload("running", "separating", 42.4)
    assert r == {"status": "running", "stage": "separating", "progress": 42}
    f = W.build_payload("failed", "validating", 4, error="bad", retryable=False)
    assert f["retryable"] is False and f["error"] == "bad" and "stems" not in f
    d = W.build_payload("done", "done", 100, duration_s=12.34567, stems=[], peaks_key="k")
    assert d["duration_s"] == 12.346 and d["peaks_key"] == "k" and "error" not in d
    assert W.build_payload("running", "uploading", 250)["progress"] == 100


def test_runner_stages_are_known():
    # An unknown stage trips the assert in build_payload, which also breaks the `failed` webhook.
    import re
    from pathlib import Path
    src = (Path(W.__file__).parent / "runner.py").read_text()
    used = set(re.findall(r'\.update\("([a-z]+)"', src))
    assert used and used <= set(W.STAGES)


def test_post_retry():
    calls = []

    seq = iter([500, Exception("net"), 200])

    def post(*a, **k):
        calls.append(1)
        v = next(seq)
        if isinstance(v, Exception):
            raise v
        return Resp(v)

    slept = []
    assert W.post_with_retry("u", "t", {}, post=post, sleep=slept.append) == W.OK
    assert len(calls) == 3 and slept == [1.0, 3.0]
    assert W.post_with_retry("u", "t", {}, post=lambda *a, **k: Resp(500), sleep=lambda s: None) == W.ERROR
    n = []
    assert W.post_with_retry("u", "t", {}, post=lambda *a, **k: (n.append(1), Resp(401))[1],
                             sleep=lambda s: None) == W.ERROR
    assert len(n) == 1


class Resp:
    def __init__(s, code, body=None):
        s.status_code, s._body = code, body

    def json(s):
        if s._body is None:
            raise ValueError("no json")
        return s._body


@pytest.mark.parametrize("resp,expected", [
    (Resp(200, {"ok": True, "ignored": "stale_attempt", "cancel": True}), W.CANCEL),
    (Resp(410, {"code": "job_gone"}), W.GONE),
    (Resp(200, {"ok": True}), W.OK),
    (Resp(200), W.OK),
])
def test_post_cancel_is_not_retried(resp, expected):
    n = []
    assert W.post_with_retry("u", "t", {}, post=lambda *a, **k: (n.append(1), resp)[1],
                             sleep=lambda s: None) == expected
    assert len(n) == 1


def test_reporter_cancel_and_gone():
    results = iter([W.OK, W.CANCEL])
    sent = []
    r = W.Reporter("u", "t", post=lambda u, t, p: sent.append(p) or next(results))
    r.update("separating", 10)
    r.check()
    r.update("separating", 20)
    assert r.cancelled.is_set() and not r.gone.is_set()
    with pytest.raises(W.Cancelled):
        r.check()
    assert r.failed("boom", retryable=True) == W.CANCEL
    assert len(sent) == 2  # no failed webhook after a cancel

    g = W.Reporter("u", "t", post=lambda u, t, p: W.GONE)
    g.update("uploading", 96)
    assert g.cancelled.is_set() and g.gone.is_set()


class FakeRun:
    """Drives runner.run_job with the pipeline stubbed out; `answer(payload)` is the backend."""

    def __init__(self, monkeypatch, answer):
        import runner
        self.runner, self.sent, self.uploaded, self.deleted = runner, [], [], []
        self.answer = answer
        monkeypatch.setenv("R2_BUCKET", "b")
        stems = {n: np.zeros((2, 10), dtype=np.float32) for n in P.STEMS}
        for name, fn in {
            "r2_client": lambda env: object(),
            "download": lambda c, b, k, d: None,
            "probe": lambda p, m: 1.0,
            "decode": lambda p: np.zeros((2, 10), dtype=np.float32),
            "separate": lambda wav, model, progress_cb, **kw: (progress_cb(0.5), stems)[1],
            "encode_stem": lambda s, d, n: (d / f"{n}.m4a", d / f"{n}.flac"),
            "upload": lambda c, b, path, key, kind: self.uploaded.append(key) or 1,
            "delete": lambda c, b, key: self.deleted.append(key),
        }.items():
            monkeypatch.setattr(P, name, fn)
        monkeypatch.setattr(runner, "_analyse", lambda rep, mono, duration, work: None)

        def post(url, token, payload):
            self.sent.append(payload)
            return self.answer(payload)
        monkeypatch.setattr(runner, "Reporter", lambda u, t: W.Reporter(u, t, heartbeat_s=3600, post=post))

    def run(self):
        return self.runner.run_job(body())


def test_run_job_ok(monkeypatch):
    f = FakeRun(monkeypatch, lambda p: W.OK)
    assert f.run() == {"ok": True}
    assert len(f.uploaded) == 9 and f.deleted == [] and f.sent[-1]["status"] == "done"


def test_run_job_stops_before_uploading_when_cancelled(monkeypatch):
    f = FakeRun(monkeypatch, lambda p: W.CANCEL if p["stage"] == "uploading" else W.OK)
    assert f.run() == {"ok": False, "cancelled": True}
    assert f.uploaded == [] and f.deleted == []
    assert all(p["status"] == "running" for p in f.sent)  # no failed webhook


def test_run_job_deletes_its_uploads_when_song_deleted_mid_upload(monkeypatch):
    f = FakeRun(monkeypatch, lambda p: W.GONE if p["status"] == "done" else W.OK)
    assert f.run() == {"ok": False, "cancelled": True}
    assert len(f.uploaded) == 9 and sorted(f.deleted) == sorted(f.uploaded)


def test_run_job_superseded_attempt_keeps_shared_keys(monkeypatch):
    # A stale-attempt cancel must not delete keys a newer attempt also writes.
    f = FakeRun(monkeypatch, lambda p: W.CANCEL if p["status"] == "done" else W.OK)
    assert f.run() == {"ok": True}
    assert f.deleted == []


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


def test_btc_labels_and_beat_snapping():
    import analysis as A
    labels = A.btc_labels()
    assert len(labels) == 170 and labels[8 * 14 + 8] == "Abmaj7" and labels[10 * 14 + 1] == "Bb" and labels[169] == "N"
    fps = A.BTC_FPS
    frames = ["C"] * int(fps * 2) + ["Gm7"] * int(fps * 2)
    starts, labs = A.chords_to_beats(frames, np.array([0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]), 4.0)
    assert labs[0] == "C" and labs[-1] == "Gm7"
    merged = A.merge_chords(starts, labs, 4.0)
    assert [c["label"] for c in merged] == ["C", "Gm7"] and merged[0]["end"] == merged[1]["start"]


def test_build_analysis():
    import analysis as A
    beats = np.arange(0.5, 8.5, 0.5)
    out = A.build_analysis(beats, A.snap_downbeats(beats, np.array([0.52, 2.49, 4.5])), [], 8.0)
    assert out["bpm"] == 120.0 and out["beats_per_bar"] == 4 and out["downbeats"] == [0.5, 2.5, 4.5]


def test_estimate_key():
    import analysis as A

    def prog(*labels):
        return [{"start": i * 2.0, "end": i * 2.0 + 2.0, "label": lab} for i, lab in enumerate(labels)]

    assert A.parse_chord("Bbmaj7") == (10, "maj7") and A.parse_chord("Dbm7b5") == (1, "m7b5") and A.parse_chord("N") is None
    assert A.estimate_key(prog("C", "F", "G7", "C", "Am", "F", "G", "C")) == "C"
    assert A.estimate_key(prog("Dm", "Gm", "A7", "Dm", "Bb", "Gm", "A7", "Dm")) == "Dm"
    assert A.estimate_key(prog("Eb", "Ab", "Bb7", "Eb")) == "Eb"
    assert A.estimate_key(prog("N", "N")) is None and A.estimate_key([]) is None
    beats = np.arange(0.5, 8.5, 0.5)
    assert A.build_analysis(beats, beats[::4], prog("C", "F", "G", "C"), 8.0)["key"] == "C"
