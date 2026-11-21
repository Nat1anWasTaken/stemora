"""ADT_STR drum transcription (Melucci, Merialdo, Akama, arXiv 2601.09520; github.com/pier-maker92/ADT_STR).

An encoder-decoder transformer (MT3-style, 69M params) that turns 2.56 s of 24 kHz drum audio into
(time, class, velocity) token triples. This package is a plain-PyTorch re-implementation of the
upstream inference path (commit 77dbef225e7029478ebfb916f20c7a00274f0f12), written so it runs on the
worker's pinned torch without upstream's transformers 5 / torch 2.8 stack. Module and parameter names
mirror upstream's so its checkpoint loads strictly. Code and weights: CC BY-SA 4.0 (see LICENSE).

`tokens` needs only numpy; `model` imports torch.
"""
import os

SR = 24000
CHUNK_S = 2.56
CHUNK = round(CHUNK_S * SR)  # 61440 samples per window
MAX_TOKENS = 512  # per window, BOS included (upstream inference config)

HF_REPO, HF_REV = "Pierfrancesco/adt-str", "a33c5c6b191a4ca1e0f6dc22140947485eb36ce8"
VARIANT = "setting-tau-0.8"  # the checkpoint upstream reports as best overall
WEIGHTS_URL = f"https://huggingface.co/{HF_REPO}/resolve/{HF_REV}/{VARIANT}/model.safetensors"
WEIGHTS_SHA256 = "f94d1773d929166e0a3f63d305975aa6667512f8a71d7706872e1f8b23ca930b"
WEIGHTS = os.environ.get("ADT_STR_WEIGHTS", "/opt/adt_str/model.safetensors")
