"""Song sections (intro / verse / chorus / ...) from SongFormer, snapped to the bar grid.

`tidy` turns the model's raw segments into the contract's `sections`: boundaries move to the
nearest downbeat (when one is within half a bar), slivers shorter than a bar are folded into a
neighbour, and equal neighbours merge. Heavy imports are lazy; `tidy` needs only numpy.
"""
import numpy as np

MIX_SR = 44100
LABELS = ("intro", "verse", "prechorus", "chorus", "bridge", "inst", "outro", "silence")


def _bar_length(downbeats: np.ndarray) -> float | None:
    return float(np.median(np.diff(downbeats))) if downbeats.size > 1 else None


def _snap(t: float, downbeats: np.ndarray, bar: float | None) -> float:
    if bar is None or downbeats.size == 0:
        return t
    d = downbeats[np.abs(downbeats - t).argmin()]
    return float(d) if abs(d - t) <= bar / 2 else t


def tidy(raw: list[tuple[float, str]], downbeats, duration: float) -> list[dict]:
    """[(start, label), ..., (end, "end")] -> contiguous [{"start","end","label"}] covering 0..duration."""
    downbeats = np.asarray(downbeats, dtype=float)
    bar = _bar_length(downbeats)
    segs = [(t, lab) for t, lab in raw[:-1] if lab in LABELS]
    if not segs:
        return []
    starts = [0.0] + [_snap(t, downbeats, bar) for t, _ in segs[1:]]
    labels = [lab for _, lab in segs]
    out: list[list] = []
    for i, (s, lab) in enumerate(zip(starts, labels)):
        e = starts[i + 1] if i + 1 < len(starts) else duration
        if e <= s:
            continue  # two boundaries snapped onto the same downbeat
        if out and out[-1][2] == lab:
            out[-1][1] = e
        else:
            out.append([s, e, lab])
    # Fold slivers (shorter than a bar, or 2 s without a grid) into the longer neighbour.
    min_len = bar or 2.0
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, (s, e, lab) in enumerate(out):
            if e - s >= min_len * 0.99:
                continue
            prev = out[i - 1] if i > 0 else None
            nxt = out[i + 1] if i + 1 < len(out) else None
            into = prev if nxt is None or (prev is not None and prev[1] - prev[0] >= nxt[1] - nxt[0]) else nxt
            if into is prev:
                prev[1] = e
            else:
                nxt[0] = s
            del out[i]
            # Merge the neighbours that may now carry the same label.
            j = 1
            while j < len(out):
                if out[j][2] == out[j - 1][2]:
                    out[j - 1][1] = out[j][1]
                    del out[j]
                else:
                    j += 1
            changed = True
            break
    return [{"start": round(s, 3), "end": round(e, 3), "label": lab} for s, e, lab in out]


def detect(mix_mono_44k: np.ndarray, downbeats, duration: float, device: str | None = None) -> list[dict]:
    """SongFormer on the full mix -> tidied sections (empty when nothing usable came out)."""
    import librosa
    import songformer

    y = librosa.resample(np.asarray(mix_mono_44k, dtype=np.float32), orig_sr=MIX_SR, target_sr=songformer.SR)
    return tidy(songformer.infer(y, device), downbeats, duration)
