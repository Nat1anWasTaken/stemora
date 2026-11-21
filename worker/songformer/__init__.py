"""SongFormer music structure analysis (ASLP-lab, arXiv 2510.02797): intro / verse / pre-chorus /
chorus / bridge / inst / outro / silence segments from the full mix.

Vendored for inference only (see LICENSE files): the SongFormer head (CC-BY-4.0), the MuQ encoder
code (MIT; its weights are CC-BY-NC 4.0, non-commercial) and MusicFM (MIT). Weights download from
Hugging Face at image build time (pinned revisions below) into HF_HOME / SONGFORMER_DIR.

Pipeline, as in the upstream app.py: MuQ and MusicFM layer-10 embeddings (25 Hz, 1024-d each) are
taken over 420 s windows and over 30 s windows, concatenated to 4096-d, and the head predicts
boundary and function logits at 8.333 Hz with the "SongForm-HX-8Class" dataset embedding.
"""
import math
import os

import numpy as np

SR = 24000
WINDOW_S = 420
SHORT_S = 30
LAYER = 10
DATASET_ID = 5  # SongForm-HX-8Class: HarmonixSet rule-mapped, pre-chorus kept
# Allowed classes for that dataset id -> label names (upstream dataset/label2id.py).
LABELS = {0: "intro", 1: "verse", 2: "chorus", 3: "bridge", 4: "inst", 5: "outro", 6: "silence", 26: "prechorus"}
NUM_CLASSES = 128

DIR = os.environ.get("SONGFORMER_DIR", "/opt/songformer")
SONGFORMER_REPO, SONGFORMER_REV = "ASLP-lab/SongFormer", "a75880ed1b7375ac71860ec6c4fc9c899cf99515"
MUQ_REPO, MUQ_REV = "OpenMuQ/MuQ-large-msd-iter", "0562a57814f6f8bbd9fdea0a25921a2fce1a841a"
MUSICFM_REPO, MUSICFM_REV = "minzwon/MusicFM", "4513b38bc25ad1d227b1980819b9691ba97f4d87"
# MusicFM builds its conformer from this config (fetched once, cached in HF_HOME).
W2V2_CONFIG_REPO = "facebook/wav2vec2-conformer-rope-large-960h-ft"


def download():
    """Image build step: fetch every weight file so containers never hit the network."""
    from huggingface_hub import hf_hub_download, snapshot_download
    from transformers import Wav2Vec2ConformerConfig
    hf_hub_download(SONGFORMER_REPO, "SongFormer.safetensors", revision=SONGFORMER_REV, local_dir=DIR)
    for f in ("pretrained_msd.pt", "msd_stats.json"):
        hf_hub_download(MUSICFM_REPO, f, revision=MUSICFM_REV, local_dir=DIR)
    snapshot_download(MUQ_REPO, revision=MUQ_REV, allow_patterns=["config.json", "model.safetensors"])
    Wav2Vec2ConformerConfig.from_pretrained(W2V2_CONFIG_REPO)


def load(device: str):
    """-> (muq, musicfm, head), all in eval mode on `device`."""
    from safetensors.torch import load_file
    from .model import Model
    from .muq.muq import MuQ
    from .musicfm.musicfm_25hz import MusicFM25Hz

    muq = MuQ.from_pretrained(MUQ_REPO, revision=MUQ_REV).to(device).eval()
    musicfm = MusicFM25Hz(is_flash=False, stat_path=os.path.join(DIR, "msd_stats.json"),
                          model_path=os.path.join(DIR, "pretrained_msd.pt")).to(device).eval()
    head = Model()
    # The checkpoint is an ema_pytorch EMA state dict; the weights are the `ema_model.` entries.
    sd = load_file(os.path.join(DIR, "SongFormer.safetensors"))
    sd = {k[len("ema_model."):]: v for k, v in sd.items() if k.startswith("ema_model.")}
    head.load_state_dict(sd, strict=True)
    return muq, musicfm, head.to(device).eval()


def _embed(muq, musicfm, x):
    """[1, n] at 24 kHz -> (musicfm, muq) layer-10 embeddings, each [1, T, 1024] at 25 Hz."""
    import torch
    a = musicfm.get_predictions(x)[1][LAYER]
    b = muq(x, output_hidden_states=True)["hidden_states"][LAYER]
    if x.is_cuda:
        torch.cuda.empty_cache()
    return a, b


def infer(mono_24k: np.ndarray, device: str | None = None, models=None) -> list[tuple[float, str]]:
    """Mono float32 at 24 kHz -> [(start_s, label), ..., (end_s, "end")]."""
    import torch
    from .postprocess import FRAME_RATE, segments

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    muq, musicfm, head = models or load(device)
    audio = torch.tensor(np.asarray(mono_24k, dtype=np.float32), device=device)
    n = audio.shape[-1]
    total_frames = math.ceil((n // SR // WINDOW_S * WINDOW_S + WINDOW_S) * FRAME_RATE)
    fn_sum = np.zeros((total_frames, NUM_CLASSES))
    fn_cnt = np.zeros((total_frames, 1))
    bd = np.zeros(total_frames)
    allowed = torch.zeros(NUM_CLASSES, dtype=torch.bool)
    allowed[list(LABELS)] = True
    used = 0
    with torch.no_grad():
        for w0 in range(0, n // SR + 1, WINDOW_S):
            a0, a1 = w0 * SR, min((w0 + WINDOW_S) * SR, n)
            if a1 - a0 <= 1024:
                break
            long_fm, long_muq = _embed(muq, musicfm, audio[None, a0:a1])
            short_fm, short_muq = [], []
            for s0 in range(w0, w0 + WINDOW_S, SHORT_S):
                b0, b1 = s0 * SR, min((s0 + SHORT_S) * SR, a1)
                if b1 - b0 <= 1024:
                    break
                fm, mq = _embed(muq, musicfm, audio[None, b0:b1])
                short_fm.append(fm)
                short_muq.append(mq)
            parts = [torch.cat(short_fm, 1), torch.cat(short_muq, 1), long_fm, long_muq]
            t = min(p.shape[1] for p in parts)
            fn, b = head.logits(torch.cat([p[:, :t] for p in parts], -1), DATASET_ID, allowed)
            f0 = int(w0 * FRAME_RATE)
            f1 = f0 + min(math.ceil(WINDOW_S * FRAME_RATE), b.shape[0])
            fn_sum[f0:f1] += fn[: f1 - f0].float().cpu().numpy()
            fn_cnt[f0:f1] += 1
            bd[f0:f1] = b[: f1 - f0].float().cpu().numpy()
            used += f1 - f0
    fn_logits = (fn_sum / np.maximum(fn_cnt, 1))[:used]
    # Masked classes are -inf in every frame; keep them out of the softmax exactly.
    fn_logits[:, [i for i in range(NUM_CLASSES) if i not in LABELS]] = -np.inf
    return segments(fn_logits, bd[:used], LABELS)
