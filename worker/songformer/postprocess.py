"""Frame logits -> labelled segments. numpy only.

Port of SongFormer `postprocessing/functional.py` + `helpers.py` (CC-BY-4.0), themselves adapted
from mir-aidj/all-in-one (MIT). Same algorithm: sigmoid boundary activation, 3-frame local maxima,
peak picking against the mean of a +-12 s neighbourhood, then each segment takes the label with the
highest mean softmax probability.
"""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

FRAME_RATE = 8.333  # output frames per second
LOCAL_MAXIMA_FILTER = 3
PEAK_WINDOW_S = 12


def local_maxima(x: np.ndarray, filter_size: int) -> np.ndarray:
    """Keep values that are the maximum of their centred window (ties kept), zero elsewhere."""
    pad = filter_size // 2
    win = sliding_window_view(np.pad(x, pad, constant_values=-np.inf), filter_size)
    return np.where(x == win.max(axis=-1), x, 0.0)


def peak_picking(act: np.ndarray, window_past: int, window_future: int) -> np.ndarray:
    """Strength (activation minus mean of the past/future windows) at window maxima, zero elsewhere."""
    assert (window_past + window_future) % 2 == 0
    padded = np.pad(act, (window_past, window_future))
    is_max = (act == sliding_window_view(padded, window_past + window_future + 1).max(axis=-1)) & (act > 0)
    past = sliding_window_view(padded[: -(window_future + 1)], window_past).mean(axis=-1)
    future = sliding_window_view(padded[window_past + 1:], window_future).mean(axis=-1)
    out = np.zeros_like(act)
    out[is_max] = (act - (past + future) / 2)[is_max]
    return out


def _softmax(x: np.ndarray, axis: int) -> np.ndarray:
    e = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e / e.sum(axis=axis, keepdims=True)


def segments(function_logits: np.ndarray, boundary_logits: np.ndarray, labels: dict[int, str]) -> list[tuple[float, str]]:
    """function_logits [T, C] (disallowed classes = -inf), boundary_logits [T] ->
    [(start_s, label), ..., (end_s, "end")]."""
    prob_b = 1.0 / (1.0 + np.exp(-boundary_logits))
    prob_f = _softmax(function_logits, axis=1)  # [T, C]
    w = int(PEAK_WINDOW_S * FRAME_RATE)
    strength = peak_picking(local_maxima(prob_b, LOCAL_MAXIMA_FILTER), w, w)
    idx = np.flatnonzero(strength > 0.0)
    duration = len(prob_b) / FRAME_RATE
    times = idx / FRAME_RATE
    if times.size == 0 or times[0] != 0:
        times = np.insert(times, 0, 0.0)
    if times[-1] != duration:
        times = np.append(times, duration)
    parts = np.split(prob_f, idx[idx > 0], axis=0)
    out = [(float(t), labels[int(p.mean(axis=0).argmax())]) for t, p in zip(times[:-1], parts)]
    out.append((float(times[-1]), "end"))
    return out
