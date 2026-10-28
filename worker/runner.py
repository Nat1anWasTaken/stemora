"""Job orchestration used by the Modal functions (imported inside containers)."""
import os
import shutil
import tempfile
import time
import traceback
from pathlib import Path

import pipeline as P
from webhook import GONE, Cancelled, Reporter


def _separate_and_encode(wav, model, work: Path, rep=None, timings=None, device=None):
    """separate -> normalise -> encode -> peaks. Returns (peaks, {name: (m4a, flac)})."""
    timings = timings if timings is not None else {}
    t = time.time()

    def cb(f):
        if rep:
            rep.check()  # called per Demucs chunk, so a cancel stops the GPU within seconds
            rep.set_progress(5 + 85 * f)

    stems = P.separate(wav, model, progress_cb=cb, shifts=1, device=device)
    timings["separate"] = time.time() - t
    stems = P.normalise(stems)
    if rep:
        rep.update("encoding", 90)
    t = time.time()
    files = {}
    for i, name in enumerate(P.STEMS):
        if rep:
            rep.check()
        files[name] = P.encode_stem(stems[name], work, name)
        if rep:
            rep.set_progress(90 + 4 * (i + 1) / 4)
    peaks = P.compute_peaks(stems)
    timings["encode"] = time.time() - t
    return peaks, files


def _analyse(rep, mono, duration, work: Path):
    """Beats/bars/chords -> analysis.json in `work`. Best effort: a failure here must not fail the job."""
    import json
    rep.update("analyzing", 94)
    try:
        import analysis
        out = work / "analysis.json"
        out.write_text(json.dumps(analysis.analyse(mono, duration), separators=(",", ":")))
        return out
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None


def _delete_uploaded(s3, bucket, keys):
    """The song was deleted while we ran: remove what this run wrote, best effort. Only our own
    keys, never the whole prefix (a superseding attempt may share key names)."""
    for key in keys:
        try:
            P.delete(s3, bucket, key)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    if keys:
        print(f"deleted {len(keys)} orphaned object(s)")


def run_job(job: dict):
    rep = Reporter(job["callback_url"], job["callback_token"])
    work = Path(tempfile.mkdtemp(prefix="stemora-"))
    s3 = bucket = None
    uploaded = []

    def put(path, key, kind):
        rep.check()
        size = P.upload(s3, bucket, path, key, kind)
        uploaded.append(key)
        return size

    try:
        rep.start_heartbeat()
        rep.update("downloading", 1)
        rep.check()
        env = os.environ
        s3 = P.r2_client(env)
        bucket = env["R2_BUCKET"]
        src = work / ("original" + Path(job["original_key"]).suffix)
        P.download(s3, bucket, job["original_key"], src)

        rep.update("validating", 4)
        rep.check()
        duration = P.probe(str(src), job["max_duration_s"])
        wav = P.decode(str(src))

        rep.update("separating", 5)
        rep.check()
        peaks, files = _separate_and_encode(wav, job["model"], work, rep)
        mono = wav.mean(0)
        del wav
        analysis_json = _analyse(rep, mono, duration, work)
        del mono

        # A fresh round-trip right before writing anything to R2.
        rep.update("uploading", 96)
        prefix = P.song_prefix(job["user_id"], job["song_id"])
        stems_out = []
        for name in P.STEMS:
            m4a, flac = files[name]
            mk, fk = f"{prefix}/stems/{name}.m4a", f"{prefix}/stems/{name}.flac"
            stems_out.append({"name": name, "m4a_key": mk, "flac_key": fk,
                              "m4a_size": put(m4a, mk, "m4a"),
                              "flac_size": put(flac, fk, "flac")})
        import json
        pj = work / "peaks.json"
        pj.write_text(json.dumps(peaks, separators=(",", ":")))
        peaks_key = f"{prefix}/peaks.json"
        put(pj, peaks_key, "json")
        analysis_key = None
        if analysis_json:
            analysis_key = f"{prefix}/analysis.json"
            put(analysis_json, analysis_key, "json")
        if rep.done(duration, stems_out, peaks_key, analysis_key) == GONE:
            return {"ok": False, "cancelled": True}  # deleted while we were uploading
        return {"ok": True}
    except Cancelled:
        return {"ok": False, "cancelled": True}
    except P.ValidationError as e:
        rep.failed(str(e), retryable=False)
        return {"ok": False, "retryable": False, "error": str(e)}
    except BaseException as e:  # noqa: BLE001  (incl. OOM / timeouts surfaced as exceptions)
        traceback.print_exc()
        rep.failed(f"{type(e).__name__}: {e}", retryable=True)
        return {"ok": False, "retryable": True, "error": str(e)}
    finally:
        rep.stop_heartbeat()
        if rep.gone.is_set():
            _delete_uploaded(s3, bucket, uploaded)
        shutil.rmtree(work, ignore_errors=True)


def run_local(audio: bytes, filename: str, model: str, device=None):
    t0 = time.time()
    work = Path(tempfile.mkdtemp(prefix="stemora-test-"))
    try:
        src = work / ("in" + Path(filename).suffix)
        src.write_bytes(audio)
        duration = P.probe(str(src), 7200)
        wav = P.decode(str(src))
        timings = {}
        peaks, files = _separate_and_encode(wav, model, work, None, timings, device)
        timings["total"] = time.time() - t0
        return {"duration_s": duration, "timings": timings, "peaks": peaks,
                "files": {n: {"m4a": a.read_bytes(), "flac": b.read_bytes()} for n, (a, b) in files.items()}}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def analyse_local(audio: bytes, filename: str, device=None):
    import analysis
    work = Path(tempfile.mkdtemp(prefix="stemora-test-"))
    try:
        src = work / ("in" + Path(filename).suffix)
        src.write_bytes(audio)
        duration = P.probe(str(src), 7200)
        mono = P.decode(str(src)).mean(0)
        return analysis.analyse(mono, duration, device)
    finally:
        shutil.rmtree(work, ignore_errors=True)
