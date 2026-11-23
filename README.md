<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![AGPL-3.0 License][license-shield]][license-url]



<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/Nat1anWasTaken/stemora">
    <img src="frontend/public/icons/icon.svg" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">Stemora</h3>

  <p align="center">
    A self-hostable, open-source stem separation and practice player.
    <br />
    <a href="docs/contract.md"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/Nat1anWasTaken/stemora/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/Nat1anWasTaken/stemora/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>



<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#how-it-fits-together">How It Fits Together</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>



<!-- ABOUT THE PROJECT -->
## About The Project

Stemora is a self-hosted alternative to apps like Moises. Upload a song (or import one from a link), and a serverless GPU on [Modal](https://modal.com) splits it into vocals, drums, bass and other. You then practise along in a mobile-first multitrack player in the browser.

* Per-stem volume, mute and solo, seek, A-B looping and playback speed
* High-quality separation with Demucs (`htdemucs`) or SCNet (`scnet_xl_ihf`)
* Beat, bar and chord detection, drum transcription and song-section detection
* Metronome clicks on the detected tempo grid
* Stem downloads and a personal library with per-user quotas
* Invite-only accounts: the first visitor becomes the admin, admins invite everyone else
* Installable as a PWA

<p align="right">(<a href="#readme-top">back to top</a>)</p>



### Built With

* [![React][React.js]][React-url]
* [![TypeScript][TypeScript]][TypeScript-url]
* [![Vite][Vite]][Vite-url]
* [![Tailwind CSS][Tailwind]][Tailwind-url]
* [![Rust][Rust]][Rust-url]
* [![PostgreSQL][Postgres]][Postgres-url]
* [![Python][Python]][Python-url]
* [![PyTorch][PyTorch]][PyTorch-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>



### How It Fits Together

| Part | Stack | Role |
| --- | --- | --- |
| [`frontend/`](frontend/README.md) | React 19, TypeScript, Vite, Tailwind v4, shadcn/ui (Base UI) | SPA and Web Audio multitrack player |
| [`backend/`](backend/README.md) | Rust (axum, sqlx, Postgres) | Users, invites, songs, jobs, presigned R2 uploads, link imports (yt-dlp) |
| [`worker/`](worker/README.md) | Python on Modal (Demucs, SCNet, analysis models) | GPU separation and analysis, progress webhooks |
| [`docs/contract.md`](docs/contract.md) | | The binding interface between the three |

Audio never passes through the backend: the browser uploads straight to a private Cloudflare R2 bucket with presigned URLs, the worker reads and writes R2 directly, and the backend only coordinates.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* A server with Docker and Docker Compose
* A [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket (private) and an S3 API token with read/write on it
* A [Modal](https://modal.com) account (a payment method is needed for GPUs) and [`uv`](https://docs.astral.sh/uv/)
  ```sh
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/Nat1anWasTaken/stemora.git
   cd stemora
   ```
2. Configure CORS on the R2 bucket: allow `PUT`, `GET` and `HEAD` from your site's origin and expose the `ETag` header.
3. Create the worker secrets and deploy the worker (details in [`worker/README.md`](worker/README.md))
   ```sh
   cd worker
   uv sync
   uv run modal secret create stemora-r2 R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
     R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=stemora
   uv run modal secret create stemora-auth MODAL_SHARED_SECRET=$(openssl rand -hex 32)
   uv run modal deploy app.py
   cd ..
   ```
   The deploy prints the `spawn` URL; that is your `MODAL_ENDPOINT_URL`.
4. Fill in the environment
   ```sh
   cp .env.example .env
   ```
5. Start everything
   ```sh
   docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
   ```
   In production, point your reverse proxy at the `frontend` service (port 80) instead of using the local override.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- USAGE EXAMPLES -->
## Usage

Open the site. The first visit creates the admin account; from the admin page you create invite links for everyone else. Upload an audio file or paste a link, pick the separation model, and the song shows up in your library once the worker is done. Open it to mix the stems, loop a passage, follow the chords and section markers, or download individual stems.

_The API is documented in [`docs/contract.md`](docs/contract.md)._

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- DEVELOPMENT -->
## Development

* Frontend without a backend: `pnpm --dir frontend dev:mock` (login `dev@stemora.test` / `password`)
* Frontend checks: `pnpm --dir frontend lint`, `typecheck`, `test` and `build`
* Backend: `cargo test` in `backend/` (see [`backend/README.md`](backend/README.md))
* Worker unit tests: `uv run pytest` in `worker/`

See [`AGENTS.md`](AGENTS.md) for contributor rules, including the `@shadcn/lint` design rules.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- CONTRIBUTING -->
## Contributing

Contributions are welcome. If you have an idea, open an issue with the `enhancement` label, or send a pull request:

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feat/amazing-feature`)
3. Commit your Changes (`git commit -m 'Add some amazing feature'`)
4. Push to the Branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

If you change an interface between the worker, backend and frontend, update [`docs/contract.md`](docs/contract.md) in the same pull request.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Top contributors:

<a href="https://github.com/Nat1anWasTaken/stemora/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Nat1anWasTaken/stemora" alt="contrib.rocks image" />
</a>



<!-- LICENSE -->
## License

Stemora's own code is distributed under the GNU Affero General Public License v3.0 or later. See [`LICENSE`](LICENSE) for the full text. If you run a modified Stemora as a service for others, the AGPL requires you to offer them the source of your modified version.

> [!IMPORTANT]
> **Some of the model weights the worker downloads are licensed for non-commercial use only**, whatever the license of Stemora's code:
> the ADTOF drum transcription weights (CC BY-NC-SA 4.0) and the MuQ encoder weights used for section detection (CC BY-NC 4.0).
> A commercial deployment has to remove or replace those features. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Code vendored under `worker/scnet/` and `worker/songformer/` keeps its original license, included next to it.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- CONTACT -->
## Contact

Project Link: [https://github.com/Nat1anWasTaken/stemora](https://github.com/Nat1anWasTaken/stemora)

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

Stemora stands on the work of these research projects; please cite them if you build on the results.

* [Demucs](https://github.com/facebookresearch/demucs) (Défossez et al.): source separation
* [SCNet](https://arxiv.org/abs/2401.13276) (Tong et al.) via [Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) (ZFTurbo): high-quality separation
* [Beat This!](https://github.com/CPJKU/beat_this) (Foscarin et al., CPJKU): beat and downbeat tracking
* [Large-Vocabulary Chord Transcription](https://github.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition) (Jiang et al.) via [lv-chordia](https://github.com/openmirlab/lv-chordia): chord recognition
* [ADTOF](https://github.com/MZehren/ADTOF) (Zehren, Alunno, Bientinesi) via [ADTOF-pytorch](https://github.com/xavriley/ADTOF-pytorch): drum transcription
* [SongFormer](https://github.com/ASLP-lab/SongFormer) (Hao et al.) with [MuQ](https://github.com/tencent-ailab/MuQ) and [MusicFM](https://github.com/minzwon/musicfm): song sections
* [alphaTab](https://alphatab.net), [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), [shadcn/ui](https://ui.shadcn.com), [Base UI](https://base-ui.com), [Lucide](https://lucide.dev)
* [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org)
* [Best-README-Template](https://github.com/othneildrew/Best-README-Template)

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/Nat1anWasTaken/stemora.svg?style=for-the-badge
[contributors-url]: https://github.com/Nat1anWasTaken/stemora/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/Nat1anWasTaken/stemora.svg?style=for-the-badge
[forks-url]: https://github.com/Nat1anWasTaken/stemora/network/members
[stars-shield]: https://img.shields.io/github/stars/Nat1anWasTaken/stemora.svg?style=for-the-badge
[stars-url]: https://github.com/Nat1anWasTaken/stemora/stargazers
[issues-shield]: https://img.shields.io/github/issues/Nat1anWasTaken/stemora.svg?style=for-the-badge
[issues-url]: https://github.com/Nat1anWasTaken/stemora/issues
[license-shield]: https://img.shields.io/github/license/Nat1anWasTaken/stemora.svg?style=for-the-badge
[license-url]: https://github.com/Nat1anWasTaken/stemora/blob/main/LICENSE
[React.js]: https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[React-url]: https://react.dev/
[TypeScript]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Vite]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vite.dev/
[Tailwind]: https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white
[Tailwind-url]: https://tailwindcss.com/
[Rust]: https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white
[Rust-url]: https://www.rust-lang.org/
[Postgres]: https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white
[Postgres-url]: https://www.postgresql.org/
[Python]: https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white
[Python-url]: https://www.python.org/
[PyTorch]: https://img.shields.io/badge/PyTorch-EE4C2C?style=for-the-badge&logo=pytorch&logoColor=white
[PyTorch-url]: https://pytorch.org/
