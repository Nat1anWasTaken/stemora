//! Worker -> backend job updates. Idempotent; stale attempts and terminal jobs are ignored.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::auth::verify_webhook_token;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, JobRow, JobStatus, SongStatus};
use crate::routes::songs::STEM_NAMES;
use crate::storage;

pub fn router() -> Router<AppState> {
    Router::new().route("/webhooks/jobs/{job_id}", post(job_update))
}

#[derive(Deserialize)]
struct StemIn {
    name: String,
    m4a_key: String,
    flac_key: String,
    m4a_size: i64,
    flac_size: i64,
}

#[derive(Deserialize)]
struct Update {
    status: String,
    stage: Option<String>,
    progress: Option<i32>,
    error: Option<String>,
    retryable: Option<bool>,
    duration_s: Option<f64>,
    stems: Option<Vec<StemIn>>,
    #[allow(dead_code)]
    peaks_key: Option<String>,
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

fn ignored(reason: &str) -> Json<Value> {
    Json(json!({"ok": true, "ignored": reason}))
}

async fn job_update(
    State(st): State<AppState>,
    Path(job_id): Path<Uuid>,
    headers: HeaderMap,
    Json(u): Json<Update>,
) -> AppResult<Json<Value>> {
    let token = bearer(&headers).ok_or_else(AppError::unauthorized)?;
    let mut tx = st.pool.begin().await?;
    let job: JobRow = sqlx::query_as("SELECT * FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;

    let key = &st.config.webhook_signing_key;
    if !verify_webhook_token(key, job.id, job.attempt, token) {
        // A token from an earlier attempt is a valid-but-stale worker: acknowledge and ignore.
        let stale = (1..job.attempt).any(|a| verify_webhook_token(key, job.id, a, token));
        return if stale {
            Ok(ignored("stale_attempt"))
        } else {
            Err(AppError::unauthorized())
        };
    }
    if JobStatus::parse(&job.status).is_none_or(|s| s.is_terminal()) {
        return Ok(ignored("terminal"));
    }
    let (song_user,): (Uuid,) = sqlx::query_as("SELECT user_id FROM songs WHERE id = $1")
        .bind(job.song_id)
        .fetch_one(&mut *tx)
        .await?;

    match u.status.as_str() {
        "running" => {
            sqlx::query(
                "UPDATE jobs SET progress = $2, stage = COALESCE($3, stage), last_heartbeat_at = now() WHERE id = $1",
            )
            .bind(job.id)
            .bind(u.progress.unwrap_or(job.progress).clamp(0, 100))
            .bind(u.stage.as_deref().map(|s| s.chars().take(32).collect::<String>()))
            .execute(&mut *tx)
            .await?;
            if SongStatus::Queued.can_transition_to(SongStatus::Processing) {
                sqlx::query("UPDATE songs SET status = 'processing', updated_at = now() WHERE id = $1 AND status = 'queued'")
                    .bind(job.song_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        "done" => {
            let stems = u.stems.unwrap_or_default();
            let prefix = storage::stems_prefix(song_user, job.song_id);
            let valid = !stems.is_empty()
                && stems.iter().enumerate().all(|(i, s)| {
                    STEM_NAMES.contains(&s.name.as_str())
                        && stems.iter().take(i).all(|o| o.name != s.name)
                        && s.m4a_key == storage::stem_key(song_user, job.song_id, &s.name, "m4a")
                        && s.flac_key == storage::stem_key(song_user, job.song_id, &s.name, "flac")
                        && s.m4a_key.starts_with(&prefix)
                        && s.m4a_size >= 0
                        && s.flac_size >= 0
                });
            if !valid {
                return Err(AppError::bad_request(
                    "invalid_stems",
                    "stems missing, duplicated or with unexpected keys",
                ));
            }
            sqlx::query("DELETE FROM stems WHERE song_id = $1")
                .bind(job.song_id)
                .execute(&mut *tx)
                .await?;
            for s in &stems {
                sqlx::query("INSERT INTO stems (song_id, name, m4a_key, flac_key, m4a_size, flac_size) VALUES ($1, $2, $3, $4, $5, $6)")
                    .bind(job.song_id)
                    .bind(&s.name)
                    .bind(&s.m4a_key)
                    .bind(&s.flac_key)
                    .bind(s.m4a_size)
                    .bind(s.flac_size)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE jobs SET status = 'done', progress = 100, stage = 'done', error = NULL, finished_at = now(), last_heartbeat_at = now() WHERE id = $1")
                .bind(job.id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE songs SET status = 'ready', duration_s = $2, error = NULL, updated_at = now() WHERE id = $1")
                .bind(job.song_id)
                .bind(u.duration_s)
                .execute(&mut *tx)
                .await?;
        }
        "failed" => {
            let msg = u.error.unwrap_or_else(|| "processing failed".into());
            jobs::record_failure(&mut tx, &job, &msg, u.retryable.unwrap_or(false)).await?;
        }
        _ => {
            return Err(AppError::bad_request(
                "invalid_status",
                "status must be running, done or failed",
            ));
        }
    }
    tx.commit().await?;
    Ok(Json(json!({"ok": true})))
}
