"""Beat / bar / chord analysis. Output is the `analysis.json` structure from docs/contract.md.

Beats and downbeats come from the Beat This! model, chords from the BTC transformer
(large vocabulary: maj/min/7/maj7/min7/dim/sus...), both run on the full mix. Chords are
then snapped to the beat grid. Heavy imports are lazy; the helpers need only numpy.
"""
import os
from collections import Counter

import numpy as np

SR = 44100
VERSION = 1
BTC_SR = 22050
BTC_DIR = os.environ.get("BTC_DIR", "/opt/btc")
BTC_CKPT = "btc_model_large_voca.pt"
BTC_CFG = dict(feature_size=144, timestep=108, num_chords=170, input_dropout=0.2, layer_dropout=0.2,
               attention_dropout=0.2, relu_dropout=0.2, num_layers=8, num_heads=4, hidden_size=128,
               total_key_depth=128, total_value_depth=128, filter_size=128, probs_out=False)
BTC_HOP, BTC_CHUNK_S = 2048, 10.0
BTC_FPS = BTC_SR / BTC_HOP  # frames per second of the chord model

ROOTS = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
QUALITIES = ("m", "", "dim", "aug", "m6", "6", "m7", "mMaj7", "maj7", "7", "dim7", "m7b5", "sus2", "sus4")


def btc_labels() -> list[str]:
    """Label for each of BTC's 170 classes (index = root*14 + quality, 168 = X, 169 = N)."""
    return [ROOTS[i // 14] + QUALITIES[i % 14] for i in range(168)] + ["N", "N"]


def chords_to_beats(frame_labels: list[str], beats: np.ndarray, duration: float) -> tuple[list[float], list[str]]:
    """Majority-vote the frame labels inside each beat interval -> (segment starts, labels)."""
    edges = list(beats)
    if not edges or edges[0] > 0.2:
        edges = [0.0] + edges
    edges.append(duration)
    starts, labels = [], []
    n = len(frame_labels)
    for a, b in zip(edges[:-1], edges[1:]):
        i0, i1 = int(a * BTC_FPS), max(int(a * BTC_FPS) + 1, int(b * BTC_FPS))
        votes = Counter(frame_labels[min(i0, n - 1):min(i1, n)] or [frame_labels[-1]])
        starts.append(a)
        labels.append(votes.most_common(1)[0][0])
    return starts, labels


def merge_chords(times: list[float], labels: list[str], end: float) -> list[dict]:
    """times[i] is the start of labels[i]; merges runs; drops leading/trailing silence runs of N."""
    out: list[dict] = []
    for i, lab in enumerate(labels):
        t0 = times[i]
        t1 = times[i + 1] if i + 1 < len(times) else end
        if out and out[-1]["label"] == lab:
            out[-1]["end"] = round(t1, 3)
        else:
            out.append({"start": round(t0, 3), "end": round(t1, 3), "label": lab})
    return out


def _bar_numbers(beats: np.ndarray, downbeats: np.ndarray) -> tuple[list[int], int]:
    """Beat position in bar (1-based) for each beat, and the dominant beats-per-bar."""
    pos, cur, counts = [], 0, []
    db = set(np.round(downbeats, 3).tolist())
    for b in beats:
        if round(float(b), 3) in db:
            if cur:
                counts.append(cur)
            cur = 1
        else:
            cur = cur + 1 if cur else 0
        pos.append(cur)
    if cur:
        counts.append(cur)
    sig = int(np.bincount(counts).argmax()) if counts else 4
    return pos, sig


def build_analysis(beats, downbeats, chords: list[dict], duration: float) -> dict:
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    bpm = None
    if beats.size > 2:
        bpm = round(60.0 / float(np.median(np.diff(beats))), 1)
    _, sig = _bar_numbers(beats, downbeats)
    return {
        "version": VERSION,
        "duration_s": round(duration, 3),
        "bpm": bpm,
        "beats_per_bar": sig,
        "beats": [round(float(b), 3) for b in beats],
        "downbeats": [round(float(b), 3) for b in downbeats],
        "chords": chords,
    }


def snap_downbeats(beats: np.ndarray, downbeats: np.ndarray) -> np.ndarray:
    """Make every downbeat coincide exactly with a beat (the model returns them independently)."""
    if beats.size == 0:
        return downbeats
    idx = np.abs(beats[None, :] - downbeats[:, None]).argmin(axis=1)
    return np.unique(beats[idx])


def detect_beats(mono_44k: np.ndarray, device: str | None = None):
    """Beat This! on a mono float32 signal at 44.1k. Returns (beats, downbeats) in seconds."""
    import torch
    from beat_this.inference import Audio2Beats

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    a2b = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    beats, downbeats = a2b(mono_44k, SR)
    beats, downbeats = np.asarray(beats, dtype=float), np.asarray(downbeats, dtype=float)
    return beats, snap_downbeats(beats, downbeats)


def detect_chords(mix_mono_44k: np.ndarray, device: str | None = None) -> list[str]:
    """BTC large-vocabulary chord recognition. Returns one label per frame at BTC_FPS."""
    import librosa
    import torch
    from btc.model import BTC_model

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    y = librosa.resample(mix_mono_44k, orig_sr=SR, target_sr=BTC_SR)
    # The model was trained on CQTs computed per 10 s chunk; mirror that exactly.
    step = int(BTC_SR * BTC_CHUNK_S)
    parts = [librosa.cqt(y[i:i + step], sr=BTC_SR, n_bins=144, bins_per_octave=24, hop_length=BTC_HOP)
             for i in range(0, max(len(y), 1), step) if len(y[i:i + step]) > 0]
    feat = np.log(np.abs(np.concatenate(parts, axis=1)) + 1e-6).T
    ckpt = torch.load(os.path.join(BTC_DIR, BTC_CKPT), map_location=device)
    model = BTC_model(config=BTC_CFG).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    feat = (feat - ckpt["mean"]) / ckpt["std"]
    ts = BTC_CFG["timestep"]
    n_frames = feat.shape[0]
    feat = np.pad(feat, ((0, -n_frames % ts), (0, 0)))
    x = torch.tensor(feat, dtype=torch.float32, device=device).reshape(-1, ts, feat.shape[1])
    preds = []
    with torch.no_grad():
        for i in range(0, x.shape[0], 16):
            attn, _ = model.self_attn_layers(x[i:i + 16])
            p, _ = model.output_layer(attn)
            preds.append(p.reshape(-1).cpu().numpy())
    idx = np.concatenate(preds)[:n_frames]
    names = btc_labels()
    return [names[i] for i in idx]


def analyse(mix_mono: np.ndarray, duration: float, device: str | None = None) -> dict:
    beats, downbeats = detect_beats(mix_mono, device)
    frames = detect_chords(mix_mono, device)
    starts, labels = chords_to_beats(frames, beats, duration)
    return build_analysis(beats, downbeats, merge_chords(starts, labels, duration), duration)
