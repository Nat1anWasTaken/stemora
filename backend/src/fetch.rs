//! Fetching audio from a link with yt-dlp (see docs/contract.md, "Import from a link").

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use async_trait::async_trait;
use serde::Deserialize;

/// Audio only when the site offers it; otherwise the smallest-effort format that has audio.
const FORMAT: &str = "bestaudio/best[acodec!=none]";

/// What we need to know about a link before downloading it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaInfo {
    pub title: Option<String>,
    pub duration_s: Option<f64>,
    pub is_live: bool,
    pub is_playlist: bool,
    /// Exact or approximate size of the selected format, when the site reports it.
    pub filesize: Option<u64>,
}

/// A human-readable reason the link could not be fetched (shown to the user as-is).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError(pub String);

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[async_trait]
pub trait Fetcher: Send + Sync {
    async fn probe(&self, url: &str) -> Result<MediaInfo, FetchError>;
    /// Download the audio into `dir` and return the file's path (`original.{ext}`).
    async fn download(&self, url: &str, dir: &Path, max_bytes: u64) -> Result<PathBuf, FetchError>;
}

pub struct YtDlp {
    bin: String,
}

impl YtDlp {
    pub fn new(bin: String) -> Self {
        Self { bin }
    }

    async fn run(&self, args: &[&str]) -> Result<(String, String), FetchError> {
        let out = tokio::process::Command::new(&self.bin)
            .args([
                "--ignore-config",
                "--no-playlist",
                "--no-warnings",
                "--color",
                "never",
            ])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| {
                tracing::error!(bin = %self.bin, error = %e, "could not run yt-dlp");
                FetchError("Importing from links is not available on this server.".into())
            })?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if !out.status.success() {
            tracing::warn!(status = %out.status, stderr = %tail(&stderr, 500), "yt-dlp failed");
            return Err(classify(&stderr));
        }
        Ok((stdout, stderr))
    }
}

#[async_trait]
impl Fetcher for YtDlp {
    async fn probe(&self, url: &str) -> Result<MediaInfo, FetchError> {
        guard_host(url).await?;
        let (stdout, _) = self
            .run(&["--dump-single-json", "-f", FORMAT, "--", url])
            .await?;
        parse_info(&stdout)
    }

    async fn download(&self, url: &str, dir: &Path, max_bytes: u64) -> Result<PathBuf, FetchError> {
        guard_host(url).await?;
        let template = dir.join("original.%(ext)s");
        let max = max_bytes.to_string();
        let (stdout, _) = self
            .run(&[
                "-f",
                FORMAT,
                "--max-filesize",
                &max,
                "--no-progress",
                "--no-mtime",
                "--no-part",
                "-o",
                &template.to_string_lossy(),
                "--",
                url,
            ])
            .await?;
        if stdout.contains("larger than max-filesize") {
            return Err(too_large(max_bytes));
        }
        find_original(dir)
            .await
            .ok_or_else(|| FetchError("The download finished but produced no file.".into()))
    }
}

pub fn too_large(max_bytes: u64) -> FetchError {
    FetchError(format!(
        "The audio is larger than the {} MB upload limit.",
        max_bytes / (1024 * 1024)
    ))
}

async fn find_original(dir: &Path) -> Option<PathBuf> {
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("original.") && !name.ends_with(".part") && !name.ends_with(".ytdl") {
            return Some(e.path());
        }
    }
    None
}

#[derive(Deserialize)]
struct RawInfo {
    #[serde(rename = "_type")]
    kind: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
    is_live: Option<bool>,
    filesize: Option<f64>,
    filesize_approx: Option<f64>,
}

pub fn parse_info(json: &str) -> Result<MediaInfo, FetchError> {
    let raw: RawInfo = serde_json::from_str(json)
        .map_err(|_| FetchError("Could not read the link's details.".into()))?;
    Ok(MediaInfo {
        title: raw
            .title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()),
        duration_s: raw.duration.filter(|d| *d > 0.0),
        is_live: raw.is_live.unwrap_or(false),
        is_playlist: matches!(raw.kind.as_deref(), Some("playlist" | "multi_video")),
        filesize: raw
            .filesize
            .or(raw.filesize_approx)
            .filter(|s| *s > 0.0)
            .map(|s| s as u64),
    })
}

/// Map yt-dlp's stderr to a message the user can act on.
pub fn classify(stderr: &str) -> FetchError {
    let s = stderr.to_ascii_lowercase();
    let msg = if s.contains("unsupported url") {
        "This link is not supported."
    } else if s.contains("sign in to confirm") || s.contains("not a bot") {
        "The site wants a sign-in to confirm this is not a bot, so this server cannot download it right now."
    } else if s.contains("private video")
        || s.contains("video unavailable")
        || s.contains("is not available")
        || s.contains("has been removed")
        || s.contains("http error 404")
    {
        "The link is private, removed or unavailable."
    } else if s.contains("requested format is not available") {
        "No audio is available for this link."
    } else if s.contains("http error 403") || s.contains("http error 401") {
        "The site refused the download."
    } else if s.contains("unable to download webpage") || s.contains("timed out") {
        "Could not reach the site. Check the link and try again."
    } else {
        let last = stderr
            .lines()
            .rev()
            .find(|l| l.starts_with("ERROR:"))
            .map(|l| l.trim_start_matches("ERROR:").trim())
            .unwrap_or("");
        return FetchError(if last.is_empty() {
            "Could not fetch the link.".into()
        } else {
            format!("Could not fetch the link: {}", tail(last, 200))
        });
    };
    FetchError(msg.into())
}

fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

/// Reject links whose host resolves to a private, loopback or otherwise non-public address.
/// Best effort: yt-dlp resolves again and follows redirects on its own.
async fn guard_host(url: &str) -> Result<(), FetchError> {
    let u = url::Url::parse(url).map_err(|_| FetchError("The link is not a valid URL.".into()))?;
    let host = u
        .host_str()
        .ok_or_else(|| FetchError("The link has no host.".into()))?;
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
        .await
        .map_err(|_| FetchError("Could not resolve the link's host.".into()))?
        .map(|a| a.ip())
        .collect();
    if addrs.is_empty() || addrs.iter().any(|ip| !is_public(*ip)) {
        return Err(FetchError(
            "Links to private addresses are not allowed.".into(),
        ));
    }
    Ok(())
}

pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80 // link local
                || v6 == Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0)
                || seg0 == 0x2001 && v6.segments()[1] == 0x0db8) // documentation
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // carrier-grade NAT
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240)
}

/// Test double: returns canned metadata and writes a file of the given size.
pub struct FakeFetcher {
    pub info: std::sync::Mutex<Result<MediaInfo, FetchError>>,
    /// (extension, size in bytes) of the file `download` writes, or an error.
    pub file: std::sync::Mutex<Result<(String, u64), FetchError>>,
    pub calls: std::sync::Mutex<Vec<String>>,
}

impl Default for FakeFetcher {
    fn default() -> Self {
        Self {
            info: std::sync::Mutex::new(Ok(MediaInfo {
                title: Some("Fetched Title".into()),
                duration_s: Some(180.0),
                ..Default::default()
            })),
            file: std::sync::Mutex::new(Ok(("webm".into(), 4 * 1024 * 1024))),
            calls: Default::default(),
        }
    }
}

#[async_trait]
impl Fetcher for FakeFetcher {
    async fn probe(&self, url: &str) -> Result<MediaInfo, FetchError> {
        self.calls.lock().unwrap().push(format!("probe {url}"));
        self.info.lock().unwrap().clone()
    }

    async fn download(&self, url: &str, dir: &Path, max_bytes: u64) -> Result<PathBuf, FetchError> {
        self.calls.lock().unwrap().push(format!("download {url}"));
        let (ext, size) = self.file.lock().unwrap().clone()?;
        if size > max_bytes {
            return Err(too_large(max_bytes));
        }
        let path = dir.join(format!("original.{ext}"));
        let f = std::fs::File::create(&path).map_err(|e| FetchError(e.to_string()))?;
        f.set_len(size).map_err(|e| FetchError(e.to_string()))?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_addresses() {
        for ip in ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005:80a::200e"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn guard_rejects_private_literals() {
        for u in [
            "http://127.0.0.1/x",
            "http://[::1]:8080/",
            "http://169.254.169.254/latest",
            "http://localhost/",
        ] {
            assert!(guard_host(u).await.is_err(), "{u}");
        }
    }

    #[test]
    fn parses_info() {
        let i = parse_info(
            r#"{"_type":"video","title":" Song ","duration":212.5,"is_live":false,"filesize":null,"filesize_approx":3400000}"#,
        )
        .unwrap();
        assert_eq!(i.title.as_deref(), Some("Song"));
        assert_eq!(i.duration_s, Some(212.5));
        assert_eq!(i.filesize, Some(3_400_000));
        assert!(!i.is_live && !i.is_playlist);
        assert!(
            parse_info(r#"{"_type":"playlist","title":"x"}"#)
                .unwrap()
                .is_playlist
        );
        assert!(parse_info("not json").is_err());
    }

    #[test]
    fn classifies_errors() {
        let c = |s: &str| classify(s).0;
        assert_eq!(
            c("ERROR: Unsupported URL: https://x"),
            "This link is not supported."
        );
        assert!(
            c("ERROR: [youtube] abc: Sign in to confirm you're not a bot").contains("not a bot")
        );
        assert!(c("ERROR: [youtube] abc: Private video").contains("private"));
        assert_eq!(
            c("WARNING: x\nERROR: something odd happened"),
            "Could not fetch the link: something odd happened"
        );
        assert_eq!(c(""), "Could not fetch the link.");
    }

    /// Runs the real yt-dlp: `STEMORA_IMPORT_TEST_URL=... cargo test -- --ignored real_ytdlp`
    /// (uses `YTDLP_PATH`, default `yt-dlp`).
    #[tokio::test]
    #[ignore]
    async fn real_ytdlp() {
        let url = std::env::var("STEMORA_IMPORT_TEST_URL").expect("STEMORA_IMPORT_TEST_URL");
        let y = YtDlp::new(std::env::var("YTDLP_PATH").unwrap_or_else(|_| "yt-dlp".into()));
        let info = y.probe(&url).await.unwrap();
        assert!(!info.is_playlist && !info.is_live, "{info:?}");
        let dir = std::env::temp_dir().join(format!("stemora-ytdlp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(y.download(&url, &dir, 1000).await, Err(too_large(1000)));
        let path = y.download(&url, &dir, 200 << 20).await.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1000);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
