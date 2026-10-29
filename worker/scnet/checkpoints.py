"""Published SCNet checkpoints. `config` is the `model:` section of each checkpoint's YAML;
app.py bakes the weights into the image at `path`."""

SOURCES = ("drums", "bass", "other", "vocals")
CHUNK = 485100  # 11 s at 44.1 kHz, the training chunk size
OVERLAP = 4

CHECKPOINTS = {
    "scnet_xl_ihf": {
        "url": "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/"
               "v1.0.15/model_scnet_ep_36_sdr_10.0891.ckpt",
        "sha256": "ac25975f0f5704f3d1a3c3c251505b7a0f417a22eafe82773440ee4f7e14b74f",
        "path": "/opt/scnet/scnet_xl_ihf.ckpt",
        "config": {
            "sources": list(SOURCES), "audio_channels": 2, "dims": [4, 64, 128, 256],
            "nfft": 4096, "hop_size": 1024, "win_size": 4096, "normalized": True,
            "band_SR": [0.230, 0.370, 0.400], "band_stride": [1, 4, 4], "band_kernel": [3, 4, 4],
            "conv_depths": [3, 3, 3], "compress": 4, "conv_kernel": 3, "num_dplayer": 8, "expand": 1,
        },
    },
}
