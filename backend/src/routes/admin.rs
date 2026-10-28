use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::FromRow;

use crate::AppState;
use crate::auth::{AdminUser, hash_token, random_token};
use crate::error::AppResult;

pub const INVITE_DAYS: i32 = 7;

pub fn router() -> Router<AppState> {
    Router::new().route("/admin/invites", post(create_invite).get(list_invites))
}

async fn create_invite(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
) -> AppResult<Json<Value>> {
    let token = random_token();
    let (expires_at,): (chrono::DateTime<chrono::Utc>,) = sqlx::query_as(
        "INSERT INTO invites (token_hash, created_by, expires_at) VALUES ($1, $2, now() + make_interval(days => $3)) \
         RETURNING expires_at",
    )
    .bind(hash_token(&token))
    .bind(admin.id)
    .bind(INVITE_DAYS)
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(json!({
        "token": token,
        "url": format!("{}/invite/{token}", st.config.public_base_url),
        "expires_at": expires_at,
    })))
}

#[derive(Serialize, FromRow)]
struct InviteRow {
    /// Short non-secret identifier (token itself is only shown at creation).
    id: String,
    created_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
    used_at: Option<chrono::DateTime<chrono::Utc>>,
    used_by_email: Option<String>,
    status: String,
}

async fn list_invites(
    State(st): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<InviteRow>>> {
    let rows = sqlx::query_as(
        "SELECT substr(encode(i.token_hash, 'hex'), 1, 12) AS id, i.created_at, i.expires_at, i.used_at, \
                u.email AS used_by_email, \
                CASE WHEN i.used_at IS NOT NULL THEN 'used' WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END AS status \
         FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200",
    )
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}
