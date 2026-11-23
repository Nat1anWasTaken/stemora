"""Beat / bar / chord analysis. Output is the `analysis.json` structure from docs/contract.md.

Beats and downbeats come from the Beat This! model, chords from the BTC transformer
(large vocabulary: maj/min/7/maj7/min7/dim/sus...), both run on the full mix. BTC's frame
probabilities are averaged per beat and decoded with a Viterbi pass that charges for every
chord change (less on downbeats), so the chart does not flicker between close candidates. Drum onsets (`drums.py`, ADTOF) come from the separated drums
stem when one is given; song sections (`sections.py`, SongFormer) from the full mix. Heavy
imports are lazy; the helpers need only numpy.
"""
import os
import traceback

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
# Chord tones (semitones above the root) per quality, for key estimation.
INTERVALS = {"m": (0, 3, 7), "": (0, 4, 7), "dim": (0, 3, 6), "aug": (0, 4, 8), "m6": (0, 3, 7, 9), "6": (0, 4, 7, 9),
             "m7": (0, 3, 7, 10), "mMaj7": (0, 3, 7, 11), "maj7": (0, 4, 7, 11), "7": (0, 4, 7, 10),
             "dim7": (0, 3, 6, 9), "m7b5": (0, 3, 6, 10), "sus2": (0, 2, 7), "sus4": (0, 5, 7)}
# Krumhansl-Kessler key profiles, tonic first.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def btc_labels() -> list[str]:
    """Label for each of BTC's 170 classes (index = root*14 + quality, 168 = X, 169 = N)."""
    return [ROOTS[i // 14] + QUALITIES[i % 14] for i in range(168)] + ["N", "N"]


# Viterbi cost (in log-probability) of changing chord at a beat, by position in the bar. A change
# has to be backed by that much extra evidence over the beats that follow, so one-beat flickers
# vanish and changes gravitate to bar lines, where chords usually move.
CHANGE_COST_DOWNBEAT = 0.5
CHANGE_COST_HALF_BAR = 1.5
CHANGE_COST_OTHER = 3.0


def beat_edges(beats: np.ndarray, duration: float) -> list[float]:
    """Segment boundaries: every beat, plus 0 when the first beat is late, plus the song end."""
    edges = [float(b) for b in beats]
    if not edges or edges[0] > 0.2:
        edges = [0.0] + edges
    return edges + [duration]


def beat_probs(frame_probs: np.ndarray, edges: list[float]) -> np.ndarray:
    """Mean frame probability inside each [edges[i], edges[i+1]) interval -> (len(edges)-1, classes)."""
    n = len(frame_probs)
    out = np.empty((len(edges) - 1, frame_probs.shape[1]))
    for k, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
        i0 = min(int(a * BTC_FPS), n - 1)
        i1 = min(max(i0 + 1, int(b * BTC_FPS)), n)
        out[k] = frame_probs[i0:i1].mean(axis=0)
    return out


def change_costs(starts: list[float], beats: np.ndarray, downbeats: np.ndarray) -> np.ndarray:
    """Cost of a chord change at the start of each segment (see CHANGE_COST_*)."""
    pos, sig = _bar_numbers(np.asarray(beats, dtype=float), np.asarray(downbeats, dtype=float))
    by_time = {round(float(b), 3): p for b, p in zip(beats, pos)}
    half = sig // 2 + 1 if sig % 2 == 0 and sig >= 4 else None
    costs = []
    for t in starts:
        p = by_time.get(round(float(t), 3), 0)
        costs.append(CHANGE_COST_DOWNBEAT if p == 1 else CHANGE_COST_HALF_BAR if p == half else CHANGE_COST_OTHER)
    return np.array(costs)


def viterbi(log_obs: np.ndarray, costs: np.ndarray) -> np.ndarray:
    """Best state path where staying is free and switching into segment t costs costs[t]."""
    n, k = log_obs.shape
    score = log_obs[0].copy()
    back = np.zeros((n, k), dtype=np.int64)
    for t in range(1, n):
        best = int(score.argmax())
        switch = score[best] - costs[t]
        stay = score >= switch
        back[t] = np.where(stay, np.arange(k), best)
        score = np.where(stay, score, switch) + log_obs[t]
    path = np.empty(n, dtype=np.int64)
    path[-1] = int(score.argmax())
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def chords_to_beats(frame_probs: np.ndarray, beats: np.ndarray, downbeats: np.ndarray,
                    duration: float) -> tuple[list[float], list[str]]:
    """Per-beat chord labels from BTC frame probabilities -> (segment starts, labels).

    BTC's "unknown chord" class (X) is folded into N: the contract has no X and the player shows
    both as no chord."""
    probs = np.asarray(frame_probs, dtype=float)
    probs = np.concatenate([probs[:, :168], probs[:, 168:].sum(axis=1, keepdims=True)], axis=1)
    names = btc_labels()[:169]
    edges = beat_edges(beats, duration)
    starts = edges[:-1]
    obs = np.log(beat_probs(probs, edges) + 1e-9)
    path = viterbi(obs, change_costs(starts, beats, downbeats))
    return starts, [names[i] for i in path]


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


def parse_chord(label: str) -> tuple[int, str] | None:
    """"Bbmaj7" -> (10, "maj7"); None for "N" or anything unrecognised."""
    for root in sorted(ROOTS, key=len, reverse=True):
        if label.startswith(root) and label[len(root):] in INTERVALS:
            return ROOTS.index(root), label[len(root):]
    return None


def estimate_key(chords: list[dict]) -> str | None:
    """Krumhansl-Schmuckler over a duration-weighted pitch-class profile of the chord tones -> "D" / "Dm" / None.

    Roots count double and 6ths/7ths half, so the triads decide the key."""
    profile = np.zeros(12)
    for c in chords:
        parsed = parse_chord(c["label"])
        if not parsed:
            continue
        root, quality = parsed
        dur = max(0.0, c["end"] - c["start"])
        for k, i in enumerate(INTERVALS[quality]):
            profile[(root + i) % 12] += dur * (2.0 if i == 0 else 1.0 if k < 3 else 0.5)
    if not profile.any():
        return None
    best, key = -2.0, None
    for tonic in range(12):
        for template, suffix in ((MAJOR_PROFILE, ""), (MINOR_PROFILE, "m")):
            r = float(np.corrcoef(profile, np.roll(template, tonic))[0, 1])
            if r > best:
                best, key = r, ROOTS[tonic] + suffix
    return key


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
        "key": estimate_key(chords),
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


def detect_chords(mix_mono_44k: np.ndarray, device: str | None = None) -> np.ndarray:
    """BTC large-vocabulary chord recognition. Returns class probabilities, (frames at BTC_FPS, 170)."""
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
            logits = model.output_layer.output_projection(attn)
            preds.append(torch.softmax(logits, -1).reshape(-1, logits.shape[-1]).cpu().numpy())
    return np.concatenate(preds)[:n_frames]


def analyse(mix_mono: np.ndarray, duration: float, device: str | None = None,
            drums_mono: np.ndarray | None = None) -> dict:
    beats, downbeats = detect_beats(mix_mono, device)
    frames = detect_chords(mix_mono, device)
    starts, labels = chords_to_beats(frames, beats, downbeats, duration)
    out = build_analysis(beats, downbeats, merge_chords(starts, labels, duration), duration)
    if drums_mono is not None:
        # Separate best-effort step: a drum failure keeps the beats and chords.
        try:
            import drums
            d = drums.transcribe(drums_mono, duration, device)
            if d:
                out["drums"] = d
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    # Likewise best effort: no sections keeps everything else.
    try:
        import sections
        s = sections.detect(mix_mono, out["downbeats"], duration, device)
        if s:
            out["sections"] = s
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    return out
