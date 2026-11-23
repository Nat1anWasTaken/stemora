# Third-party notices

Stemora's own code is licensed under AGPL-3.0-or-later (see `LICENSE`). This file lists the third-party code, models and assets it uses and the terms that come with them. Package dependencies resolved by `pnpm`, `cargo` and `pip` keep their own licenses; the summary below was taken from the lockfiles.

## Non-commercial model weights

These are downloaded by `worker/app.py` at image build time. Their licenses forbid commercial use, independently of Stemora's license.

| Component | Used for | License |
| --- | --- | --- |
| [ADTOF](https://github.com/MZehren/ADTOF) weights, via [ADTOF-pytorch](https://github.com/xavriley/ADTOF-pytorch) | Drum transcription | CC BY-NC-SA 4.0 |
| [MuQ](https://huggingface.co/OpenMuQ/MuQ-large-msd-iter) weights (`OpenMuQ/MuQ-large-msd-iter`) | Song sections (SongFormer encoder) | CC BY-NC 4.0 |

## Vendored source code (`worker/`)

| Directory | Origin | License |
| --- | --- | --- |
| `worker/scnet/` | [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) @ 6fdad13, Copyright (c) 2024 Roman Solovyev | MIT |
| `worker/songformer/` | [ASLP-lab/SongFormer](https://github.com/ASLP-lab/SongFormer) | CC BY 4.0 |
| `worker/songformer/muq/` | [tencent-ailab/MuQ](https://github.com/tencent-ailab/MuQ), Copyright (c) Tencent | MIT |
| `worker/songformer/musicfm/` | [minzwon/musicfm](https://github.com/minzwon/musicfm) | MIT or Apache-2.0 |

Each directory contains the original `LICENSE` file.

## Other models and worker packages

| Component | License |
| --- | --- |
| [Demucs](https://github.com/facebookresearch/demucs) code and `htdemucs` weights | MIT |
| SCNet `scnet_xl_ihf` checkpoint (ZFTurbo release v1.0.15) | MIT (repository license) |
| [lv-chordia](https://github.com/openmirlab/lv-chordia) code and bundled weights (Jiang et al., Music X Lab) | MIT |
| [Beat This!](https://github.com/CPJKU/beat_this) code and `final0` checkpoint | MIT |
| [SongFormer](https://huggingface.co/ASLP-lab/SongFormer) weights | CC BY 4.0 |
| [MusicFM](https://huggingface.co/minzwon/MusicFM) weights | see the model card |
| PyTorch, torchaudio | BSD-3-Clause |
| librosa | ISC |
| NumPy, pretty_midi, pydub, FastAPI, einops, x-transformers, rotary-embedding-torch, easydict | MIT / BSD |
| transformers, safetensors, boto3, requests, Modal client | Apache-2.0 |

## Backend image

| Component | License |
| --- | --- |
| Rust crates (axum, tokio, sqlx, serde, rustls, ...) | MIT / Apache-2.0 and compatible permissive licenses (BSD, ISC, Zlib, Unicode-3.0, CDLA-Permissive-2.0) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [Deno](https://deno.com) | MIT |
| FFmpeg (Debian package, run as a separate program) | GPL-2.0-or-later / LGPL-2.1-or-later |
| PostgreSQL | PostgreSQL License |

## Frontend bundle

| Component | License |
| --- | --- |
| React, Vite, Tailwind CSS, Base UI, TanStack Query, zustand, sonner, Signalsmith Stretch and most other packages | MIT |
| [alphaTab](https://alphatab.net) (`@coderline/alphatab`) | MPL-2.0 (unmodified; source at https://github.com/CoderLine/alphaTab) |
| Lucide icons | ISC |
| Geist, Bricolage Grotesque (via Fontsource) | SIL Open Font License 1.1 |
| class-variance-authority | Apache-2.0 |
