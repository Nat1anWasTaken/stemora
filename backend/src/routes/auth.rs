use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::auth::*;
use crate::error::{AppError, AppResult, is_unique_violation};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/status", get(status))
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me).patch(update_me))
        .route("/invites/{token}", get(invite_valid))
        .route("/auth/accept-invite", post(accept_invite))
}

async fn status(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM users")
        .fetch_one(&st.pool)
        .await?;
    Ok(Json(json!({"needs_bootstrap": n == 0})))
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

fn with_session(
    st: &AppState,
    jar: CookieJar,
    token: String,
    user: User,
) -> (CookieJar, Json<User>) {
    (
        jar.add(session_cookie(token, st.config.cookie_secure)),
        Json(user),
    )
}

async fn bootstrap(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(c): Json<Credentials>,
) -> AppResult<(CookieJar, Json<User>)> {
    let email = normalize_email(&c.email)?;
    validate_password(&c.password)?;
    let hash = hash_password(c.password).await?;
    let mut tx = st.pool.begin().await?;
    // Serialise concurrent bootstrap attempts.
    sqlx::query("SELECT pg_advisory_xact_lock(7311001)")
        .execute(&mut *tx)
        .await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if n > 0 {
        return Err(AppError::forbidden(
            "already_bootstrapped",
            "setup already completed",
        ));
    }
    let user: User = sqlx::query_as(
        "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id, email, role",
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .bind(&hash)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let token = create_session(&st.pool, user.id).await?;
    Ok(with_session(&st, jar, token, user))
}

async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(c): Json<Credentials>,
) -> AppResult<(CookieJar, Json<User>)> {
    let email = c.email.trim().to_lowercase();
    if !st.login_limiter.check(&email) {
        return Err(AppError::too_many(
            "rate_limited",
            "too many login attempts, try again later",
        ));
    }
    let row: Option<(Uuid, String, String, String)> =
        sqlx::query_as("SELECT id, email, role, password_hash FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&st.pool)
            .await?;
    // Always run a verification so response time does not reveal whether the email exists.
    let (user, hash) = match row {
        Some((id, email, role, hash)) => (Some(User { id, email, role }), hash),
        None => (None, hash_password(c.password.clone()).await?),
    };
    let ok = verify_password(c.password, hash).await;
    match user {
        Some(u) if ok => {
            let token = create_session(&st.pool, u.id).await?;
            Ok(with_session(&st, jar, token, u))
        }
        _ => Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "invalid email or password",
        )),
    }
}

async fn logout(State(st): State<AppState>, jar: CookieJar) -> AppResult<(CookieJar, StatusCode)> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(hash_token(c.value()))
            .execute(&st.pool)
            .await?;
    }
    Ok((
        jar.add(clear_cookie(st.config.cookie_secure)),
        StatusCode::NO_CONTENT,
    ))
}

async fn me(AuthUser(u): AuthUser) -> Json<User> {
    Json(u)
}

#[derive(Deserialize)]
struct UpdateMeReq {
    current_password: String,
    email: Option<String>,
    new_password: Option<String>,
}

/// Change the signed-in user's email and/or password. Requires the current password;
/// a password change signs out every other session.
async fn update_me(
    State(st): State<AppState>,
    AuthUser(u): AuthUser,
    jar: CookieJar,
    Json(r): Json<UpdateMeReq>,
) -> AppResult<Json<User>> {
    let (hash,): (String,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
        .bind(u.id)
        .fetch_one(&st.pool)
        .await?;
    if !verify_password(r.current_password, hash).await {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "current password is incorrect",
        ));
    }
    let email = r.email.as_deref().map(normalize_email).transpose()?;
    let new_hash = match r.new_password {
        Some(p) => {
            validate_password(&p)?;
            Some(hash_password(p).await?)
        }
        None => None,
    };
    let mut tx = st.pool.begin().await?;
    let user: User = match sqlx::query_as(
        "UPDATE users SET email = COALESCE($2, email), password_hash = COALESCE($3, password_hash) WHERE id = $1 RETURNING id, email, role",
    )
    .bind(u.id)
    .bind(&email)
    .bind(&new_hash)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(u) => u,
        Err(e) if is_unique_violation(&e) => return Err(AppError::conflict("email_taken", "an account with that email already exists")),
        Err(e) => return Err(e.into()),
    };
    if new_hash.is_some() {
        let current = jar.get(SESSION_COOKIE).map(|c| hash_token(c.value()));
        sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2")
            .bind(u.id)
            .bind(current)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(user))
}

async fn invite_valid(
    State(st): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<Value>> {
    let (valid,): (bool,) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now())",
    )
    .bind(hash_token(&token))
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(json!({"valid": valid})))
}

#[derive(Deserialize)]
struct AcceptReq {
    token: String,
    email: String,
    password: String,
}

async fn accept_invite(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(r): Json<AcceptReq>,
) -> AppResult<(CookieJar, Json<User>)> {
    let email = normalize_email(&r.email)?;
    validate_password(&r.password)?;
    let hash = hash_password(r.password).await?;
    let mut tx = st.pool.begin().await?;
    let invalid = || {
        AppError::bad_request(
            "invalid_invite",
            "invite is invalid, expired or already used",
        )
    };
    // Claim the invite first (row lock makes this safe against concurrent use).
    let claimed = sqlx::query(
        "UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    )
    .bind(hash_token(&r.token))
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() == 0 {
        return Err(invalid());
    }
    let user: User = match sqlx::query_as(
        "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user') RETURNING id, email, role",
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .bind(&hash)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(u) => u,
        Err(e) if is_unique_violation(&e) => return Err(AppError::conflict("email_taken", "an account with that email already exists")),
        Err(e) => return Err(e.into()),
    };
    sqlx::query("UPDATE invites SET used_by = $2 WHERE token_hash = $1")
        .bind(hash_token(&r.token))
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let token = create_session(&st.pool, user.id).await?;
    Ok(with_session(&st, jar, token, user))
}
