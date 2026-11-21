"""Drum transcription: the `drums` field of `analysis.json` (see docs/contract.md).

Hits come from ADTOF (Zehren et al., CC BY-NC-SA 4.0) through its PyTorch port
(xavriley/ADTOF-pytorch), run on the separated drums stem. They are stored as raw onset
times; the player quantises them to the beat grid at the precision the viewer picks.
Heavy imports are lazy; `format_hits` needs only numpy.
"""
import numpy as np

FPS = 100
# ADTOF output channel order (General MIDI pitches) -> contract names.
CLASSES = {35: "kick", 38: "snare", 47: "tom", 42: "hihat", 49: "cymbal"}
KINDS = ("kick", "snare", "hihat", "tom", "cymbal")
MIN_HITS = 8        # fewer hits than this in a song = no drums (silent or near-silent stem)


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


def format_hits(hits: dict[str, np.ndarray], duration: float) -> dict[str, list[float]] | None:
    """The `drums` field: per kind, sorted onset times (s, ms precision) inside the song; None when the stem
    has (almost) no drums."""
    out = {}
    for kind in KINDS:
        ts = np.asarray(hits.get(kind, ()), dtype=float)
        ts = ts[(ts >= 0) & (ts < duration)]
        out[kind] = sorted({round(float(t), 3) for t in ts})
    return out if sum(len(v) for v in out.values()) >= MIN_HITS else None


def transcribe(drums_mono_44k: np.ndarray, duration: float, device: str | None = None) -> dict | None:
    return format_hits(detect_hits(drums_mono_44k, device), duration)
