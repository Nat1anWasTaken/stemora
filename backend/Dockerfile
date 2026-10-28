# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS builder
WORKDIR /app

# Build dependencies first so they are cached until Cargo.toml/Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && echo '' > src/lib.rs \
    && cargo build --release && rm -rf src target/release/.fingerprint/stemora-backend* target/release/deps/stemora_backend* target/release/stemora-backend*

COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

# Not distroless: link imports run yt-dlp (Python) with ffmpeg for HLS/DASH sites and deno for
# YouTube's JS challenges. Bump YTDLP_VERSION and rebuild when sites change.
FROM denoland/deno:bin-2.9.6 AS deno

FROM debian:bookworm-slim
ARG YTDLP_VERSION=2026.10.26
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && useradd --system --uid 65532 --create-home --home-dir /home/stemora stemora
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=builder /app/target/release/stemora-backend /usr/local/bin/stemora-backend
USER stemora
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/usr/local/bin/stemora-backend", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/stemora-backend"]
