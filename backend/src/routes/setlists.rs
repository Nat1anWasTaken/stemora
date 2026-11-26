//! Setlists: saved, ordered lists of the user's songs (docs/contract.md, docs/playback.md).

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::db::{SONG_VIEW_SELECT, SongView};
use crate::error::{AppError, AppResult};
use crate::settings;

const MAX_NAME: usize = 200;
const MAX_NOTES: usize = 1000;
const MAX_ENTRIES: usize = 500;
const SOURCES: [&str; 3] = ["song", "setlist", "listening"];
const TRANSITIONS: [&str; 2] = ["continue", "stop"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setlists", get(list).post(create))
        .route("/setlists/{id}", get(detail).patch(update).delete(remove))
        .route(
            "/setlists/{id}/entries",
            put(replace_entries).post(add_entries),
        )
        .route(
            "/setlists/{id}/entries/{entry}/settings",
            put(set_entry_settings),
        )
}

#[derive(FromRow)]
struct SetlistRow {
    id: Uuid,
    name: String,
    settings_source: String,
    transition: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    entry_count: i64,
    duration_s: Option<f64>,
}

const SETLIST_SELECT: &str = "SELECT l.id, l.name, l.settings_source, l.transition, l.created_at, l.updated_at, \
    (SELECT count(*) FROM setlist_entries e WHERE e.setlist_id = l.id) AS entry_count, \
    (SELECT sum(s.duration_s) FROM setlist_entries e JOIN songs s ON s.id = e.song_id WHERE e.setlist_id = l.id) AS duration_s \
    FROM setlists l";

fn setlist_json(r: &SetlistRow) -> Value {
    json!({
        "id": r.id, "name": r.name, "settings_source": r.settings_source, "transition": r.transition,
        "entry_count": r.entry_count, "duration_s": r.duration_s, "created_at": r.created_at, "updated_at": r.updated_at,
    })
}

#[derive(FromRow)]
struct EntryRow {
    id: Uuid,
    song_id: Uuid,
    settings: Option<String>,
    transition: Option<String>,
    notes: String,
}

async fn owned(pool: &PgPool, user: Uuid, id: Uuid) -> AppResult<SetlistRow> {
    sqlx::query_as(&format!(
        "{SETLIST_SELECT} WHERE l.id = $1 AND l.user_id = $2"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(pool)
    .await?
    .ok_or_else(AppError::not_found)
}

/// The setlist with its entries in order, each with its song as the songs API shows it.
async fn detail_json(st: &AppState, user: Uuid, id: Uuid) -> AppResult<Value> {
    let l = owned(&st.pool, user, id).await?;
    let entries: Vec<EntryRow> = sqlx::query_as(
        "SELECT id, song_id, settings::text AS settings, transition, notes FROM setlist_entries \
         WHERE setlist_id = $1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(&st.pool)
    .await?;
    let ids: Vec<Uuid> = entries.iter().map(|e| e.song_id).collect();
    let songs: Vec<SongView> = sqlx::query_as(&format!("{SONG_VIEW_SELECT} WHERE s.id = ANY($1)"))
        .bind(&ids)
        .fetch_all(&st.pool)
        .await?;
    let mut by_id: HashMap<Uuid, SongView> = songs.into_iter().map(|s| (s.id, s)).collect();
    for s in by_id.values_mut() {
        st.imports.annotate(s);
    }
    let entries: Vec<Value> = entries
        .iter()
        .filter_map(|e| {
            let song = by_id.get(&e.song_id)?;
            let settings = e.settings.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok());
            Some(json!({"id": e.id, "song": song, "settings": settings, "transition": e.transition, "notes": e.notes}))
        })
        .collect();
    Ok(json!({"setlist": setlist_json(&l), "entries": entries}))
}

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME {
        return Err(AppError::bad_request(
            "invalid_name",
            "a setlist needs a name of 1 to 200 characters",
        ));
    }
    Ok(n.to_string())
}

fn check_choice(v: &str, allowed: &[&str], code: &'static str) -> AppResult<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(AppError::bad_request(code, format!("unknown value {v:?}")))
    }
}

async fn touch(pool: &PgPool, id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE setlists SET updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Appends the user's songs among `song_ids` (others are skipped), each with a copy of its current settings.
async fn append(pool: &PgPool, user: Uuid, id: Uuid, song_ids: &[Uuid]) -> AppResult<()> {
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM setlist_entries WHERE setlist_id = $1")
            .bind(id)
            .fetch_one(pool)
            .await?;
    if count as usize + song_ids.len() > MAX_ENTRIES {
        return Err(AppError::bad_request(
            "too_many_entries",
            "a setlist holds at most 500 songs",
        ));
    }
    let mut tx = pool.begin().await?;
    let mut pos: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(position), -1) FROM setlist_entries WHERE setlist_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    for sid in song_ids {
        pos += 1;
        sqlx::query(
            "INSERT INTO setlist_entries (id, setlist_id, position, song_id, settings) \
             SELECT $1, $2, $3, s.id, s.settings FROM songs s WHERE s.id = $4 AND s.user_id = $5",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(pos)
        .bind(sid)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn list(State(st): State<AppState>, AuthUser(u): AuthUser) -> AppResult<Json<Value>> {
    let rows: Vec<SetlistRow> = sqlx::query_as(&format!(
        "{SETLIST_SELECT} WHERE l.user_id = $1 ORDER BY l.updated_at DESC, l.id"
    ))
    .bind(u.id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(
        json!({"setlists": rows.iter().map(setlist_json).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
    settings_source: Option<String>,
    transition: Option<String>,
    #[serde(default)]
    song_ids: Vec<Uuid>,
}

async fn create(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Json(r): Json<CreateReq>,
) -> AppResult<Json<Value>> {
    let name = clean_name(&r.name)?;
    let source = r.settings_source.unwrap_or_else(|| "setlist".into());
    check_choice(&source, &SOURCES, "invalid_settings_source")?;
    let transition = r.transition.unwrap_or_else(|| "stop".into());
    check_choice(&transition, &TRANSITIONS, "invalid_transition")?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO setlists (id, user_id, name, settings_source, transition) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(u.id)
        .bind(&name)
        .bind(&source)
        .bind(&transition)
        .execute(&st.pool)
        .await?;
    append(&st.pool, u.id, id, &r.song_ids).await?;
    Ok(Json(detail_json(&st, u.id, id).await?))
}

async fn detail(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    Ok(Json(detail_json(&st, u.id, id).await?))
}

#[derive(Deserialize)]
struct UpdateReq {
    name: Option<String>,
    settings_source: Option<String>,
    transition: Option<String>,
}

async fn update(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateReq>,
) -> AppResult<Json<Value>> {
    owned(&st.pool, u.id, id).await?;
    let name = r.name.as_deref().map(clean_name).transpose()?;
    if let Some(s) = &r.settings_source {
        check_choice(s, &SOURCES, "invalid_settings_source")?;
    }
    if let Some(t) = &r.transition {
        check_choice(t, &TRANSITIONS, "invalid_transition")?;
    }
    sqlx::query(
        "UPDATE setlists SET name = COALESCE($2, name), settings_source = COALESCE($3, settings_source), \
         transition = COALESCE($4, transition), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(r.settings_source)
    .bind(r.transition)
    .execute(&st.pool)
    .await?;
    Ok(Json(detail_json(&st, u.id, id).await?))
}

async fn remove(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let n = sqlx::query("DELETE FROM setlists WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(u.id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AddReq {
    song_ids: Vec<Uuid>,
}

async fn add_entries(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<AddReq>,
) -> AppResult<Json<Value>> {
    owned(&st.pool, u.id, id).await?;
    append(&st.pool, u.id, id, &r.song_ids).await?;
    touch(&st.pool, id).await?;
    Ok(Json(detail_json(&st, u.id, id).await?))
}

#[derive(Deserialize)]
struct EntryReq {
    id: Uuid,
    transition: Option<String>,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
struct ReplaceReq {
    entries: Vec<EntryReq>,
}

/// Reorders, edits and removes entries: the list is the new order, and entries left out are removed.
async fn replace_entries(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path(id): Path<Uuid>,
    Json(r): Json<ReplaceReq>,
) -> AppResult<Json<Value>> {
    owned(&st.pool, u.id, id).await?;
    let existing: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM setlist_entries WHERE setlist_id = $1")
            .bind(id)
            .fetch_all(&st.pool)
            .await?;
    let mut seen = std::collections::HashSet::new();
    for e in &r.entries {
        if !existing.contains(&e.id) || !seen.insert(e.id) {
            return Err(AppError::bad_request(
                "invalid_entry",
                "unknown or repeated entry",
            ));
        }
        if let Some(t) = &e.transition {
            check_choice(t, &TRANSITIONS, "invalid_transition")?;
        }
        if e.notes.chars().count() > MAX_NOTES {
            return Err(AppError::bad_request(
                "invalid_notes",
                "notes are at most 1000 characters",
            ));
        }
    }
    let mut tx = st.pool.begin().await?;
    let keep: Vec<Uuid> = r.entries.iter().map(|e| e.id).collect();
    sqlx::query("DELETE FROM setlist_entries WHERE setlist_id = $1 AND NOT (id = ANY($2))")
        .bind(id)
        .bind(&keep)
        .execute(&mut *tx)
        .await?;
    for (i, e) in r.entries.iter().enumerate() {
        sqlx::query(
            "UPDATE setlist_entries SET position = $2, transition = $3, notes = $4 WHERE id = $1",
        )
        .bind(e.id)
        .bind(i as i32)
        .bind(&e.transition)
        .bind(e.notes.trim())
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE setlists SET updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(detail_json(&st, u.id, id).await?))
}

async fn set_entry_settings(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Path((id, entry)): Path<(Uuid, Uuid)>,
    Json(r): Json<crate::routes::me::SettingsReq>,
) -> AppResult<Json<Value>> {
    owned(&st.pool, u.id, id).await?;
    let s = settings::normalize(&r.settings);
    let n = sqlx::query(
        "UPDATE setlist_entries SET settings = $3::jsonb WHERE id = $1 AND setlist_id = $2",
    )
    .bind(entry)
    .bind(id)
    .bind(s.to_string())
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "settings": s })))
}
