//! Stemora backend: auth, songs, uploads, Modal job orchestration.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod fetch;
pub mod import;
pub mod jobs;
pub mod modal;
pub mod ratelimit;
pub mod routes;
pub mod storage;
pub mod upload;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use sqlx::PgPool;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::config::Config;
use crate::fetch::{Fetcher, YtDlp};
use crate::modal::Modal;
use crate::ratelimit::RateLimiter;
use crate::storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub storage: Arc<dyn Storage>,
    pub modal: Arc<dyn Modal>,
    pub fetcher: Arc<dyn Fetcher>,
    /// Bounds concurrent link imports across all users.
    pub import_slots: Arc<tokio::sync::Semaphore>,
    /// Bounds concurrent link previews (yt-dlp metadata lookups) across all users.
    pub probe_slots: Arc<tokio::sync::Semaphore>,
    /// Stage, progress and cancellation of the imports running in this process.
    pub imports: Arc<import::ImportTracker>,
    /// Per-user limiter for POST /songs, /songs/import, /complete and /reprocess.
    pub upload_limiter: Arc<RateLimiter<Uuid>>,
    /// Per-user limiter for POST /songs/import/preview.
    pub preview_limiter: Arc<RateLimiter<Uuid>>,
    /// Limiter for login attempts, keyed by email.
    pub login_limiter: Arc<RateLimiter<String>>,
}

impl AppState {
    pub fn new(
        pool: PgPool,
        config: Config,
        storage: Arc<dyn Storage>,
        modal: Arc<dyn Modal>,
    ) -> Self {
        let fetcher = Arc::new(YtDlp::new(config.ytdlp_path.clone()));
        let import_slots = Arc::new(tokio::sync::Semaphore::new(config.max_concurrent_imports));
        Self {
            pool,
            config: Arc::new(config),
            storage,
            modal,
            fetcher,
            import_slots,
            probe_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            imports: Default::default(),
            upload_limiter: Arc::new(RateLimiter::new(30, Duration::from_secs(600))),
            preview_limiter: Arc::new(RateLimiter::new(60, Duration::from_secs(600))),
            login_limiter: Arc::new(RateLimiter::new(10, Duration::from_secs(600))),
        }
    }

    /// Replace the yt-dlp fetcher (tests use [`fetch::FakeFetcher`]).
    pub fn with_fetcher(mut self, fetcher: Arc<dyn Fetcher>) -> Self {
        self.fetcher = fetcher;
        self
    }
}

pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .merge(routes::auth::router())
        .merge(routes::songs::router())
        .merge(routes::webhooks::router())
        .merge(routes::admin::router())
        .merge(routes::usage::router())
        .route("/healthz", axum::routing::get(healthz));
    Router::new()
        .nest("/api", api)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(
    axum::extract::State(st): axum::extract::State<AppState>,
) -> Result<axum::Json<serde_json::Value>, error::AppError> {
    sqlx::query("SELECT 1").execute(&st.pool).await?;
    Ok(axum::Json(serde_json::json!({"ok": true})))
}
