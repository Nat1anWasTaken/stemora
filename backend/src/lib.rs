//! Stemora backend: auth, songs, uploads, Modal job orchestration.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
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
use crate::modal::Modal;
use crate::ratelimit::RateLimiter;
use crate::storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub storage: Arc<dyn Storage>,
    pub modal: Arc<dyn Modal>,
    /// Per-user limiter for POST /songs, /complete and /reprocess.
    pub upload_limiter: Arc<RateLimiter<Uuid>>,
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
        Self {
            pool,
            config: Arc::new(config),
            storage,
            modal,
            upload_limiter: Arc::new(RateLimiter::new(30, Duration::from_secs(600))),
            login_limiter: Arc::new(RateLimiter::new(10, Duration::from_secs(600))),
        }
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
