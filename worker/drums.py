"""Drum transcription: the `drums` and `drum_velocities` fields of `analysis.json` (see docs/contract.md).

Hits come from ADT_STR (Melucci et al., CC BY-SA 4.0; re-implemented in `adt_str/`), run on the
separated drums stem in non-overlapping 2.56 s windows. Its 26 classes are folded into the kinds a
drum chart writes differently; percussion a kit chart has no line for is dropped. Hits are stored as
raw onset times; the player quantises them to the beat grid at the precision the viewer picks.
Heavy imports are lazy; `format_hits` needs only numpy.
"""
import numpy as np

KINDS = ("kick", "snare", "sidestick", "hihat", "hihat_open", "hihat_pedal", "tom_high", "tom_mid", "tom_floor",
         "crash", "ride", "china", "splash", "tambourine", "cowbell")
# ADT_STR class ids (upstream utils/mapping_utils.py `GM_reduced_name_convention`; not GM pitches) -> kinds.
# Unlisted ids (53 vibraslap, 54 congas & timbales, 55 shaker, 56 whistle, 57 guiro, 58 claves, 59 cuica,
# 60 triangle, anything else) are dropped.
CLASS_TO_KIND = {
    35: "kick", 36: "kick",  # acoustic bass drum, bass drum 1
    37: "sidestick",
    38: "snare", 39: "snare", 40: "snare",  # acoustic snare, hand clap, electric snare
    41: "tom_floor", 42: "hihat", 43: "hihat_pedal", 44: "hihat_open", 45: "tom_mid", 46: "crash",
    47: "tom_high", 48: "ride", 49: "china", 50: "tambourine", 51: "splash", 52: "cowbell",
}
SR_IN = 44100
BATCH = 32          # windows decoded together
MERGE_S = 0.03      # same-kind hits closer than this are one hit (also mends doubles at window edges)
MIN_HITS = 8        # fewer hits than this in a song = no drums (silent or near-silent stem)

_model = None


def load_model(device: str):
    global _model
    if _model is None:
        from adt_str import WEIGHTS
        from adt_str.model import load
        _model = load(WEIGHTS, device)
    return _model.to(device)


def windows(audio: np.ndarray, size: int) -> np.ndarray:
    """Non-overlapping windows of `size` samples, the last one zero-padded: [n, size]."""
    n = max(1, -(-len(audio) // size))
    return np.pad(audio, (0, n * size - len(audio))).reshape(n, size)


def detect_hits(drums_mono_44k: np.ndarray, device: str | None = None) -> list[tuple[float, int, int]]:
    """ADT_STR on a mono float32 drums signal at 44.1k -> [(onset s, class id, velocity)]."""
    import torch
    import torchaudio.functional as AF
    from adt_str import CHUNK, CHUNK_S, SR, tokens

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model(device)
    # torchaudio's default resampler, as upstream inference uses: the model's output shifts with the resampler.
    audio = AF.resample(torch.from_numpy(np.ascontiguousarray(drums_mono_44k, dtype=np.float32)), SR_IN, SR).numpy()
    wins = windows(audio, CHUNK)
    hits, cut = [], 0
    for b in range(0, len(wins), BATCH):
        out = model.sample(torch.from_numpy(wins[b:b + BATCH]).to(device)).cpu().numpy()
        for k, row in enumerate(out):
            cut += tokens.truncated(row)
            hits += [((b + k) * CHUNK_S + t, c, v) for t, c, v in tokens.parse(row)]
    if cut:
        print(f"drums: {cut} of {len(wins)} windows hit the {len(out[0])}-token cap; hits there may be missing")
    return hits


def format_hits(hits, duration: float) -> tuple[dict[str, list[float]], dict[str, list[int]]] | None:
    """(`drums`, `drum_velocities`): per kind, sorted onset times (s, ms precision) inside the song and their
    velocities (1..127); same-kind hits within MERGE_S keep the louder one. None when the stem has (almost) no drums."""
    per: dict[str, list[tuple[float, int]]] = {}
    for t, c, v in hits:
        kind = CLASS_TO_KIND.get(int(c))
        if kind and 0 <= t < duration:
            per.setdefault(kind, []).append((round(float(t), 3), int(np.clip(v, 1, 127))))
    drums, vels = {}, {}
    for kind in KINDS:
        kept: list[tuple[float, int]] = []
        for t, v in sorted(per.get(kind, ())):
            if kept and t - kept[-1][0] < MERGE_S:
                if v > kept[-1][1]:
                    kept[-1] = (kept[-1][0], v)
                continue
            kept.append((t, v))
        if kept:
            drums[kind] = [t for t, _ in kept]
            vels[kind] = [v for _, v in kept]
    return (drums, vels) if sum(len(v) for v in drums.values()) >= MIN_HITS else None


def transcribe(drums_mono_44k: np.ndarray, duration: float, device: str | None = None):
    return format_hits(detect_hits(drums_mono_44k, device), duration)
