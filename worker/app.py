"""Stemora Modal app: GPU Demucs separation + lightweight spawn endpoint."""
import os

import modal
from fastapi import HTTPException, Header

app = modal.App("stemora")

TORCH_HOME = "/opt/torch"
MODELS = ("htdemucs", "htdemucs_ft")


def _download_weights():
    from demucs.pretrained import get_model
    for m in MODELS:
        get_model(m)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.4.1", "torchaudio==2.4.1", "demucs==4.0.1", "numpy==1.26.4",
        "boto3==1.35.99", "requests==2.32.3", "fastapi[standard]==0.115.6",
    )
    .env({"TORCH_HOME": TORCH_HOME})
    .run_function(_download_weights)
    .add_local_python_source("pipeline", "webhook", "schema", "runner")
)

# GPU type. Set STEMORA_GPU=none at deploy time to deploy CPU-only (interim, for
# accounts without a GPU-enabled payment method; ~3-5x slower than L4 but functional).
GPU = os.environ.get("STEMORA_GPU", "L4")
GPU = None if GPU.lower() == "none" else GPU

secrets = [modal.Secret.from_name("stemora-r2"), modal.Secret.from_name("stemora-auth")]


@app.function(image=image, gpu=GPU, cpu=None if GPU else 8, retries=0, timeout=1200, secrets=secrets, memory=16384)
def separate(job: dict):
    """Full production pipeline: R2 -> Demucs -> R2 -> webhook."""
    import runner
    return runner.run_job(job)


@app.function(image=image, gpu=GPU, retries=0, timeout=1200, memory=16384)
def separate_test(audio: bytes, filename: str, model: str):
    """Same separation/encode path without R2/webhook; returns stems + timings."""
    import runner
    return runner.run_local(audio, filename, model)


@app.function(image=image, secrets=[modal.Secret.from_name("stemora-auth")])
@modal.fastapi_endpoint(method="POST")
def spawn(body: dict, authorization: str | None = Header(default=None)):
    import os
    from schema import RequestError, check_bearer, validate_request

    if not check_bearer(authorization, os.environ.get("MODAL_SHARED_SECRET")):
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        job = validate_request(body)
    except RequestError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    call = separate.spawn(job)
    return {"call_id": call.object_id}


@app.local_entrypoint()
def local_test(song_path: str, model: str = "htdemucs", out_dir: str = "./out"):
    """modal run app.py::local_test --song-path ./sample.mp3 [--model htdemucs_ft]"""
    import os
    import time
    t0 = time.time()
    with open(song_path, "rb") as f:
        data = f.read()
    res = separate_test.remote(data, os.path.basename(song_path), model)
    wall = time.time() - t0
    os.makedirs(out_dir, exist_ok=True)
    for name, files in res["files"].items():
        for ext, blob in files.items():
            with open(os.path.join(out_dir, f"{model}-{name}.{ext}"), "wb") as f:
                f.write(blob)
    print(f"model={model} audio_s={res['duration_s']:.1f}")
    print(f"timings (in container): {res['timings']}")
    print(f"container start-to-first-line (model load incl.): {res['timings'].get('total'):.1f}s")
    print(f"local wall clock incl. cold start + transfer: {wall:.1f}s")
    print(f"peaks buckets/stem: { {k: len(v) for k, v in res['peaks']['stems'].items()} }")
    print(f"stems written to {out_dir}")
