"""Beat / bar / chord analysis. Output is the `analysis.json` structure from docs/contract.md.

Beats and downbeats come from the Beat This! model, chords from lv-chordia (Jiang et al., ISMIR 2019:
a five-model CNN ensemble over a CQT, decoded by an HMM over a 25-quality chord dictionary), both
run on the full mix. The HMM already yields stable segments; they are mapped to the contract's
labels and snapped to the beat grid. Drum onsets (`drums.py`, ADTOF) come from the separated drums
stem when one is given; song sections (`sections.py`, SongFormer) from the full mix. Heavy imports
are lazy; the helpers need only numpy.
"""
import traceback

import numpy as np

SR = 44100
VERSION = 1
CHORD_SR = 22050  # lv-chordia's input rate

ROOTS = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
# Chord tones (semitones above the root) per quality, for key estimation.
INTERVALS = {"m": (0, 3, 7), "": (0, 4, 7), "dim": (0, 3, 6), "aug": (0, 4, 8), "m6": (0, 3, 7, 9), "6": (0, 4, 7, 9),
             "m7": (0, 3, 7, 10), "mMaj7": (0, 3, 7, 11), "maj7": (0, 4, 7, 11), "7": (0, 4, 7, 10),
             "dim7": (0, 3, 6, 9), "m7b5": (0, 3, 6, 10), "sus2": (0, 2, 7), "sus4": (0, 5, 7)}
# Krumhansl-Kessler key profiles, tonic first.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# lv-chordia speaks Harte syntax ("C#:min7", "Ab:maj/3", "G:sus4(b7)"). Its qualities, mapped to the
# contract's suffixes; extensions fold to the seventh chord under them.
HARTE_QUALITY = {"maj": "", "min": "m", "7": "7", "maj7": "maj7", "min7": "m7", "dim": "dim", "aug": "aug",
                 "dim7": "dim7", "hdim7": "m7b5", "sus2": "sus2", "sus4": "sus4", "sus4(b7)": "sus4",
                 "maj6": "6", "min6": "m6", "minmaj7": "mMaj7", "9": "7", "11": "7", "13": "7",
                 "maj9": "maj7", "min9": "m7"}
HARTE_ROOT = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb", "Cb": "B", "Fb": "E", "E#": "F", "B#": "C"}


def harte_to_label(harte: str) -> str:
    """"F#:min7" -> "Gbm7"; "C:maj/b7" -> "C7" (a b7 in the bass is still a seventh); other inversions
    drop the bass ("Ab:maj/3" -> "Ab"). Anything unparseable is "N"."""
    if not harte or harte in ("N", "X") or ":" not in harte:
        return "N"
    root, _, rest = harte.partition(":")
    quality, _, bass = rest.partition("/")
    root = HARTE_ROOT.get(root, root)
    if root not in ROOTS or quality not in HARTE_QUALITY:
        return "N"
    suffix = HARTE_QUALITY[quality]
    if bass == "b7" and suffix in ("", "m"):
        suffix += "7"
    return root + suffix


def beat_edges(beats: np.ndarray, duration: float) -> list[float]:
    """Segment boundaries: every beat, plus 0 when the first beat is late, plus the song end."""
    edges = [float(b) for b in beats]
    if not edges or edges[0] > 0.2:
        edges = [0.0] + edges
    return edges + [duration]


def chords_to_beats(segments: list[dict], beats: np.ndarray, duration: float) -> tuple[list[float], list[str]]:
    """Free-timed chord segments -> (beat starts, labels): each beat gets the chord covering most of it."""
    edges = beat_edges(beats, duration)
    labels = []
    j = 0
    for a, b in zip(edges[:-1], edges[1:]):
        while j < len(segments) and segments[j]["end"] <= a:
            j += 1
        cover: dict[str, float] = {}
        for seg in segments[j:]:
            if seg["start"] >= b:
                break
            cover[seg["label"]] = cover.get(seg["label"], 0.0) + min(b, seg["end"]) - max(a, seg["start"])
        labels.append(max(cover, key=cover.get) if cover else "N")
    return edges[:-1], labels


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


def detect_chords(mix_mono_44k: np.ndarray, device: str | None = None) -> list[dict]:
    """lv-chordia on the mix -> [{"start", "end", "label"}] in contract labels, free-timed."""
    import tempfile

    import librosa
    import soundfile as sf
    import torch
    from lv_chordia.chord_recognition import chord_recognition

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    y = librosa.resample(mix_mono_44k, orig_sr=SR, target_sr=CHORD_SR)
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:  # its API reads a file
        sf.write(f.name, y, CHORD_SR, subtype="FLOAT")
        res = chord_recognition(audio_path=f.name, chord_dict_name="submission", device=device)
    return [{"start": r["start_time"], "end": r["end_time"], "label": harte_to_label(r["chord"])} for r in res]


def analyse(mix_mono: np.ndarray, duration: float, device: str | None = None,
            drums_mono: np.ndarray | None = None) -> dict:
    beats, downbeats = detect_beats(mix_mono, device)
    segments = detect_chords(mix_mono, device)
    starts, labels = chords_to_beats(segments, beats, duration)
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
