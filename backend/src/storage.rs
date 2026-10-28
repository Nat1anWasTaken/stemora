//! Cloudflare R2 (S3-compatible) wrapper. The `Storage` trait lets tests swap in an in-memory fake.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use rusty_s3::actions::{CreateMultipartUpload, ListObjectsV2, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use uuid::Uuid;

use crate::config::Config;

/// Lifetime of presigned GET URLs handed to the player.
pub const GET_URL_TTL: Duration = Duration::from_secs(3600);
/// Lifetime of presigned upload URLs (large files on slow links need time).
pub const UPLOAD_URL_TTL: Duration = Duration::from_secs(6 * 3600);

// ---- Key building (R2 layout from docs/contract.md) ----

pub fn song_prefix(user_id: Uuid, song_id: Uuid) -> String {
    format!("users/{user_id}/songs/{song_id}/")
}
pub fn original_key(user_id: Uuid, song_id: Uuid, ext: &str) -> String {
    format!("{}original.{ext}", song_prefix(user_id, song_id))
}
pub fn stems_prefix(user_id: Uuid, song_id: Uuid) -> String {
    format!("{}stems/", song_prefix(user_id, song_id))
}
pub fn stem_key(user_id: Uuid, song_id: Uuid, name: &str, ext: &str) -> String {
    format!("{}{name}.{ext}", stems_prefix(user_id, song_id))
}
pub fn analysis_key(user_id: Uuid, song_id: Uuid) -> String {
    format!("{}analysis.json", song_prefix(user_id, song_id))
}

pub fn peaks_key(user_id: Uuid, song_id: Uuid) -> String {
    format!("{}peaks.json", song_prefix(user_id, song_id))
}

/// A presigned single-shot upload: the client must PUT with exactly these headers.
#[derive(Debug, Clone)]
pub struct PresignedPut {
    pub url: String,
    pub headers: HashMap<String, String>,
}

#[async_trait]
pub trait Storage: Send + Sync {
    /// Presigned PUT. `Content-Type` is part of the signature, so the client must send it.
    ///
    /// NOTE: S3 POST policies support `content-length-range`, but presigned PUT URLs (and R2)
    /// cannot enforce a size limit. The size is therefore enforced server-side in the
    /// `complete` handler via a HEAD request; oversize/mismatched objects are deleted.
    fn presign_put(&self, key: &str, content_type: &str) -> PresignedPut;
    fn presign_get(&self, key: &str, content_disposition: Option<&str>) -> String;
    fn presign_part(&self, key: &str, upload_id: &str, part_number: u16) -> String;
    async fn create_multipart(&self, key: &str, content_type: &str) -> Result<String>;
    /// `parts` must be (part_number, etag) sorted by part number starting at 1 without gaps.
    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u16, String)],
    ) -> Result<()>;
    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()>;
    /// Size in bytes, or None when the object does not exist.
    async fn head(&self, key: &str) -> Result<Option<u64>>;
    async fn delete(&self, key: &str) -> Result<()>;
    /// Delete every object under `prefix` (list + delete).
    async fn delete_prefix(&self, prefix: &str) -> Result<()>;
}

// ---- R2 implementation ----

pub struct R2Storage {
    bucket: Bucket,
    creds: Credentials,
    http: reqwest::Client,
}

impl R2Storage {
    pub fn new(cfg: &Config) -> Result<Self> {
        let endpoint = cfg.r2_endpoint.parse().context("invalid R2_ENDPOINT")?;
        let bucket = Bucket::new(
            endpoint,
            UrlStyle::Path,
            cfg.r2_bucket.clone(),
            cfg.r2_region.clone(),
        )
        .context("invalid R2 bucket config")?;
        Ok(Self {
            bucket,
            creds: Credentials::new(&cfg.r2_access_key_id, &cfg.r2_secret_access_key),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()?,
        })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let resp = req.send().await.context("R2 request failed")?;
        Ok(resp)
    }
}

async fn ensure_ok(resp: reqwest::Response, what: &str) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    bail!(
        "R2 {what} failed: {status} {}",
        body.chars().take(300).collect::<String>()
    )
}

#[async_trait]
impl Storage for R2Storage {
    fn presign_put(&self, key: &str, content_type: &str) -> PresignedPut {
        let mut action = self.bucket.put_object(Some(&self.creds), key);
        action
            .headers_mut()
            .insert("content-type", content_type.to_string());
        let url = action.sign(UPLOAD_URL_TTL).to_string();
        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), content_type.to_string());
        PresignedPut { url, headers }
    }

    fn presign_get(&self, key: &str, content_disposition: Option<&str>) -> String {
        let mut action = self.bucket.get_object(Some(&self.creds), key);
        if let Some(cd) = content_disposition {
            action
                .query_mut()
                .insert("response-content-disposition", cd.to_string());
        }
        action.sign(GET_URL_TTL).to_string()
    }

    fn presign_part(&self, key: &str, upload_id: &str, part_number: u16) -> String {
        self.bucket
            .upload_part(Some(&self.creds), key, part_number, upload_id)
            .sign(UPLOAD_URL_TTL)
            .to_string()
    }

    async fn create_multipart(&self, key: &str, content_type: &str) -> Result<String> {
        let mut action: CreateMultipartUpload<'_> =
            self.bucket.create_multipart_upload(Some(&self.creds), key);
        action
            .headers_mut()
            .insert("content-type", content_type.to_string());
        let url = action.sign(Duration::from_secs(300));
        let resp = self
            .send(self.http.post(url).header("content-type", content_type))
            .await?;
        let text = ensure_ok(resp, "create multipart").await?.text().await?;
        let parsed = CreateMultipartUpload::parse_response(&text)
            .map_err(|e| anyhow!("bad CreateMultipartUpload response: {e}"))?;
        Ok(parsed.upload_id().to_string())
    }

    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u16, String)],
    ) -> Result<()> {
        let action = self.bucket.complete_multipart_upload(
            Some(&self.creds),
            key,
            upload_id,
            parts.iter().map(|(_, e)| e.as_str()),
        );
        let url = action.sign(Duration::from_secs(300));
        let resp = self.send(self.http.post(url).body(action.body())).await?;
        let text = ensure_ok(resp, "complete multipart").await?.text().await?;
        // S3 may return 200 with an <Error> body.
        if text.contains("<Error>") {
            bail!(
                "R2 complete multipart failed: {}",
                text.chars().take(300).collect::<String>()
            );
        }
        Ok(())
    }

    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
        let url = self
            .bucket
            .abort_multipart_upload(Some(&self.creds), key, upload_id)
            .sign(Duration::from_secs(300));
        let resp = self.send(self.http.delete(url)).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        ensure_ok(resp, "abort multipart").await?;
        Ok(())
    }

    async fn head(&self, key: &str) -> Result<Option<u64>> {
        let url = self
            .bucket
            .head_object(Some(&self.creds), key)
            .sign(Duration::from_secs(300));
        let resp = self.send(self.http.head(url)).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = ensure_ok(resp, "head").await?;
        // Read the header directly: `Response::content_length()` is 0 for HEAD responses.
        let len = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| anyhow!("HEAD response without content-length"))?;
        Ok(Some(len))
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let url = self
            .bucket
            .delete_object(Some(&self.creds), key)
            .sign(Duration::from_secs(300));
        let resp = self.send(self.http.delete(url)).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        ensure_ok(resp, "delete").await?;
        Ok(())
    }

    async fn delete_prefix(&self, prefix: &str) -> Result<()> {
        let mut token: Option<String> = None;
        loop {
            let mut action: ListObjectsV2<'_> = self.bucket.list_objects_v2(Some(&self.creds));
            action.with_prefix(prefix);
            if let Some(t) = &token {
                action.with_continuation_token(t.clone());
            }
            let url = action.sign(Duration::from_secs(300));
            let text = ensure_ok(self.send(self.http.get(url)).await?, "list")
                .await?
                .text()
                .await?;
            let parsed = ListObjectsV2::parse_response(&text)
                .map_err(|e| anyhow!("bad ListObjectsV2 response: {e}"))?;
            for obj in &parsed.contents {
                self.delete(&obj.key).await?;
            }
            match parsed.next_continuation_token {
                Some(t) => token = Some(t),
                None => return Ok(()),
            }
        }
    }
}

// ---- In-memory fake (used by tests) ----

#[derive(Default)]
pub struct FakeStorage {
    pub objects: Mutex<HashMap<String, u64>>,
    /// upload_id -> key
    pub uploads: Mutex<HashMap<String, String>>,
    pub deleted_prefixes: Mutex<Vec<String>>,
}

impl FakeStorage {
    pub fn put(&self, key: &str, size: u64) {
        self.objects.lock().unwrap().insert(key.to_string(), size);
    }
    pub fn has(&self, key: &str) -> bool {
        self.objects.lock().unwrap().contains_key(key)
    }
}

#[async_trait]
impl Storage for FakeStorage {
    fn presign_put(&self, key: &str, content_type: &str) -> PresignedPut {
        PresignedPut {
            url: format!("http://fake-r2/{key}?X-Amz-Signature=put"),
            headers: HashMap::from([("Content-Type".to_string(), content_type.to_string())]),
        }
    }
    fn presign_get(&self, key: &str, cd: Option<&str>) -> String {
        match cd {
            Some(cd) => format!("http://fake-r2/{key}?sig=get&cd={cd}"),
            None => format!("http://fake-r2/{key}?sig=get"),
        }
    }
    fn presign_part(&self, key: &str, upload_id: &str, n: u16) -> String {
        format!("http://fake-r2/{key}?uploadId={upload_id}&partNumber={n}")
    }
    async fn create_multipart(&self, key: &str, _ct: &str) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        self.uploads
            .lock()
            .unwrap()
            .insert(id.clone(), key.to_string());
        Ok(id)
    }
    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u16, String)],
    ) -> Result<()> {
        if !self.uploads.lock().unwrap().contains_key(upload_id) {
            bail!("no such upload");
        }
        // Fake: pretend each part is 16 MiB except we trust whatever was put() before.
        let _ = parts;
        self.uploads.lock().unwrap().remove(upload_id);
        self.objects
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert(0);
        Ok(())
    }
    async fn abort_multipart(&self, _key: &str, upload_id: &str) -> Result<()> {
        self.uploads.lock().unwrap().remove(upload_id);
        Ok(())
    }
    async fn head(&self, key: &str) -> Result<Option<u64>> {
        Ok(self.objects.lock().unwrap().get(key).copied())
    }
    async fn delete(&self, key: &str) -> Result<()> {
        self.objects.lock().unwrap().remove(key);
        Ok(())
    }
    async fn delete_prefix(&self, prefix: &str) -> Result<()> {
        self.deleted_prefixes
            .lock()
            .unwrap()
            .push(prefix.to_string());
        self.objects
            .lock()
            .unwrap()
            .retain(|k, _| !k.starts_with(prefix));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_layout_matches_contract() {
        let u = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let s = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let base = "users/11111111-1111-1111-1111-111111111111/songs/22222222-2222-2222-2222-222222222222/";
        assert_eq!(song_prefix(u, s), base);
        assert_eq!(original_key(u, s, "mp3"), format!("{base}original.mp3"));
        assert_eq!(stems_prefix(u, s), format!("{base}stems/"));
        assert_eq!(
            stem_key(u, s, "vocals", "m4a"),
            format!("{base}stems/vocals.m4a")
        );
        assert_eq!(
            stem_key(u, s, "bass", "flac"),
            format!("{base}stems/bass.flac")
        );
        assert_eq!(peaks_key(u, s), format!("{base}peaks.json"));
        assert_eq!(analysis_key(u, s), format!("{base}analysis.json"));
    }

    #[test]
    fn presigned_put_binds_content_type() {
        let cfg = Config::for_tests();
        let st = R2Storage::new(&cfg).unwrap();
        let p = st.presign_put("users/a/songs/b/original.mp3", "audio/mpeg");
        assert_eq!(p.headers.get("Content-Type").unwrap(), "audio/mpeg");
        let url = url::Url::parse(&p.url).unwrap();
        assert!(
            url.path()
                .starts_with("/bucket/users/a/songs/b/original.mp3")
        );
        let signed = url
            .query_pairs()
            .find(|(k, _)| k == "X-Amz-SignedHeaders")
            .unwrap()
            .1
            .to_string();
        assert!(signed.contains("content-type"), "signed headers: {signed}");
    }

    #[test]
    fn presigned_get_has_disposition() {
        let st = R2Storage::new(&Config::for_tests()).unwrap();
        let u = st.presign_get("k", Some("attachment; filename=\"a.m4a\""));
        assert!(u.contains("response-content-disposition="));
        assert!(u.contains("X-Amz-Signature="));
    }
}
