//! Importing a song from a link: yt-dlp download on this server, upload to R2, then the
//! normal job flow (see docs/contract.md).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::AppState;
use crate::config::Config;
use crate::db::{self, SongRow, SongView};
use crate::error::{AppError, AppResult};
use crate::fetch::{DownloadProgress, FetchError, MediaInfo, too_large};
use crate::jobs::{self, SongStatus};
use crate::storage;

pub const MAX_URL_LEN: usize = 2048;

/// Extensions yt-dlp may hand back beyond those accepted for uploads; the worker's ffmpeg
/// decodes the audio stream of these containers too.
const EXTRA_EXTENSIONS: &[&str] = &["mp4", "mkv", "mka", "oga", "mov", "flv", "ts"];

/// Syntactic checks done before accepting an import (DNS checks happen in the fetcher).
pub fn validate_url(raw: &str) -> AppResult<String> {
    let invalid = |m: &str| AppError::bad_request("invalid_url", m);
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_LEN {
        return Err(invalid("enter a link of at most 2048 characters"));
    }
    let u = url::Url::parse(raw).map_err(|_| invalid("not a valid link"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(invalid("only http(s) links are supported"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(invalid("links with credentials are not supported"));
    }
    let private = match u.host() {
        None => return Err(invalid("the link has no host")),
        Some(url::Host::Ipv4(ip)) => !crate::fetch::is_public(ip.into()),
        Some(url::Host::Ipv6(ip)) => !crate::fetch::is_public(ip.into()),
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost") || !d.contains('.')
        }
    };
    if private {
        return Err(invalid("links to private addresses are not allowed"));
    }
    Ok(u.to_string())
}

fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "webm" => "audio/webm",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "mka" => "audio/x-matroska",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// What a running import is doing; reported as the song's `stage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportStage {
    /// Waiting for one of the `MAX_CONCURRENT_IMPORTS` download slots.
    Waiting,
    /// Reading the link's details.
    Probing,
    Downloading,
    /// Uploading the downloaded audio to storage.
    Storing,
}

impl ImportStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Storing => "storing",
        }
    }
}

struct Tracked {
    stage: ImportStage,
    download: Option<DownloadProgress>,
    abort: Option<AbortHandle>,
}

/// Live state of the imports running in this process (they are in-process tasks, so it does not
/// need to outlive it: songs still `importing` at startup go back to the queue).
#[derive(Default)]
pub struct ImportTracker(Mutex<HashMap<Uuid, Tracked>>);

impl ImportTracker {
    fn update(&self, id: Uuid, f: impl FnOnce(&mut Tracked)) {
        if let Some(t) = self.0.lock().unwrap().get_mut(&id) {
            f(t);
        }
    }

    fn set_stage(&self, id: Uuid, stage: ImportStage) {
        self.update(id, |t| t.stage = stage);
    }

    fn remove(&self, id: Uuid) -> Option<Tracked> {
        self.0.lock().unwrap().remove(&id)
    }

    /// Stop a running import (its yt-dlp process is killed and its files removed).
    /// Returns whether one was running.
    pub fn abort(&self, id: Uuid) -> bool {
        match self.remove(id) {
            Some(t) => {
                if let Some(a) = t.abort {
                    a.abort();
                }
                true
            }
            None => false,
        }
    }

    /// Fill in the live stage and download progress of a song that is still importing.
    pub fn annotate(&self, song: &mut SongView) {
        if song.status != "importing" {
            return;
        }
        if let Some(t) = self.0.lock().unwrap().get(&song.id) {
            song.stage = Some(t.stage.as_str().into());
            song.download = t.download.clone();
            song.progress = match (t.stage, &t.download) {
                (ImportStage::Storing, _) => 100,
                (
                    _,
                    Some(DownloadProgress {
                        downloaded_bytes,
                        total_bytes: Some(total),
                        ..
                    }),
                ) => (*downloaded_bytes as f64 / *total as f64 * 100.0).clamp(0.0, 100.0) as i32,
                _ => 0,
            };
        }
    }
}

/// Why `info` cannot be imported under `cfg`, if it cannot.
pub fn check_info(info: &MediaInfo, cfg: &Config) -> Result<(), FetchError> {
    if info.is_playlist {
        return Err(FetchError(
            "Playlists are not supported; use a link to one song.".into(),
        ));
    }
    if info.is_live {
        return Err(FetchError("Live streams cannot be imported.".into()));
    }
    if let Some(d) = info.duration_s
        && d > f64::from(cfg.max_duration_s)
    {
        return Err(FetchError(format!(
            "Audio is {:.1} min long; the maximum is {:.1} min.",
            d / 60.0,
            f64::from(cfg.max_duration_s) / 60.0
        )));
    }
    let max_bytes = cfg.max_upload_bytes() as u64;
    if info.filesize.is_some_and(|s| s > max_bytes) {
        return Err(too_large(max_bytes));
    }
    Ok(())
}

/// What a link points to, shown before importing it.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub title: Option<String>,
    pub duration_s: Option<f64>,
    pub uploader: Option<String>,
    pub site: Option<String>,
    pub filesize: Option<u64>,
    /// Why importing it would fail, if it would.
    pub problem: Option<String>,
}

pub async fn preview(state: &AppState, url: &str) -> Result<Preview, FetchError> {
    let _permit = state.probe_slots.acquire().await;
    let info = tokio::time::timeout(Duration::from_secs(60), state.fetcher.probe(url))
        .await
        .map_err(|_| FetchError("The site took too long to answer.".into()))??;
    Ok(Preview {
        problem: check_info(&info, &state.config).err().map(|e| e.0),
        title: info.title,
        duration_s: info.duration_s,
        uploader: info.uploader,
        site: info.site,
        filesize: info.filesize,
    })
}

/// Removes the temporary download directory however the import ends.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run an import in the background. The song must be `importing`.
pub fn spawn(state: AppState, song_id: Uuid) {
    state.imports.0.lock().unwrap().insert(
        song_id,
        Tracked {
            stage: ImportStage::Waiting,
            download: None,
            abort: None,
        },
    );
    let st = state.clone();
    let task = tokio::spawn(async move {
        let _permit = st.import_slots.clone().acquire_owned().await;
        let limit = Duration::from_secs(st.config.import_timeout_s);
        match tokio::time::timeout(limit, run(&st, song_id)).await {
            Ok(r) => r,
            Err(_) => Err(FetchError(format!(
                "The import took longer than {} minutes.",
                limit.as_secs().div_ceil(60)
            ))),
        }
    });
    let abort = task.abort_handle();
    state.imports.update(song_id, |t| t.abort = Some(abort));
    tokio::spawn(async move {
        let outcome = match task.await {
            Ok(r) => r,
            // Cancelled or deleted: whoever aborted it has updated the song.
            Err(e) if e.is_cancelled() => Ok(()),
            Err(e) => {
                tracing::error!(%song_id, error = %e, "import task panicked");
                Err(FetchError("The import failed unexpectedly.".into()))
            }
        };
        state.imports.remove(song_id);
        if let Err(e) = outcome
            && let Some(user_id) = fail(&state, song_id, &e.0).await
        {
            // The import no longer holds one of the user's slots. Boxed as a `dyn Send` future:
            // the pump spawns imports, so naming its future type here would be a cycle.
            let next: std::pin::Pin<Box<dyn Future<Output = ()> + Send + '_>> =
                Box::pin(jobs::pump_logged(&state, user_id));
            next.await;
        }
    });
}

/// Stop an import and mark the song failed. Returns false if it was no longer importing.
pub async fn cancel(state: &AppState, song_id: Uuid) -> bool {
    state.imports.abort(song_id);
    fail(state, song_id, "The import was cancelled.")
        .await
        .is_some()
}

/// Mark an importing song failed and remove anything it stored. Returns its owner, or None if
/// it was no longer importing.
async fn fail(state: &AppState, song_id: Uuid, message: &str) -> Option<Uuid> {
    tracing::warn!(%song_id, error = %message, "import failed");
    let row: Result<Option<(Uuid,)>, _> = sqlx::query_as(
        "UPDATE songs SET status = 'failed', error = $2, updated_at = now() \
         WHERE id = $1 AND status = 'importing' RETURNING user_id",
    )
    .bind(song_id)
    .bind(message.chars().take(2000).collect::<String>())
    .fetch_optional(&state.pool)
    .await;
    match row {
        Ok(Some((user_id,))) => {
            // Nothing useful can be left behind (a partial or rejected original).
            if let Err(e) = state
                .storage
                .delete_prefix(&storage::song_prefix(user_id, song_id))
                .await
            {
                tracing::warn!(%song_id, error = %e, "could not clean up failed import");
            }
            Some(user_id)
        }
        Ok(None) => None,
        Err(e) => {
            tracing::error!(%song_id, error = %e, "could not record import failure");
            None
        }
    }
}

async fn run(state: &AppState, song_id: Uuid) -> Result<(), FetchError> {
    let db_err = |e: sqlx::Error| {
        tracing::error!(%song_id, error = %e, "import database error");
        FetchError("A server error interrupted the import.".into())
    };
    let song: Option<SongRow> =
        sqlx::query_as("SELECT * FROM songs WHERE id = $1 AND status = 'importing'")
            .bind(song_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(db_err)?;
    // Deleted (or otherwise moved on) while waiting for a slot.
    let Some(song) = song else { return Ok(()) };
    let url = song.source_url.clone().unwrap_or_default();
    let cfg = &state.config;
    let max_bytes = cfg.max_upload_bytes() as u64;

    state.imports.set_stage(song_id, ImportStage::Probing);
    let info = state.fetcher.probe(&url).await?;
    // Show what the link is as soon as it is known, even if it then cannot be imported.
    let fetched_title: Option<String> = info.title.as_ref().map(|t| t.chars().take(200).collect());
    sqlx::query(
        "UPDATE songs SET duration_s = COALESCE($2, duration_s), \
         title = CASE WHEN $3::text IS NOT NULL AND title = left(source_url, 200) THEN $3 ELSE title END, \
         updated_at = now() WHERE id = $1 AND status = 'importing'",
    )
    .bind(song_id)
    .bind(info.duration_s)
    .bind(&fetched_title)
    .execute(&state.pool)
    .await
    .map_err(db_err)?;
    check_info(&info, cfg)?;

    let dir = TempDir(std::env::temp_dir().join(format!("stemora-import-{song_id}")));
    let _ = std::fs::remove_dir_all(&dir.0);
    std::fs::create_dir_all(&dir.0).map_err(|e| {
        tracing::error!(error = %e, "could not create import directory");
        FetchError("A server error interrupted the import.".into())
    })?;
    state.imports.set_stage(song_id, ImportStage::Downloading);
    let report = |p: DownloadProgress| state.imports.update(song_id, |t| t.download = Some(p));
    let path = state
        .fetcher
        .download(&url, &dir.0, max_bytes, &report)
        .await?;
    state.imports.set_stage(song_id, ImportStage::Storing);
    store(state, &song, &path, fetched_title.as_deref(), max_bytes).await
}

async fn store(
    state: &AppState,
    song: &SongRow,
    path: &Path,
    fetched_title: Option<&str>,
    max_bytes: u64,
) -> Result<(), FetchError> {
    let server_err = |e: &dyn std::fmt::Display| {
        tracing::error!(song_id = %song.id, error = %e, "import storage error");
        FetchError("A server error interrupted the import.".into())
    };
    let size = std::fs::metadata(path).map_err(|e| server_err(&e))?.len();
    if size == 0 {
        return Err(FetchError("The downloaded file is empty.".into()));
    }
    if size > max_bytes {
        return Err(too_large(max_bytes));
    }
    let ext = crate::upload::extension_of(&path.to_string_lossy())
        .filter(|e| {
            crate::upload::ALLOWED_EXTENSIONS.contains(&e.as_str())
                || EXTRA_EXTENSIONS.contains(&e.as_str())
        })
        .ok_or_else(|| FetchError("The site returned a format that is not audio.".into()))?;
    let used = db::used_bytes(&state.pool, song.user_id)
        .await
        .map_err(|e| server_err(&e))?;
    if used + size as i64 > state.config.quota_bytes() {
        return Err(FetchError("Storage quota exceeded.".into()));
    }

    let key = storage::original_key(song.user_id, song.id, &ext);
    let content_type = content_type_for(&ext);
    state
        .storage
        .put_file(&key, path, content_type)
        .await
        .map_err(|e| server_err(&e))?;

    // Keep a title the user typed; replace the placeholder (the link itself) with the fetched one.
    let filename: String = format!("{}.{ext}", fetched_title.unwrap_or("original"))
        .chars()
        .take(255)
        .collect();
    let updated = sqlx::query(
        "UPDATE songs SET original_key = $2, size_bytes = $3, content_type = $4, filename = $5, \
         title = CASE WHEN $6::text IS NOT NULL AND title = left(source_url, 200) THEN $6 ELSE title END, \
         updated_at = now() WHERE id = $1 AND status = 'importing'",
    )
    .bind(song.id)
    .bind(&key)
    .bind(size as i64)
    .bind(content_type)
    .bind(&filename)
    .bind(fetched_title)
    .execute(&state.pool)
    .await
    .map_err(|e| server_err(&e))?;
    if updated.rows_affected() == 0 {
        // Deleted during the download: do not leave the object behind.
        let _ = state.storage.delete(&key).await;
        return Ok(());
    }
    jobs::enqueue_song(state, song.id, SongStatus::Importing)
        .await
        .map_err(|e| server_err(&e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation() {
        for ok in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "  https://soundcloud.com/artist/track  ",
            "http://example.com/a.mp3",
        ] {
            assert!(validate_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "youtube.com/watch?v=x",
            "ftp://example.com/a.mp3",
            "file:///etc/passwd",
            "http://localhost:8080/",
            "http://127.0.0.1/",
            "http://10.0.0.5/a",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data",
            "http://intranet/",
            "https://user:pw@example.com/",
        ] {
            let e = validate_url(bad).unwrap_err();
            assert_eq!(e.code, "invalid_url", "{bad}");
        }
        assert!(validate_url(&format!("https://example.com/{}", "a".repeat(2100))).is_err());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for("webm"), "audio/webm");
        assert_eq!(content_type_for("m4a"), "audio/mp4");
        assert_eq!(content_type_for("xyz"), "application/octet-stream");
    }
}
