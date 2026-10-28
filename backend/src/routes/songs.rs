use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::db::{self, SONG_VIEW_SELECT, SongRow, SongView, StemRow, owned_song, song_view};
use crate::error::{AppError, AppResult};
use crate::import;
use crate::jobs::{self, SongStatus};
use crate::storage::{self, PresignedPut};
use crate::upload::{self, PART_SIZE, UploadPlan};

pub const STEM_NAMES: [&str; 4] = ["vocals", "drums", "bass", "other"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/songs", get(list).post(create))
        .route("/songs/import", post(import_link))
        .route("/songs/import/preview", post(preview_link))
        .route("/songs/{id}", get(detail).patch(rename).delete(remove))
        .route("/songs/{id}/upload/parts", post(part_urls))
        .route("/songs/{id}/complete", post(complete))
        .route("/songs/{id}/reprocess", post(reprocess))
        .route("/songs/{id}/cancel", post(cancel_import))
        .route("/songs/{id}/stems/{name}/download", get(download))
}

fn check_rate(st: &AppState, user: Uuid) -> AppResult<()> {
    if st.upload_limiter.check(&user) {
        Ok(())
    } else {
        Err(AppError::too_many(
            "rate_limited",
            "too many uploads, please slow down",
        ))
    }
}

/// A song as the API shows it, with the live state of a running link import.
async fn live_view(st: &AppState, id: Uuid) -> AppResult<SongView> {
    let mut v = song_view(&st.pool, id).await?;
    st.imports.annotate(&mut v);
    Ok(v)
}

async fn list(State(st): State<AppState>, AuthUser(u): AuthUser) -> AppResult<Json<Vec<SongView>>> {
    let mut rows: Vec<SongView> = sqlx::query_as(&format!(
        "{SONG_VIEW_SELECT} WHERE s.user_id = $1 ORDER BY s.created_at DESC"
    ))
    .bind(u.id)
    .fetch_all(&st.pool)
    .await?;
    for r in &mut rows {
        st.imports.annotate(r);
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct CreateReq {
    title: String,
    filename: String,
    content_type: String,
    size: i64,
    model: String,
}

async fn create(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Json(r): Json<CreateReq>,
) -> AppResult<Json<Value>> {
    check_rate(&st, u.id)?;
    upload::validate_model(&r.model)?;
    let (ext, content_type) = upload::validate_audio(&r.filename, &r.content_type)?;
    if r.size <= 0 {
        return Err(AppError::bad_request(
            "invalid_size",
            "size must be positive",
        ));
    }
    if r.size > st.config.max_upload_bytes() {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            format!(
                "file exceeds the {} MB upload limit",
                st.config.max_upload_mb
            ),
        ));
    }
    let plan = upload::plan_for_size(r.size);
    if let UploadPlan::Multipart { part_count } = plan
        && part_count > upload::MAX_PARTS
    {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "file too large",
        ));
    }
    let title = {
        let t = r.title.trim();
        let t = if t.is_empty() { r.filename.trim() } else { t };
        t.chars().take(200).collect::<String>()
    };
    if title.is_empty() {
        return Err(AppError::bad_request("invalid_title", "title is required"));
    }
    if db::used_bytes(&st.pool, u.id).await? + r.size > st.config.quota_bytes() {
        return Err(AppError::forbidden(
            "quota_exceeded",
            "storage quota exceeded",
        ));
    }

    let song_id = Uuid::new_v4();
    let key = storage::original_key(u.id, song_id, &ext);
    let (upload_id, upload_json) = match plan {
        UploadPlan::Single => {
            let PresignedPut { url, headers } = st.storage.presign_put(&key, &content_type);
            (
                None,
                json!({"mode": "single", "url": url, "headers": headers}),
            )
        }
        UploadPlan::Multipart { part_count } => {
            let id = st
                .storage
                .create_multipart(&key, &content_type)
                .await
                .map_err(AppError::bad_gateway)?;
            (
                Some(id.clone()),
                json!({"mode": "multipart", "upload_id": id, "part_size": PART_SIZE, "part_count": part_count}),
            )
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO songs (id, user_id, title, filename, content_type, size_bytes, status, model, original_key, upload_id) \
         VALUES ($1, $2, $3, $4, $5, $6, 'uploading', $7, $8, $9)",
    )
    .bind(song_id)
    .bind(u.id)
    .bind(&title)
    .bind(r.filename.chars().take(255).collect::<String>())
    .bind(&content_type)
    .bind(r.size)
    .bind(&r.model)
    .bind(&key)
    .bind(&upload_id)
    .execute(&st.pool)
    .await;
    if let Err(e) = inserted {
        if let Some(id) = &upload_id {
            let _ = st.storage.abort_multipart(&key, id).await;
        }
        return Err(e.into());
    }
    let song = song_view(&st.pool, song_id).await?;
    Ok(Json(json!({"song": song, "upload": upload_json})))
}

#[derive(Deserialize)]
struct ImportReq {
    url: String,
    #[serde(default)]
    title: String,
    model: String,
}

/// Start importing a song from a link; the download runs in the background.
async fn import_link(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Json(r): Json<ImportReq>,
) -> AppResult<Json<SongView>> {
    check_rate(&st, u.id)?;
    upload::validate_model(&r.model)?;
    let url = import::validate_url(&r.url)?;
    if db::used_bytes(&st.pool, u.id).await? >= st.config.quota_bytes() {
        return Err(AppError::forbidden(
            "quota_exceeded",
            "storage quota exceeded",
        ));
    }
    if db::active_jobs(&st.pool, u.id).await? >= st.config.max_concurrent_jobs {
        return Err(AppError::too_many(
            "too_many_jobs",
            "too many songs are processing; wait for one to finish",
        ));
    }
    // Until the download reports a title, the link is the placeholder title.
    let title: String = {
        let t = r.title.trim();
        if t.is_empty() { url.as_str() } else { t }
    }
    .chars()
    .take(200)
    .collect();
    let song_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO songs (id, user_id, title, filename, content_type, size_bytes, status, model, original_key, source_url) \
         VALUES ($1, $2, $3, '', 'application/octet-stream', 0, 'importing', $4, '', $5)",
    )
    .bind(song_id)
    .bind(u.id)
    .bind(&title)
    .bind(&r.model)
    .bind(&url)
    .execute(&st.pool)
    .await?;
    import::spawn(st.clone(), song_id);
    Ok(Json(live_view(&st, song_id).await?))
}

#[derive(Deserialize)]
struct PreviewReq {
    url: String,
}

/// Look up what a link points to (title, length, ...) without importing it.
async fn preview_link(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Json(r): Json<PreviewReq>,
) -> AppResult<Json<import::Preview>> {
    if !st.preview_limiter.check(&u.id) {
        return Err(AppError::too_many(
            "rate_limited",
            "too many link lookups, please slow down",
        ));
    }
    let url = import::validate_url(&r.url)?;
    import::preview(&st, &url)
        .await
        .map(Json)
        .map_err(|e| AppError::new(StatusCode::UNPROCESSABLE_ENTITY, "link_unavailable", e.0))
}

/// Stop a link import that is still downloading; the song is marked failed.
async fn cancel_import(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<SongView>> {
    let song = owned_song(&st.pool, u.id, id).await?;
    if song.status != SongStatus::Importing.as_str() || !import::cancel(&st, id).await {
        return Err(AppError::conflict(
            "not_importing",
            "the song is no longer importing",
        ));
    }
    Ok(Json(live_view(&st, id).await?))
}

#[derive(Deserialize)]
struct PartsReq {
    part_numbers: Vec<u16>,
}

async fn part_urls(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<PartsReq>,
) -> AppResult<Json<Value>> {
    let song = owned_song(&st.pool, u.id, id).await?;
    let (Some(upload_id), "uploading") = (song.upload_id.as_deref(), song.status.as_str()) else {
        return Err(AppError::conflict(
            "not_multipart",
            "song is not awaiting a multipart upload",
        ));
    };
    let part_count = match upload::plan_for_size(song.size_bytes) {
        UploadPlan::Multipart { part_count } => part_count,
        UploadPlan::Single => 1,
    };
    if r.part_numbers.is_empty() || r.part_numbers.len() > 200 {
        return Err(AppError::bad_request(
            "invalid_parts",
            "request between 1 and 200 parts",
        ));
    }
    if r.part_numbers
        .iter()
        .any(|&n| n == 0 || i64::from(n) > part_count)
    {
        return Err(AppError::bad_request(
            "invalid_parts",
            format!("part numbers must be in 1..={part_count}"),
        ));
    }
    let urls: Vec<Value> = r
        .part_numbers
        .iter()
        .map(|&n| json!({"part_number": n, "url": st.storage.presign_part(&song.original_key, upload_id, n)}))
        .collect();
    Ok(Json(json!({"urls": urls})))
}

#[derive(Deserialize)]
struct PartIn {
    part_number: u16,
    etag: String,
}

#[derive(Deserialize, Default)]
struct CompleteReq {
    parts: Option<Vec<PartIn>>,
}

async fn complete(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    body: Option<Json<CompleteReq>>,
) -> AppResult<Json<SongView>> {
    let req = body.map(|b| b.0).unwrap_or_default();
    let song = owned_song(&st.pool, u.id, id).await?;
    // Idempotent: anything past `uploading` just reports the current state.
    if song.status != SongStatus::Uploading.as_str() {
        return Ok(Json(song_view(&st.pool, id).await?));
    }
    check_rate(&st, u.id)?;
    if db::active_jobs(&st.pool, u.id).await? >= st.config.max_concurrent_jobs {
        return Err(AppError::too_many(
            "too_many_jobs",
            "too many songs are processing; wait for one to finish",
        ));
    }

    if let Some(upload_id) = &song.upload_id {
        let mut parts: Vec<(u16, String)> = req
            .parts
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.part_number, p.etag))
            .collect();
        parts.sort_by_key(|p| p.0);
        let expected = match upload::plan_for_size(song.size_bytes) {
            UploadPlan::Multipart { part_count } => part_count,
            UploadPlan::Single => 1,
        };
        let contiguous = parts
            .iter()
            .enumerate()
            .all(|(i, p)| usize::from(p.0) == i + 1);
        if parts.len() as i64 != expected || !contiguous || parts.iter().any(|p| p.1.is_empty()) {
            return Err(AppError::bad_request(
                "invalid_parts",
                format!("expected parts 1..={expected} with etags"),
            ));
        }
        if let Err(e) = st
            .storage
            .complete_multipart(&song.original_key, upload_id, &parts)
            .await
        {
            // A concurrent/duplicate complete may already have finished the upload.
            let fresh = owned_song(&st.pool, u.id, id).await?;
            if fresh.status != SongStatus::Uploading.as_str() {
                return Ok(Json(song_view(&st.pool, id).await?));
            }
            return Err(AppError::bad_gateway(e));
        }
    }

    // Verify what actually landed in R2: presigned PUT cannot enforce a size limit.
    let actual = st
        .storage
        .head(&song.original_key)
        .await
        .map_err(AppError::bad_gateway)?;
    let Some(actual) = actual else {
        return Err(AppError::bad_request(
            "upload_missing",
            "no uploaded file found; upload it first",
        ));
    };
    let actual = actual as i64;
    if actual != song.size_bytes || actual > st.config.max_upload_bytes() {
        let _ = st.storage.delete(&song.original_key).await;
        let (code, status, msg) = if actual > st.config.max_upload_bytes() {
            (
                "file_too_large",
                StatusCode::PAYLOAD_TOO_LARGE,
                "uploaded file exceeds the size limit",
            )
        } else {
            (
                "size_mismatch",
                StatusCode::BAD_REQUEST,
                "uploaded file size does not match the declared size",
            )
        };
        sqlx::query("UPDATE songs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status = 'uploading'")
            .bind(id)
            .bind(msg)
            .execute(&st.pool)
            .await?;
        return Err(AppError::new(status, code, msg));
    }

    jobs::enqueue_song(&st, id, SongStatus::Uploading).await?;
    Ok(Json(song_view(&st.pool, id).await?))
}

#[derive(Deserialize)]
struct ModelReq {
    model: String,
}

async fn reprocess(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<ModelReq>,
) -> AppResult<Json<SongView>> {
    upload::validate_model(&r.model)?;
    let song = owned_song(&st.pool, u.id, id).await?;
    let status = SongStatus::parse(&song.status);
    if !status.is_some_and(|s| s.can_transition_to(SongStatus::Queued)) {
        return Err(AppError::conflict(
            "invalid_state",
            "song cannot be reprocessed right now",
        ));
    }
    check_rate(&st, u.id)?;
    if db::active_jobs(&st.pool, u.id).await? >= st.config.max_concurrent_jobs {
        return Err(AppError::too_many(
            "too_many_jobs",
            "too many songs are processing; wait for one to finish",
        ));
    }
    // A failed link import never stored an original (empty key).
    if song.original_key.is_empty()
        || st
            .storage
            .head(&song.original_key)
            .await
            .map_err(AppError::bad_gateway)?
            .is_none()
    {
        return Err(AppError::conflict(
            "original_missing",
            "the original upload no longer exists",
        ));
    }
    // Remove old stems from R2 first; if that fails nothing has changed in the DB.
    st.storage
        .delete_prefix(&storage::stems_prefix(u.id, id))
        .await
        .map_err(AppError::bad_gateway)?;
    st.storage
        .delete(&storage::peaks_key(u.id, id))
        .await
        .map_err(AppError::bad_gateway)?;
    let mut tx = st.pool.begin().await?;
    let claimed = sqlx::query(
        "UPDATE songs SET status = 'queued', model = $2, error = NULL, duration_s = NULL, updated_at = now() \
         WHERE id = $1 AND status IN ('ready', 'failed')",
    )
    .bind(id)
    .bind(&r.model)
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() == 0 {
        return Err(AppError::conflict(
            "invalid_state",
            "song cannot be reprocessed right now",
        ));
    }
    sqlx::query("DELETE FROM stems WHERE song_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let job_id = jobs::insert_job(&mut tx, id, &r.model).await?;
    tx.commit().await?;
    jobs::dispatch(&st, Some(job_id)).await?;
    Ok(Json(song_view(&st.pool, id).await?))
}

async fn detail(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    owned_song(&st.pool, u.id, id).await?;
    let song = live_view(&st, id).await?;
    let (mut stems, mut peaks_url) = (Vec::new(), None);
    if song.status == SongStatus::Ready.as_str() {
        let rows: Vec<StemRow> = sqlx::query_as("SELECT * FROM stems WHERE song_id = $1")
            .bind(id)
            .fetch_all(&st.pool)
            .await?;
        for name in STEM_NAMES {
            if let Some(r) = rows.iter().find(|r| r.name == name) {
                stems.push(json!({"name": name, "url": st.storage.presign_get(&r.m4a_key, None), "size_bytes": r.m4a_size}));
            }
        }
        peaks_url = Some(st.storage.presign_get(&storage::peaks_key(u.id, id), None));
    }
    Ok(Json(
        json!({"song": song, "stems": stems, "peaks_url": peaks_url}),
    ))
}

#[derive(Deserialize)]
struct RenameReq {
    title: String,
}

async fn rename(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<RenameReq>,
) -> AppResult<Json<SongView>> {
    let title: String = r.title.trim().chars().take(200).collect();
    if title.is_empty() {
        return Err(AppError::bad_request("invalid_title", "title is required"));
    }
    let n = sqlx::query(
        "UPDATE songs SET title = $3, updated_at = now() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(u.id)
    .bind(&title)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(live_view(&st, id).await?))
}

async fn remove(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let song: SongRow = owned_song(&st.pool, u.id, id).await?;
    // Stop a running download first so it does not store anything afterwards.
    st.imports.abort(id);
    if let Some(upload_id) = &song.upload_id
        && let Err(e) = st
            .storage
            .abort_multipart(&song.original_key, upload_id)
            .await
    {
        tracing::warn!(song_id = %id, error = %e, "abort multipart failed");
    }
    st.storage
        .delete_prefix(&storage::song_prefix(u.id, id))
        .await
        .map_err(AppError::bad_gateway)?;
    sqlx::query("DELETE FROM songs WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(u.id)
        .execute(&st.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DownloadQuery {
    format: Option<String>,
}

/// `attachment; filename="ascii fallback"; filename*=UTF-8''percent-encoded`
pub fn content_disposition(title: &str, name: &str, ext: &str) -> String {
    let full = format!("{title} - {name}.{ext}");
    let ascii: String = full
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' && c != '/' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut enc = String::new();
    for b in full.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            enc.push(b as char);
        } else {
            enc.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}")
}

async fn download(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path((id, name)): Path<(Uuid, String)>,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Response> {
    let song = owned_song(&st.pool, u.id, id).await?;
    let ext = match q.format.as_deref().unwrap_or("m4a") {
        "m4a" => "m4a",
        "flac" => "flac",
        _ => {
            return Err(AppError::bad_request(
                "invalid_format",
                "format must be m4a or flac",
            ));
        }
    };
    let stem: StemRow = sqlx::query_as("SELECT * FROM stems WHERE song_id = $1 AND name = $2")
        .bind(id)
        .bind(&name)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(AppError::not_found)?;
    let key = if ext == "m4a" {
        &stem.m4a_key
    } else {
        &stem.flac_key
    };
    let url = st
        .storage
        .presign_get(key, Some(&content_disposition(&song.title, &name, ext)));
    let loc = HeaderValue::from_str(&url).map_err(AppError::internal)?;
    Ok((StatusCode::FOUND, [(header::LOCATION, loc)]).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_escapes() {
        let d = content_disposition("My \"Song\" é", "vocals", "m4a");
        assert!(d.starts_with("attachment; filename=\"My _Song_ _ - vocals.m4a\""));
        assert!(d.contains("filename*=UTF-8''My%20%22Song%22%20%C3%A9%20-%20vocals.m4a"));
    }
}
