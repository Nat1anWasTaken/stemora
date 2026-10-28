//! Passwords (argon2), session tokens, webhook HMAC tokens and request extractors.

use argon2::Argon2;
use argon2::password_hash::{
    PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng,
};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;

pub const SESSION_COOKIE: &str = "stemora_session";
pub const SESSION_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub role: String,
}

pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("hash error: {e}"))
    })
    .await?
}

pub async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// 32 random bytes, hex encoded.
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn create_session(pool: &PgPool, user_id: Uuid) -> Result<String, AppError> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(SESSION_DAYS as i32)
    .execute(pool)
    .await?;
    Ok(token)
}

pub fn session_cookie(token: String, secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time_days(SESSION_DAYS))
        .build()
}

pub fn clear_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time_days(0))
        .build()
}

fn time_days(d: i64) -> time::Duration {
    time::Duration::days(d)
}

pub fn normalize_email(email: &str) -> Result<String, AppError> {
    let e = email.trim().to_lowercase();
    let ok = e.len() <= 254
        && e.split_once('@').is_some_and(|(l, d)| {
            !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.')
        })
        && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok {
        Ok(e)
    } else {
        Err(AppError::bad_request(
            "invalid_email",
            "invalid email address",
        ))
    }
}

pub fn validate_password(p: &str) -> Result<(), AppError> {
    if p.chars().count() < 8 || p.len() > 256 {
        return Err(AppError::bad_request(
            "weak_password",
            "password must be 8-256 characters",
        ));
    }
    Ok(())
}

// ---- Webhook tokens ----

type HmacSha256 = Hmac<Sha256>;

/// hex(HMAC-SHA256(signing_key, "{job_id}:{attempt}"))
pub fn webhook_token(signing_key: &str, job_id: Uuid, attempt: i32) -> String {
    let mut mac =
        HmacSha256::new_from_slice(signing_key.as_bytes()).expect("hmac accepts any key length");
    mac.update(format!("{job_id}:{attempt}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time check of a presented token against the expected one.
pub fn verify_webhook_token(
    signing_key: &str,
    job_id: Uuid,
    attempt: i32,
    presented: &str,
) -> bool {
    let Ok(bytes) = hex::decode(presented) else {
        return false;
    };
    let mut mac =
        HmacSha256::new_from_slice(signing_key.as_bytes()).expect("hmac accepts any key length");
    mac.update(format!("{job_id}:{attempt}").as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

// ---- Extractors ----

#[derive(Debug, Clone)]
pub struct AuthUser(pub User);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .ok_or_else(AppError::unauthorized)?
            .value()
            .to_string();
        let user: Option<User> = sqlx::query_as(
            "SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = $1 AND s.expires_at > now()",
        )
        .bind(hash_token(&token))
        .fetch_optional(&state.pool)
        .await?;
        user.map(AuthUser).ok_or_else(AppError::unauthorized)
    }
}

#[derive(Debug, Clone)]
pub struct AdminUser(pub User);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let AuthUser(u) = AuthUser::from_request_parts(parts, state).await?;
        if u.role == "admin" {
            Ok(AdminUser(u))
        } else {
            Err(AppError::forbidden("forbidden", "admin only"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_token_is_deterministic_and_bound_to_job_and_attempt() {
        let id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let t = webhook_token("secret-key-secret-key", id, 1);
        assert_eq!(t.len(), 64);
        assert_eq!(t, webhook_token("secret-key-secret-key", id, 1));
        assert_ne!(t, webhook_token("secret-key-secret-key", id, 2));
        assert_ne!(t, webhook_token("secret-key-secret-key", Uuid::nil(), 1));
        assert_ne!(t, webhook_token("other-key-other-key", id, 1));
    }

    #[test]
    fn verify_accepts_only_exact_token() {
        let id = Uuid::new_v4();
        let k = "secret-key-secret-key";
        let t = webhook_token(k, id, 3);
        assert!(verify_webhook_token(k, id, 3, &t));
        assert!(!verify_webhook_token(k, id, 2, &t));
        assert!(!verify_webhook_token(k, id, 3, "zz"));
        assert!(!verify_webhook_token(k, id, 3, ""));
        assert!(!verify_webhook_token(k, id, 3, &t[..62]));
    }

    #[test]
    fn session_tokens_hash_stably() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, random_token());
        assert_eq!(hash_token(&t), hash_token(&t));
        assert_eq!(hash_token(&t).len(), 32);
    }

    #[test]
    fn email_and_password_rules() {
        assert_eq!(normalize_email("  Foo@Bar.COM ").unwrap(), "foo@bar.com");
        assert!(normalize_email("nope").is_err());
        assert!(normalize_email("a@b").is_err());
        assert!(validate_password("short").is_err());
        assert!(validate_password("longenough").is_ok());
    }

    #[tokio::test]
    async fn argon2_roundtrip() {
        let h = hash_password("hunter2hunter2".into()).await.unwrap();
        assert!(verify_password("hunter2hunter2".into(), h.clone()).await);
        assert!(!verify_password("wrong".into(), h).await);
    }
}
