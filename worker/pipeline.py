"""Pure-ish pipeline functions: probe, decode, separate, encode, peaks, upload.

Heavy imports (torch, demucs, scnet, boto3) are lazy so the unit-testable parts
(peaks, normalisation) import with only numpy installed.
"""
import json
import subprocess
import types
from pathlib import Path

import numpy as np
from scnet.checkpoints import CHECKPOINTS as SCNET_MODELS
from scnet.checkpoints import CHUNK as SCNET_CHUNK
from scnet.checkpoints import OVERLAP as SCNET_OVERLAP
from scnet.checkpoints import SOURCES as SCNET_SOURCES

SR = 44100
STEMS = ("vocals", "drums", "bass", "other")
PEAKS_SPS = 20
CONTENT_TYPES = {"m4a": "audio/mp4", "flac": "audio/flac", "json": "application/json"}


class ValidationError(Exception):
    """Input is not acceptable; retrying will not help (retryable:false)."""


def probe(path: str, max_duration_s: float) -> float:
    """ffprobe validation. Returns duration in seconds."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", path],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise ValidationError("The file could not be read as audio (unsupported or corrupt file).")
    try:
        info = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise ValidationError("The file could not be read as audio.") from None
    if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
        raise ValidationError("The file has no audio stream.")
    try:
        dur = float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        raise ValidationError("Could not determine the audio duration.") from None
    if not dur > 0:
        raise ValidationError("The audio is empty.")
    if dur > max_duration_s:
        raise ValidationError(
            f"Audio is {dur / 60:.1f} min long; the maximum is {max_duration_s / 60:.1f} min.")
    return dur


def decode(path: str) -> np.ndarray:
    """Decode to float32 stereo 44.1k, shape (2, n)."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vn", "-map", "0:a:0",
         "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, timeout=600)
    if r.returncode != 0:
        raise ValidationError("The audio could not be decoded: " + r.stderr.decode(errors="replace")[-200:])
    a = np.frombuffer(r.stdout, dtype="<f4")
    if a.size < 2 * SR // 20:
        raise ValidationError("The audio is empty or too short.")
    return a.reshape(-1, 2).T.copy()


def _patch_progress(cb, n_runs):
    """demucs.apply only exposes progress through tqdm; shim it so we get a
    0..1 fraction across all sub-model/shift runs."""
    import demucs.apply as da
    state = {"run": -1}

    def tqdm(iterable, **_kw):
        state["run"] += 1
        run = state["run"]
        items = list(iterable) if not hasattr(iterable, "__len__") else iterable
        total = max(len(items), 1)

        def gen():
            for i, x in enumerate(items):
                yield x
                cb(min((run + (i + 1) / total) / n_runs, 1.0))
        return gen()

    orig = da.tqdm
    da.tqdm = types.SimpleNamespace(tqdm=tqdm)
    return lambda: setattr(da, "tqdm", orig)


def separate(wav: np.ndarray, model_name: str, progress_cb=lambda f: None, shifts: int = 1,
             device: str | None = None) -> dict:
    """Separate (2, n) float32 into {stem: (2, n) float32} with Demucs or SCNet."""
    import torch

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    if model_name in SCNET_MODELS:
        stems = _separate_scnet(wav, model_name, progress_cb, device)
    else:
        stems = _separate_demucs(wav, model_name, progress_cb, shifts, device)
    if device == "cuda":
        torch.cuda.empty_cache()
    missing = set(STEMS) - set(stems)
    if missing:
        raise RuntimeError(f"model did not produce stems: {sorted(missing)}")
    return {k: stems[k] for k in STEMS}


def _separate_demucs(wav, model_name, progress_cb, shifts, device) -> dict:
    import torch
    from demucs.apply import BagOfModels, apply_model
    from demucs.pretrained import get_model

    model = get_model(model_name)
    n_models = len(model.models) if isinstance(model, BagOfModels) else 1
    model.to(device).eval()
    mix = torch.from_numpy(wav)
    ref = mix.mean(0)
    mix = (mix - ref.mean()) / (ref.std() + 1e-8)
    restore = _patch_progress(progress_cb, n_models * max(shifts, 1))
    try:
        with torch.no_grad():
            out = apply_model(model, mix[None], shifts=shifts, split=True, overlap=0.25,
                              progress=True, device=device, num_workers=0)[0]
    finally:
        restore()
    out = out * (ref.std() + 1e-8) + ref.mean()
    out = out.cpu().numpy().astype(np.float32)
    return {name: out[i] for i, name in enumerate(model.sources)}


def load_scnet(model_name: str):
    """Build an SCNet from its config and load the baked-in checkpoint (CPU)."""
    import torch
    from scnet.model import SCNet

    spec = SCNET_MODELS[model_name]
    model = SCNet(**spec["config"])
    state = torch.load(spec["path"], map_location="cpu", weights_only=True)
    model.load_state_dict(state.get("state_dict", state))
    return model.eval()


def _fade_window(size: int, fade: int, fade_in: bool, fade_out: bool):
    import torch
    w = torch.ones(size)
    if fade_in:
        w[:fade] = torch.linspace(0, 1, fade)
    if fade_out:
        w[-fade:] = torch.linspace(1, 0, fade)
    return w


def _separate_scnet(wav, model_name, progress_cb, device, chunk=SCNET_CHUNK, batch=4) -> dict:
    """Overlap-add over fixed-size chunks with linear cross-fades (port of MSST's `demix`).
    The track is reflect-padded by one overlap so its edges get full context."""
    import torch
    import torch.nn.functional as F

    model = load_scnet(model_name).to(device)
    step = chunk // SCNET_OVERLAP
    border, fade = chunk - step, chunk // 10
    mix = torch.from_numpy(wav).to(device)
    n = mix.shape[-1]
    pad = border if n > 2 * border else 0
    if pad:
        mix = F.pad(mix, (pad, pad), mode="reflect")
    total = mix.shape[-1]
    starts = list(range(0, total, step))
    out = torch.zeros((len(model.sources),) + mix.shape, device=device)
    weight = torch.zeros(total, device=device)
    with torch.inference_mode(), torch.autocast(device_type="cuda", enabled=device == "cuda"):
        for b in range(0, len(starts), batch):
            group = starts[b:b + batch]
            parts = []
            for s in group:
                part = mix[:, s:s + chunk]
                missing = chunk - part.shape[-1]
                if missing:
                    mode = "reflect" if part.shape[-1] > chunk // 2 else "constant"
                    part = F.pad(part, (0, missing), mode=mode)
                parts.append(part)
            y = model(torch.stack(parts)).float()
            for j, s in enumerate(group):
                seg = min(chunk, total - s)
                w = _fade_window(chunk, fade, s > 0, s + chunk < total).to(device)[:seg]
                out[..., s:s + seg] += y[j, ..., :seg] * w
                weight[s:s + seg] += w
            progress_cb(min((b + len(group)) / len(starts), 1.0))
    out = (out / weight)[..., pad:pad + n].cpu().numpy().astype(np.float32)
    del model, mix, weight
    return {name: out[i] for i, name in enumerate(SCNET_SOURCES)}


def normalise(stems: dict, ceiling: float = 0.99) -> dict:
    """Remove NaN/inf; if any stem would clip, scale ALL stems by one common
    factor (keeps the stem balance, so they still sum to the mix); then hard
    clip as a final safety net."""
    stems = {k: np.nan_to_num(v, nan=0.0, posinf=0.0, neginf=0.0) for k, v in stems.items()}
    peak = max((float(np.abs(v).max()) if v.size else 0.0) for v in stems.values())
    if peak > ceiling:
        g = ceiling / peak
        stems = {k: v * g for k, v in stems.items()}
    return {k: np.clip(v, -1.0, 1.0).astype(np.float32) for k, v in stems.items()}


def compute_peaks(stem_arrays: dict, sr: int = SR, sps: int = PEAKS_SPS) -> dict:
    """peaks.json structure. Per stem: max-abs (over channels) in buckets of
    sr/sps samples, then normalised so the stem's loudest bucket is 1.0
    (all-silent stem stays all 0)."""
    bucket = sr // sps
    out = {}
    for name, a in stem_arrays.items():
        a = np.asarray(a)
        mono = np.abs(a).max(axis=0) if a.ndim == 2 else np.abs(a)
        n = int(np.ceil(mono.size / bucket)) if mono.size else 0
        if n == 0:
            out[name] = []
            continue
        pad = n * bucket - mono.size
        if pad:
            mono = np.concatenate([mono, np.zeros(pad, dtype=mono.dtype)])
        p = mono.reshape(n, bucket).max(axis=1).astype(np.float64)
        m = p.max()
        if m > 0:
            p = p / m
        out[name] = [round(float(x), 4) for x in np.clip(p, 0.0, 1.0)]
    return {"version": 1, "samples_per_second": sps, "stems": out}


def encode_stem(stem: np.ndarray, out_dir: Path, name: str) -> tuple[Path, Path]:
    """One ffmpeg run: raw f32 stereo from stdin -> AAC m4a 192k + FLAC (24-bit)."""
    m4a, flac = Path(out_dir) / f"{name}.m4a", Path(out_dir) / f"{name}.flac"
    data = np.ascontiguousarray(stem.T, dtype="<f4").tobytes()
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0",
           "-map", "0:a", "-c:a", "aac", "-b:a", "192k", "-ar", str(SR), "-ac", "2",
           "-movflags", "+faststart", str(m4a),
           "-map", "0:a", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24",
           "-ar", str(SR), "-ac", "2", str(flac)]
    r = subprocess.run(cmd, input=data, capture_output=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg encode failed for {name}: {r.stderr.decode(errors='replace')[-300:]}")
    return m4a, flac


def r2_client(env):
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=env["R2_ENDPOINT"], aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}))


def download(client, bucket, key, dest: Path):
    client.download_file(bucket, key, str(dest))


def upload(client, bucket, path: Path, key: str, kind: str) -> int:
    client.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": CONTENT_TYPES[kind]})
    return path.stat().st_size


def delete(client, bucket, key: str):
    client.delete_object(Bucket=bucket, Key=key)


def song_prefix(user_id, song_id):
    return f"users/{user_id}/songs/{song_id}"
