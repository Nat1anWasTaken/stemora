"""Job orchestration used by the Modal functions (imported inside containers)."""
import os
import shutil
import tempfile
import time
import traceback
from pathlib import Path

import pipeline as P
from webhook import Reporter


def _separate_and_encode(wav, model, work: Path, rep=None, timings=None, device=None):
    """separate -> normalise -> encode -> peaks. Returns (peaks, {name: (m4a, flac)})."""
    timings = timings if timings is not None else {}
    t = time.time()
    cb = (lambda f: rep.set_progress(5 + 85 * f)) if rep else (lambda f: None)
    stems = P.separate(wav, model, progress_cb=cb, shifts=1, device=device)
    timings["separate"] = time.time() - t
    stems = P.normalise(stems)
    if rep:
        rep.update("encoding", 90)
    t = time.time()
    files = {}
    for i, name in enumerate(P.STEMS):
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


def run_job(job: dict):
    rep = Reporter(job["callback_url"], job["callback_token"])
    work = Path(tempfile.mkdtemp(prefix="stemora-"))
    try:
        rep.start_heartbeat()
        rep.update("downloading", 1)
        env = os.environ
        s3 = P.r2_client(env)
        bucket = env["R2_BUCKET"]
        src = work / ("original" + Path(job["original_key"]).suffix)
        P.download(s3, bucket, job["original_key"], src)

        rep.update("validating", 4)
        duration = P.probe(str(src), job["max_duration_s"])
        wav = P.decode(str(src))

        rep.update("separating", 5)
        peaks, files = _separate_and_encode(wav, job["model"], work, rep)
        mono = wav.mean(0)
        del wav
        analysis_json = _analyse(rep, mono, duration, work)
        del mono

        rep.update("uploading", 96)
        prefix = P.song_prefix(job["user_id"], job["song_id"])
        stems_out = []
        for name in P.STEMS:
            m4a, flac = files[name]
            mk, fk = f"{prefix}/stems/{name}.m4a", f"{prefix}/stems/{name}.flac"
            stems_out.append({"name": name, "m4a_key": mk, "flac_key": fk,
                              "m4a_size": P.upload(s3, bucket, m4a, mk, "m4a"),
                              "flac_size": P.upload(s3, bucket, flac, fk, "flac")})
        import json
        pj = work / "peaks.json"
        pj.write_text(json.dumps(peaks, separators=(",", ":")))
        peaks_key = f"{prefix}/peaks.json"
        P.upload(s3, bucket, pj, peaks_key, "json")
        analysis_key = None
        if analysis_json:
            analysis_key = f"{prefix}/analysis.json"
            P.upload(s3, bucket, analysis_json, analysis_key, "json")
        rep.done(duration, stems_out, peaks_key, analysis_key)
        return {"ok": True}
    except P.ValidationError as e:
        rep.failed(str(e), retryable=False)
        return {"ok": False, "retryable": False, "error": str(e)}
    except BaseException as e:  # noqa: BLE001  (incl. OOM / timeouts surfaced as exceptions)
        traceback.print_exc()
        rep.failed(f"{type(e).__name__}: {e}", retryable=True)
        return {"ok": False, "retryable": True, "error": str(e)}
    finally:
        rep.stop_heartbeat()
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
