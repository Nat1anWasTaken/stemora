//! Environment-driven configuration (see docs/contract.md for the variable list).

use thiserror::Error;

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required environment variable {0}")]
    Missing(&'static str),
    #[error("invalid value for {0}: {1}")]
    Invalid(&'static str, String),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    /// Public origin of the app, without a trailing slash.
    pub public_base_url: String,
    pub bind_addr: String,
    pub r2_endpoint: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,
    pub r2_bucket: String,
    pub r2_region: String,
    /// Empty means Modal is not configured: jobs fail with a clear error.
    pub modal_endpoint_url: String,
    pub modal_shared_secret: String,
    pub webhook_signing_key: String,
    pub max_upload_mb: u64,
    pub max_duration_s: u32,
    pub user_quota_mb: u64,
    pub max_concurrent_jobs: i64,
    pub cookie_secure: bool,
    /// yt-dlp executable used to import songs from links.
    pub ytdlp_path: String,
    /// Imports (yt-dlp downloads) running at once across all users.
    pub max_concurrent_imports: usize,
    pub import_timeout_s: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build a config from an arbitrary key lookup (used by tests).
    pub fn from_lookup<F: Fn(&str) -> Option<String>>(get: F) -> Result<Self, ConfigError> {
        let opt = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let req = |k: &'static str| opt(k).ok_or(ConfigError::Missing(k));
        fn num<T: std::str::FromStr>(
            v: Option<String>,
            k: &'static str,
            default: T,
        ) -> Result<T, ConfigError> {
            match v {
                None => Ok(default),
                Some(s) => s
                    .parse()
                    .map_err(|_| ConfigError::Invalid(k, format!("not a valid number: {s}"))),
            }
        }

        let public_base_url = req("PUBLIC_BASE_URL")?.trim_end_matches('/').to_string();
        if !(public_base_url.starts_with("http://") || public_base_url.starts_with("https://")) {
            return Err(ConfigError::Invalid(
                "PUBLIC_BASE_URL",
                "must start with http:// or https://".into(),
            ));
        }
        let webhook_signing_key = req("WEBHOOK_SIGNING_KEY")?;
        if webhook_signing_key.len() < 16 {
            return Err(ConfigError::Invalid(
                "WEBHOOK_SIGNING_KEY",
                "must be at least 16 characters".into(),
            ));
        }
        let cookie_secure = match opt("COOKIE_SECURE").map(|v| v.to_lowercase()) {
            None => public_base_url.starts_with("https://"),
            Some(v) if ["1", "true", "yes", "on"].contains(&v.as_str()) => true,
            Some(v) if ["0", "false", "no", "off"].contains(&v.as_str()) => false,
            Some(v) => return Err(ConfigError::Invalid("COOKIE_SECURE", v)),
        };
        let max_concurrent_jobs: i64 = num(opt("MAX_CONCURRENT_JOBS"), "MAX_CONCURRENT_JOBS", 2)?;
        if max_concurrent_jobs < 1 {
            return Err(ConfigError::Invalid(
                "MAX_CONCURRENT_JOBS",
                "must be >= 1".into(),
            ));
        }
        let max_concurrent_imports: usize =
            num(opt("MAX_CONCURRENT_IMPORTS"), "MAX_CONCURRENT_IMPORTS", 2)?;
        if max_concurrent_imports < 1 {
            return Err(ConfigError::Invalid(
                "MAX_CONCURRENT_IMPORTS",
                "must be >= 1".into(),
            ));
        }
        Ok(Config {
            database_url: req("DATABASE_URL")?,
            public_base_url,
            bind_addr: opt("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into()),
            r2_endpoint: req("R2_ENDPOINT")?,
            r2_access_key_id: req("R2_ACCESS_KEY_ID")?,
            r2_secret_access_key: req("R2_SECRET_ACCESS_KEY")?,
            r2_bucket: req("R2_BUCKET")?,
            r2_region: opt("R2_REGION").unwrap_or_else(|| "auto".into()),
            modal_endpoint_url: opt("MODAL_ENDPOINT_URL").unwrap_or_default(),
            modal_shared_secret: opt("MODAL_SHARED_SECRET").unwrap_or_default(),
            webhook_signing_key,
            max_upload_mb: num(opt("MAX_UPLOAD_MB"), "MAX_UPLOAD_MB", 200)?,
            max_duration_s: num(opt("MAX_DURATION_S"), "MAX_DURATION_S", 900)?,
            user_quota_mb: num(opt("USER_QUOTA_MB"), "USER_QUOTA_MB", 5000)?,
            max_concurrent_jobs,
            cookie_secure,
            ytdlp_path: opt("YTDLP_PATH").unwrap_or_else(|| "yt-dlp".into()),
            max_concurrent_imports,
            import_timeout_s: num(opt("IMPORT_TIMEOUT_S"), "IMPORT_TIMEOUT_S", 600)?,
        })
    }

    pub fn max_upload_bytes(&self) -> i64 {
        (self.max_upload_mb * MIB) as i64
    }

    pub fn quota_bytes(&self) -> i64 {
        (self.user_quota_mb * MIB) as i64
    }

    pub fn callback_url(&self, job_id: uuid::Uuid) -> String {
        format!("{}/api/webhooks/jobs/{job_id}", self.public_base_url)
    }

    /// A config suitable for tests.
    pub fn for_tests() -> Self {
        Config::from_lookup(|k| {
            let v = match k {
                "DATABASE_URL" => "postgres://localhost/x",
                "PUBLIC_BASE_URL" => "http://localhost:8080",
                "R2_ENDPOINT" => "http://localhost:9000",
                "R2_ACCESS_KEY_ID" => "key",
                "R2_SECRET_ACCESS_KEY" => "secret",
                "R2_BUCKET" => "bucket",
                "WEBHOOK_SIGNING_KEY" => "test-signing-key-0123456789",
                "MODAL_ENDPOINT_URL" => "http://modal.invalid/spawn",
                "MODAL_SHARED_SECRET" => "modal-secret",
                _ => return None,
            };
            Some(v.to_string())
        })
        .expect("test config")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(extra: &[(&str, &str)], drop: &[&str]) -> Result<Config, ConfigError> {
        let mut m: HashMap<String, String> = HashMap::new();
        for (k, v) in [
            ("DATABASE_URL", "postgres://x"),
            ("PUBLIC_BASE_URL", "https://stemora.example.com/"),
            ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
            ("R2_ACCESS_KEY_ID", "a"),
            ("R2_SECRET_ACCESS_KEY", "b"),
            ("R2_BUCKET", "stemora"),
            ("WEBHOOK_SIGNING_KEY", "0123456789abcdef0123"),
        ] {
            m.insert(k.into(), v.into());
        }
        for (k, v) in extra {
            m.insert((*k).into(), (*v).into());
        }
        for k in drop {
            m.remove(*k);
        }
        Config::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = lookup(&[], &[]).unwrap();
        assert_eq!(c.bind_addr, "0.0.0.0:8080");
        assert_eq!(c.r2_region, "auto");
        assert_eq!(c.max_upload_mb, 200);
        assert_eq!(c.max_duration_s, 900);
        assert_eq!(c.user_quota_mb, 5000);
        assert_eq!(c.max_concurrent_jobs, 2);
        assert_eq!(c.public_base_url, "https://stemora.example.com");
        assert!(c.cookie_secure);
        assert!(c.modal_endpoint_url.is_empty());
        assert_eq!(c.max_upload_bytes(), 200 * 1024 * 1024);
        assert_eq!(c.ytdlp_path, "yt-dlp");
        assert_eq!(c.max_concurrent_imports, 2);
        assert_eq!(c.import_timeout_s, 600);
    }

    #[test]
    fn cookie_secure_override_and_http() {
        let c = lookup(&[("PUBLIC_BASE_URL", "http://localhost:3000")], &[]).unwrap();
        assert!(!c.cookie_secure);
        let c = lookup(&[("COOKIE_SECURE", "true")], &[]).unwrap();
        assert!(c.cookie_secure);
        let c = lookup(&[("COOKIE_SECURE", "0")], &[]).unwrap();
        assert!(!c.cookie_secure);
        assert!(lookup(&[("COOKIE_SECURE", "maybe")], &[]).is_err());
    }

    #[test]
    fn missing_and_invalid() {
        assert!(matches!(
            lookup(&[], &["DATABASE_URL"]),
            Err(ConfigError::Missing("DATABASE_URL"))
        ));
        assert!(lookup(&[("MAX_UPLOAD_MB", "abc")], &[]).is_err());
        assert!(lookup(&[("WEBHOOK_SIGNING_KEY", "short")], &[]).is_err());
        assert!(lookup(&[("PUBLIC_BASE_URL", "ftp://x")], &[]).is_err());
        assert!(lookup(&[("MAX_CONCURRENT_JOBS", "0")], &[]).is_err());
        assert!(lookup(&[("MAX_CONCURRENT_IMPORTS", "0")], &[]).is_err());
    }

    #[test]
    fn callback_url_built_from_base() {
        let c = lookup(&[], &[]).unwrap();
        let id = uuid::Uuid::nil();
        assert_eq!(
            c.callback_url(id),
            format!("https://stemora.example.com/api/webhooks/jobs/{id}")
        );
    }
}
