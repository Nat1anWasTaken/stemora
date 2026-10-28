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

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /app/target/release/stemora-backend /usr/local/bin/stemora-backend
USER nonroot:nonroot
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/usr/local/bin/stemora-backend", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/stemora-backend"]
