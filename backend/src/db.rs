//! Database helpers and row types.

use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new().max_connections(10).connect(url).await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

/// API representation of a song (progress/stage come from the latest job).
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SongView {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub duration_s: Option<f64>,
    pub size_bytes: i64,
    pub model: String,
    pub progress: i32,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub const SONG_VIEW_SELECT: &str = "SELECT s.id, s.title, s.status, s.duration_s, s.size_bytes, s.model, \
    CASE WHEN s.status = 'ready' THEN 100 ELSE COALESCE(j.progress, 0) END AS progress, \
    CASE WHEN s.status IN ('ready', 'failed', 'uploading') THEN NULL ELSE j.stage END AS stage, \
    s.error, s.created_at \
    FROM songs s LEFT JOIN LATERAL ( \
        SELECT progress, stage FROM jobs WHERE song_id = s.id ORDER BY created_at DESC LIMIT 1 \
    ) j ON true";

pub async fn song_view(pool: &PgPool, id: Uuid) -> Result<SongView, sqlx::Error> {
    sqlx::query_as(&format!("{SONG_VIEW_SELECT} WHERE s.id = $1"))
        .bind(id)
        .fetch_one(pool)
        .await
}

/// Full song row for internal use.
#[derive(Debug, Clone, FromRow)]
pub struct SongRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub title: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub status: String,
    pub duration_s: Option<f64>,
    pub model: String,
    pub original_key: String,
    pub upload_id: Option<String>,
    pub error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Fetch a song owned by `user_id`; other users' songs are indistinguishable from missing.
pub async fn owned_song(
    pool: &PgPool,
    user_id: Uuid,
    id: Uuid,
) -> Result<SongRow, crate::error::AppError> {
    sqlx::query_as("SELECT * FROM songs WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(crate::error::AppError::not_found)
}

#[derive(Debug, Clone, FromRow)]
pub struct StemRow {
    pub song_id: Uuid,
    pub name: String,
    pub m4a_key: String,
    pub flac_key: String,
    pub m4a_size: i64,
    pub flac_size: i64,
}

/// Bytes used by a user: original uploads (incl. in-flight reservations) plus stems.
pub async fn used_bytes(pool: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    let (songs,): (i64,) =
        sqlx::query_as("SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM songs WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    let (stems,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(st.m4a_size + st.flac_size), 0)::bigint FROM stems st \
         JOIN songs s ON s.id = st.song_id WHERE s.user_id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(songs + stems)
}

pub async fn active_jobs(pool: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM jobs j JOIN songs s ON s.id = j.song_id \
         WHERE s.user_id = $1 AND j.status IN ('queued', 'running')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(n)
}
