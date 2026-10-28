//! Client for the Modal `spawn` web endpoint (see docs/contract.md).

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct SpawnRequest {
    pub job_id: Uuid,
    pub attempt: i32,
    pub user_id: Uuid,
    pub song_id: Uuid,
    pub original_key: String,
    pub model: String,
    pub callback_url: String,
    pub callback_token: String,
    pub max_duration_s: u32,
}

#[derive(Debug, Clone)]
pub struct SpawnError {
    pub message: String,
    /// Whether a later attempt could plausibly succeed.
    pub retryable: bool,
}

#[async_trait]
pub trait Modal: Send + Sync {
    /// Returns the Modal function call id.
    async fn spawn(&self, req: &SpawnRequest) -> Result<String, SpawnError>;
}

pub struct ModalClient {
    endpoint: String,
    secret: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct SpawnResponse {
    call_id: String,
}

impl ModalClient {
    pub fn new(endpoint: String, secret: String) -> Self {
        Self {
            endpoint,
            secret,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
        }
    }
}

#[async_trait]
impl Modal for ModalClient {
    async fn spawn(&self, req: &SpawnRequest) -> Result<String, SpawnError> {
        if self.endpoint.is_empty() {
            return Err(SpawnError {
                message:
                    "Processing is not configured on this server (MODAL_ENDPOINT_URL is empty)"
                        .into(),
                retryable: false,
            });
        }
        let resp = self
            .http
            .post(&self.endpoint)
            .bearer_auth(&self.secret)
            .json(req)
            .send()
            .await
            .map_err(|e| SpawnError {
                message: format!("could not reach the processing service: {e}"),
                retryable: true,
            })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(SpawnError {
                message: format!(
                    "processing service returned {status}: {}",
                    body.chars().take(200).collect::<String>()
                ),
                retryable: status.is_server_error()
                    || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status == reqwest::StatusCode::REQUEST_TIMEOUT,
            });
        }
        let parsed: SpawnResponse = resp.json().await.map_err(|e| SpawnError {
            message: format!("bad response from processing service: {e}"),
            retryable: true,
        })?;
        Ok(parsed.call_id)
    }
}

/// Test double: records requests, can be told to fail.
#[derive(Default)]
pub struct FakeModal {
    pub calls: std::sync::Mutex<Vec<SpawnRequest>>,
    pub fail_with: std::sync::Mutex<Option<SpawnError>>,
}

#[async_trait]
impl Modal for FakeModal {
    async fn spawn(&self, req: &SpawnRequest) -> Result<String, SpawnError> {
        if let Some(e) = self.fail_with.lock().unwrap().clone() {
            return Err(e);
        }
        let mut calls = self.calls.lock().unwrap();
        calls.push(req.clone());
        Ok(format!("fc-test-{}", calls.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_endpoint_is_a_clear_non_retryable_error() {
        let c = ModalClient::new(String::new(), String::new());
        let req = SpawnRequest {
            job_id: Uuid::nil(),
            attempt: 1,
            user_id: Uuid::nil(),
            song_id: Uuid::nil(),
            original_key: "k".into(),
            model: "htdemucs".into(),
            callback_url: "u".into(),
            callback_token: "t".into(),
            max_duration_s: 900,
        };
        let e = c.spawn(&req).await.unwrap_err();
        assert!(!e.retryable);
        assert!(e.message.contains("MODAL_ENDPOINT_URL"));
    }
}
