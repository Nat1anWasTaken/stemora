"""Drum transcription: the `drums` field of `analysis.json` (see docs/contract.md).

Hits come from ADTOF (Zehren et al., CC BY-NC-SA 4.0) through its PyTorch port
(xavriley/ADTOF-pytorch), run on the separated drums stem. They are then snapped to the
Beat This! grid: each beat is split into twelfths, and per beat either straight 16ths
(slots 0/3/6/9) or triplets (0/4/8), whichever fits that beat's hits better.
Heavy imports are lazy; the grid helpers need only numpy.
"""
import numpy as np

FPS = 100
# ADTOF output channel order (General MIDI pitches) -> contract names.
CLASSES = {35: "kick", 38: "snare", 47: "tom", 42: "hihat", 49: "cymbal"}
KINDS = ("kick", "snare", "hihat", "tom", "cymbal")
SLOTS = 12          # positions per beat in the contract
MIN_HITS = 8        # fewer hits than this in a song = no drums (silent or near-silent stem)
TRIPLET_BIAS = 0.6  # a beat is read as triplets only when that fits clearly better than 16ths
EARLY = 1 / 24      # hits this much of a beat before the first beat still count as on it


def load_model(device: str):
    """ADTOF Frame_RNN with the packaged weights. Fails loudly if any weight is missing
    (the port's own loader only prints and leaves those layers randomly initialised)."""
    import torch
    from adtof_pytorch import calculate_n_bins, create_frame_rnn_model, get_default_weights_path

    model = create_frame_rnn_model(calculate_n_bins())
    ckpt = torch.load(get_default_weights_path(), map_location="cpu")
    missing, _ = model.load_state_dict(ckpt.get("model_weights", ckpt), strict=False)
    if missing:
        raise RuntimeError(f"ADTOF weights incomplete, missing: {missing}")
    return model.to(device).eval()


def detect_hits(drums_mono_44k: np.ndarray, device: str | None = None) -> dict[str, np.ndarray]:
    """ADTOF on a mono float32 drums signal at 44.1k. Returns onset times (s) per kind."""
    import torch
    from adtof_pytorch import FRAME_RNN_THRESHOLDS, LABELS_5, PeakPicker
    from adtof_pytorch.audio import create_adtof_processor

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    proc = create_adtof_processor(fps=FPS)
    audio = np.ascontiguousarray(drums_mono_44k, dtype=np.float32)
    spec = proc.apply_filterbank(proc.compute_stft(audio)).T  # [frames, bins]
    x = torch.from_numpy(np.ascontiguousarray(spec[None, :, :, None])).to(device)
    with torch.no_grad():
        pred = load_model(device)(x).cpu().numpy()  # [1, frames, 5]
    peaks = PeakPicker(thresholds=FRAME_RNN_THRESHOLDS, fps=FPS).pick(pred, labels=LABELS_5)[0]
    return {CLASSES[p]: np.asarray(ts, dtype=float) for p, ts in peaks.items()}


def _grid_error(fracs: np.ndarray, g: int) -> float:
    return float(np.abs(fracs * g - np.round(fracs * g)).sum() / g)


def snap_to_grid(hits: dict[str, np.ndarray], beats) -> dict[str, list[list[int]]]:
    """Onset times per kind -> [[beat index, slot 0..11], ...] per kind (sorted, deduplicated)."""
    beats = np.asarray(beats, dtype=float)
    out: dict[str, list[list[int]]] = {k: [] for k in KINDS}
    if beats.size < 2:
        return out
    durs = np.diff(beats)
    durs = np.append(durs, durs[-1])  # the last beat lasts as long as the one before it
    end = beats[-1] + durs[-1]

    # Locate every hit: (kind, beat index, fraction of the beat in [0, 1)).
    located: list[tuple[str, int, float]] = []
    for kind in KINDS:
        for t in np.asarray(hits.get(kind, ()), dtype=float):
            if t < beats[0] - EARLY * durs[0] or t >= end:
                continue
            i = max(0, int(np.searchsorted(beats, t, side="right")) - 1)
            located.append((kind, i, max(0.0, (t - beats[i]) / durs[i])))

    # One grid per beat, chosen from all of that beat's hits together.
    by_beat: dict[int, list[float]] = {}
    for _, i, f in located:
        by_beat.setdefault(i, []).append(f)
    grid = {}
    for i, fs in by_beat.items():
        fa = np.asarray(fs)
        grid[i] = 3 if _grid_error(fa, 3) < TRIPLET_BIAS * _grid_error(fa, 4) else 4

    seen = set()
    for kind, i, f in located:
        g = grid[i]
        step = int(round(f * g))
        if step >= g:  # rounds onto the next beat's downbeat
            i, step = i + 1, 0
            if i >= beats.size:
                continue
        key = (kind, i, step * (SLOTS // g))
        if key not in seen:
            seen.add(key)
            out[kind].append([i, key[2]])
    for kind in KINDS:
        out[kind].sort()
    return out


def transcribe(drums_mono_44k: np.ndarray, beats, device: str | None = None) -> dict | None:
    """The `drums` field, or None when the stem has (almost) no drums."""
    snapped = snap_to_grid(detect_hits(drums_mono_44k, device), beats)
    if sum(len(v) for v in snapped.values()) < MIN_HITS:
        return None
    return snapped
