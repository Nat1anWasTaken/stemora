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
    /// Cancel a spawned call (queued or running). Best effort.
    async fn cancel(&self, call_id: &str) -> Result<(), SpawnError>;
}

pub struct ModalClient {
    endpoint: String,
    cancel_endpoint: Option<String>,
    secret: String,
    http: reqwest::Client,
}

/// The `cancel` endpoint lives next to `spawn`: Modal names web endpoints
/// `https://{workspace}--{app}-{label}.modal.run`, so swap the label.
pub fn cancel_url(spawn_url: &str) -> Option<String> {
    spawn_url
        .contains("-spawn.modal.run")
        .then(|| spawn_url.replacen("-spawn.modal.run", "-cancel.modal.run", 1))
}

#[derive(Deserialize)]
struct SpawnResponse {
    call_id: String,
}

impl ModalClient {
    pub fn new(endpoint: String, secret: String) -> Self {
        Self {
            cancel_endpoint: cancel_url(&endpoint),
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

    async fn cancel(&self, call_id: &str) -> Result<(), SpawnError> {
        let Some(url) = &self.cancel_endpoint else {
            return Err(SpawnError {
                message:
                    "no Modal cancel endpoint (MODAL_ENDPOINT_URL is not a *-spawn.modal.run url)"
                        .into(),
                retryable: false,
            });
        };
        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.secret)
            .json(&serde_json::json!({ "call_id": call_id }))
            .send()
            .await
            .map_err(|e| SpawnError {
                message: format!("could not reach the processing service: {e}"),
                retryable: true,
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(SpawnError {
                message: format!("cancel returned {status}"),
                retryable: status.is_server_error(),
            });
        }
        Ok(())
    }
}

/// Test double: records requests, can be told to fail.
#[derive(Default)]
pub struct FakeModal {
    pub calls: std::sync::Mutex<Vec<SpawnRequest>>,
    pub cancelled: std::sync::Mutex<Vec<String>>,
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

    async fn cancel(&self, call_id: &str) -> Result<(), SpawnError> {
        self.cancelled.lock().unwrap().push(call_id.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_url_is_derived_from_the_spawn_url() {
        assert_eq!(
            cancel_url("https://ws--stemora-spawn.modal.run").as_deref(),
            Some("https://ws--stemora-cancel.modal.run")
        );
        assert_eq!(cancel_url("http://modal.invalid/spawn"), None);
        assert_eq!(cancel_url(""), None);
    }

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
