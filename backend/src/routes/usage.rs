use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::AuthUser;
use crate::db;
use crate::error::AppResult;

pub fn router() -> Router<AppState> {
    Router::new().route("/me/usage", get(usage))
}

async fn usage(State(st): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let used = db::used_bytes(&st.pool, user.id).await?;
    Ok(Json(
        json!({"used_bytes": used, "quota_bytes": st.config.quota_bytes()}),
    ))
}
