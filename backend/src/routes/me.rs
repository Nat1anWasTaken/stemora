use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::settings;

pub fn router() -> Router<AppState> {
    Router::new().route("/me/listening-settings", get(listening).put(set_listening))
}

#[derive(Deserialize)]
pub struct SettingsReq {
    pub settings: Value,
}

/// The user's one listening settings set, or null when it was never saved.
async fn listening(State(st): State<AppState>, AuthUser(u): AuthUser) -> AppResult<Json<Value>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT listening_settings::text FROM users WHERE id = $1")
            .bind(u.id)
            .fetch_one(&st.pool)
            .await?;
    let s = raw.and_then(|r| serde_json::from_str::<Value>(&r).ok());
    Ok(Json(json!({ "settings": s })))
}

async fn set_listening(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    Json(r): Json<SettingsReq>,
) -> AppResult<Json<Value>> {
    let s = settings::normalize(&r.settings);
    sqlx::query("UPDATE users SET listening_settings = $2::jsonb WHERE id = $1")
        .bind(u.id)
        .bind(s.to_string())
        .execute(&st.pool)
        .await?;
    Ok(Json(json!({ "settings": s })))
}
