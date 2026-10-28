//! Job/song state machine, Modal dispatch, retry/backoff and the background reaper.

use std::time::Duration;

use sqlx::{FromRow, PgConnection, PgPool};
use uuid::Uuid;

use crate::AppState;
use crate::auth::webhook_token;
use crate::modal::SpawnRequest;
use crate::storage;

pub const MAX_ATTEMPTS: i32 = 3;
pub const HEARTBEAT_TIMEOUT_SECS: i32 = 300;
pub const UPLOAD_TTL_HOURS: i32 = 24;
pub const REAPER_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Failed,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
    pub fn can_transition_to(self, next: Self) -> bool {
        use JobStatus::*;
        matches!(
            (self, next),
            (Queued, Running)
                | (Queued, Failed)
                | (Running, Running)
                | (Running, Queued)
                | (Running, Done)
                | (Running, Failed)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SongStatus {
    Importing,
    Uploading,
    Queued,
    Processing,
    Ready,
    Failed,
}

impl SongStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Importing => "importing",
            Self::Uploading => "uploading",
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "importing" => Self::Importing,
            "uploading" => Self::Uploading,
            "queued" => Self::Queued,
            "processing" => Self::Processing,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
    pub fn can_transition_to(self, next: Self) -> bool {
        use SongStatus::*;
        matches!(
            (self, next),
            (Importing, Queued)
                | (Importing, Failed)
                | (Uploading, Queued)
                | (Uploading, Failed)
                | (Queued, Processing)
                | (Queued, Failed)
                | (Processing, Processing)
                | (Processing, Ready)
                | (Processing, Failed)
                // reprocess
                | (Ready, Queued)
                | (Failed, Queued)
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FailureDecision {
    Retry { delay_secs: u64 },
    Fail,
}

/// Backoff after the given (failed) attempt: 30s after the 1st, 120s after the 2nd.
pub fn backoff_secs(failed_attempt: i32) -> Option<u64> {
    match failed_attempt {
        1 => Some(30),
        2 => Some(120),
        _ => None,
    }
}

pub fn decide_failure(attempt: i32, retryable: bool) -> FailureDecision {
    if retryable
        && attempt < MAX_ATTEMPTS
        && let Some(delay_secs) = backoff_secs(attempt)
    {
        return FailureDecision::Retry { delay_secs };
    }
    FailureDecision::Fail
}

#[derive(Debug, Clone, FromRow)]
pub struct JobRow {
    pub id: Uuid,
    pub song_id: Uuid,
    pub model: String,
    pub attempt: i32,
    pub status: String,
    pub progress: i32,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub modal_call_id: Option<String>,
    pub last_heartbeat_at: Option<chrono::DateTime<chrono::Utc>>,
    pub next_run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, FromRow)]
struct Claimed {
    id: Uuid,
    attempt: i32,
    model: String,
    song_id: Uuid,
    user_id: Uuid,
    original_key: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FailureOutcome {
    Retrying,
    Failed,
}

/// Insert a queued job that is due immediately. Call inside the transaction that moves the
/// song to `queued`; then call [`dispatch`] after commit.
pub async fn insert_job(
    conn: &mut PgConnection,
    song_id: Uuid,
    model: &str,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, song_id, model, attempt, status, next_run_at) VALUES ($1, $2, $3, 1, 'queued', now())",
    )
    .bind(id)
    .bind(song_id)
    .bind(model)
    .execute(conn)
    .await?;
    Ok(id)
}

/// Move a song whose original is now in R2 from `from` (uploading/importing) to `queued`,
/// create its job and spawn it. Returns false if the song was no longer in `from`.
pub async fn enqueue_song(
    state: &AppState,
    song_id: Uuid,
    from: SongStatus,
) -> Result<bool, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let model: Option<(String,)> = sqlx::query_as(
        "UPDATE songs SET status = 'queued', upload_id = NULL, error = NULL, updated_at = now() \
         WHERE id = $1 AND status = $2 RETURNING model",
    )
    .bind(song_id)
    .bind(from.as_str())
    .fetch_optional(&mut *tx)
    .await?;
    let Some((model,)) = model else {
        tx.rollback().await?;
        return Ok(false);
    };
    let job_id = insert_job(&mut tx, song_id, &model).await?;
    tx.commit().await?;
    dispatch(state, Some(job_id)).await?;
    Ok(true)
}

/// Imports run as in-process tasks, so any song still `importing` when the server starts was
/// interrupted by a restart.
pub async fn fail_orphaned_imports(pool: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE songs SET status = 'failed', error = 'The import was interrupted. Please try again.', \
         updated_at = now() WHERE status = 'importing'",
    )
    .execute(pool)
    .await?
    .rows_affected())
}

/// Record a failure for the job's current attempt. The caller must hold the row lock
/// (`SELECT ... FOR UPDATE`) and have checked the job is not terminal.
pub async fn record_failure(
    conn: &mut PgConnection,
    job: &JobRow,
    error: &str,
    retryable: bool,
) -> Result<FailureOutcome, sqlx::Error> {
    let error: String = error.chars().take(2000).collect();
    match decide_failure(job.attempt, retryable) {
        FailureDecision::Retry { delay_secs } => {
            sqlx::query(
                "UPDATE jobs SET status = 'queued', attempt = attempt + 1, error = $2, stage = NULL, progress = 0, \
                 next_run_at = now() + make_interval(secs => $3) WHERE id = $1",
            )
            .bind(job.id)
            .bind(&error)
            .bind(delay_secs as f64)
            .execute(&mut *conn)
            .await?;
            tracing::warn!(job_id = %job.id, attempt = job.attempt, delay_secs, %error, "job failed, will retry");
            Ok(FailureOutcome::Retrying)
        }
        FailureDecision::Fail => {
            sqlx::query(
                "UPDATE jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1",
            )
            .bind(job.id)
            .bind(&error)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE songs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
            )
            .bind(job.song_id)
            .bind(&error)
            .execute(&mut *conn)
            .await?;
            tracing::warn!(job_id = %job.id, attempt = job.attempt, %error, "job failed permanently");
            Ok(FailureOutcome::Failed)
        }
    }
}

/// Fail a job by id if (and only if) it is still running at `attempt`.
pub async fn fail_job(
    pool: &PgPool,
    job_id: Uuid,
    attempt: i32,
    error: &str,
    retryable: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let job: Option<JobRow> = sqlx::query_as("SELECT * FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(job) = job
        && job.attempt == attempt
        && job.status == JobStatus::Running.as_str()
    {
        record_failure(&mut tx, &job, error, retryable).await?;
    }
    tx.commit().await
}

/// Atomically claim due queued jobs (marking them running with a fresh heartbeat) and spawn
/// them on Modal. `only` restricts to a single job.
pub async fn dispatch(state: &AppState, only: Option<Uuid>) -> Result<usize, sqlx::Error> {
    let claimed: Vec<Claimed> = sqlx::query_as(
        "WITH due AS ( \
             SELECT id FROM jobs WHERE status = 'queued' AND next_run_at <= now() \
             AND ($1::uuid IS NULL OR id = $1) ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED \
         ), upd AS ( \
             UPDATE jobs SET status = 'running', next_run_at = NULL, last_heartbeat_at = now() \
             WHERE id IN (SELECT id FROM due) RETURNING id, attempt, model, song_id \
         ) \
         SELECT upd.id, upd.attempt, upd.model, upd.song_id, s.user_id, s.original_key \
         FROM upd JOIN songs s ON s.id = upd.song_id",
    )
    .bind(only)
    .fetch_all(&state.pool)
    .await?;
    let n = claimed.len();
    for c in claimed {
        spawn_one(state, c).await;
    }
    Ok(n)
}

async fn spawn_one(state: &AppState, c: Claimed) {
    let req = SpawnRequest {
        job_id: c.id,
        attempt: c.attempt,
        user_id: c.user_id,
        song_id: c.song_id,
        original_key: c.original_key,
        model: c.model,
        callback_url: state.config.callback_url(c.id),
        callback_token: webhook_token(&state.config.webhook_signing_key, c.id, c.attempt),
        max_duration_s: state.config.max_duration_s,
    };
    match state.modal.spawn(&req).await {
        Ok(call_id) => {
            tracing::info!(job_id = %c.id, attempt = c.attempt, %call_id, "spawned modal job");
            if let Err(e) =
                sqlx::query("UPDATE jobs SET modal_call_id = $2 WHERE id = $1 AND attempt = $3")
                    .bind(c.id)
                    .bind(&call_id)
                    .bind(c.attempt)
                    .execute(&state.pool)
                    .await
            {
                tracing::error!(error = %e, "failed to store modal call id");
            }
        }
        Err(e) => {
            tracing::warn!(job_id = %c.id, error = %e.message, retryable = e.retryable, "modal spawn failed");
            if let Err(db) = fail_job(&state.pool, c.id, c.attempt, &e.message, e.retryable).await {
                tracing::error!(error = %db, "failed to record spawn failure");
            }
        }
    }
}

/// Fail running jobs whose heartbeat is stale (retrying while attempts remain).
pub async fn fail_stale(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let stale: Vec<(Uuid, i32)> = sqlx::query_as(
        "SELECT id, attempt FROM jobs WHERE status = 'running' \
         AND last_heartbeat_at < now() - make_interval(secs => $1) LIMIT 50",
    )
    .bind(HEARTBEAT_TIMEOUT_SECS as f64)
    .fetch_all(pool)
    .await?;
    for (id, attempt) in &stale {
        fail_job(
            pool,
            *id,
            *attempt,
            "worker stopped responding (no heartbeat for 5 minutes)",
            true,
        )
        .await?;
    }
    Ok(stale.len())
}

/// Delete songs stuck in `uploading` for more than 24h (abort multipart, remove objects).
pub async fn purge_stale_uploads(state: &AppState) -> Result<usize, sqlx::Error> {
    let rows: Vec<(Uuid, Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, user_id, original_key, upload_id FROM songs WHERE status = 'uploading' \
         AND created_at < now() - make_interval(hours => $1) LIMIT 50",
    )
    .bind(UPLOAD_TTL_HOURS)
    .fetch_all(&state.pool)
    .await?;
    let mut purged = 0;
    for (id, user_id, key, upload_id) in rows {
        if let Some(up) = upload_id
            && let Err(e) = state.storage.abort_multipart(&key, &up).await
        {
            tracing::warn!(song_id = %id, error = %e, "abort multipart failed");
        }
        if let Err(e) = state
            .storage
            .delete_prefix(&storage::song_prefix(user_id, id))
            .await
        {
            tracing::warn!(song_id = %id, error = %e, "purge: could not delete objects, will retry");
            continue;
        }
        sqlx::query("DELETE FROM songs WHERE id = $1 AND status = 'uploading'")
            .bind(id)
            .execute(&state.pool)
            .await?;
        purged += 1;
    }
    Ok(purged)
}

pub async fn reaper_tick(state: &AppState) {
    if let Err(e) = dispatch(state, None).await {
        tracing::error!(error = %e, "reaper: dispatch failed");
    }
    if let Err(e) = fail_stale(&state.pool).await {
        tracing::error!(error = %e, "reaper: stale job check failed");
    }
    // Stale jobs that were just re-queued with backoff are picked up by a later tick.
    match purge_stale_uploads(state).await {
        Ok(n) if n > 0 => tracing::info!(purged = n, "purged stale uploads"),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "reaper: purge failed"),
    }
}

/// Background loop; runs until the task is aborted.
pub async fn reaper_loop(state: AppState) {
    let mut tick = tokio::time::interval(REAPER_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        reaper_tick(&state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule() {
        assert_eq!(backoff_secs(1), Some(30));
        assert_eq!(backoff_secs(2), Some(120));
        assert_eq!(backoff_secs(3), None);
    }

    #[test]
    fn failure_decisions() {
        assert_eq!(
            decide_failure(1, true),
            FailureDecision::Retry { delay_secs: 30 }
        );
        assert_eq!(
            decide_failure(2, true),
            FailureDecision::Retry { delay_secs: 120 }
        );
        assert_eq!(decide_failure(3, true), FailureDecision::Fail);
        assert_eq!(decide_failure(1, false), FailureDecision::Fail);
    }

    #[test]
    fn job_transitions() {
        use JobStatus::*;
        assert!(Queued.can_transition_to(Running));
        assert!(Running.can_transition_to(Done));
        assert!(Running.can_transition_to(Queued));
        assert!(!Done.can_transition_to(Running));
        assert!(!Failed.can_transition_to(Queued));
        assert!(!Queued.can_transition_to(Done));
        assert!(Done.is_terminal() && Failed.is_terminal());
        assert!(!Running.is_terminal());
        for s in [Queued, Running, Done, Failed] {
            assert_eq!(JobStatus::parse(s.as_str()), Some(s));
        }
    }

    #[test]
    fn song_transitions() {
        use SongStatus::*;
        assert!(Uploading.can_transition_to(Queued));
        assert!(Importing.can_transition_to(Queued));
        assert!(Importing.can_transition_to(Failed));
        assert!(!Importing.can_transition_to(Processing));
        assert!(Queued.can_transition_to(Processing));
        assert!(Processing.can_transition_to(Ready));
        assert!(Ready.can_transition_to(Queued));
        assert!(!Ready.can_transition_to(Processing));
        assert!(!Uploading.can_transition_to(Ready));
        assert!(!Failed.can_transition_to(Ready));
        for s in [Importing, Uploading, Queued, Processing, Ready, Failed] {
            assert_eq!(SongStatus::parse(s.as_str()), Some(s));
        }
    }
}
