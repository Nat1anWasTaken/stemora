//! API error type: renders as `{"error": message, "code": snake_case}`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn bad_request(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, m)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        )
    }
    pub fn forbidden(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, m)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "not found")
    }
    pub fn gone(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, code, m)
    }
    pub fn conflict(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, m)
    }
    pub fn too_many(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, code, m)
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "internal error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
    pub fn bad_gateway(e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "upstream error");
        Self::new(
            StatusCode::BAD_GATEWAY,
            "upstream_error",
            "storage backend error",
        )
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.message, "code": self.code})),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(e)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(format!("{e:#}"))
    }
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .is_some_and(|c| c == "23505")
}
