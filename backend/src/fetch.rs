//! Fetching audio from a link with yt-dlp (see docs/contract.md, "Import from a link").

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// Audio only when the site offers it; otherwise the smallest-effort format that has audio.
const FORMAT: &str = "bestaudio/best[acodec!=none]";

/// One machine-readable line per progress update; yt-dlp prints `NA` for unknown fields.
const PROGRESS_PREFIX: &str = "STEMORA-PROGRESS";
const PROGRESS_TEMPLATE: &str = "download:STEMORA-PROGRESS %(progress.downloaded_bytes)s \
    %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";

/// What we need to know about a link before downloading it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaInfo {
    pub title: Option<String>,
    pub duration_s: Option<f64>,
    pub is_live: bool,
    pub is_playlist: bool,
    /// Exact or approximate size of the selected format, when the site reports it.
    pub filesize: Option<u64>,
    /// Channel or artist, when the site names one.
    pub uploader: Option<String>,
    /// The site, as yt-dlp names it (e.g. "YouTube", "SoundCloud").
    pub site: Option<String>,
}

/// Where a download stands, as last reported by yt-dlp.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    /// Exact size, or yt-dlp's estimate for fragmented (HLS/DASH) downloads.
    pub total_bytes: Option<u64>,
    pub speed_bps: Option<f64>,
    pub eta_s: Option<u64>,
}

/// Receives progress updates while a download runs.
pub type ProgressFn<'a> = &'a (dyn Fn(DownloadProgress) + Send + Sync);

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
    async fn download(
        &self,
        url: &str,
        dir: &Path,
        max_bytes: u64,
        progress: ProgressFn<'_>,
    ) -> Result<PathBuf, FetchError>;
}

pub struct YtDlp {
    bin: String,
}

impl YtDlp {
    pub fn new(bin: String) -> Self {
        Self { bin }
    }

    /// Run yt-dlp, passing each stdout line to `on_line` as it arrives. Returns stdout.
    async fn run(
        &self,
        args: &[&str],
        on_line: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<String, FetchError> {
        let mut child = tokio::process::Command::new(&self.bin)
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
            .spawn()
            .map_err(|e| {
                tracing::error!(bin = %self.bin, error = %e, "could not run yt-dlp");
                FetchError("Importing from links is not available on this server.".into())
            })?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let (stdout, stderr) =
            tokio::join!(read_lines(stdout, on_line), read_lines(stderr, &|_| {}));
        let status = child.wait().await.map_err(|e| {
            tracing::error!(error = %e, "yt-dlp did not exit cleanly");
            FetchError("Could not fetch the link.".into())
        })?;
        if !status.success() {
            tracing::warn!(%status, stderr = %tail(&stderr, 500), "yt-dlp failed");
            return Err(classify(&stderr));
        }
        Ok(stdout)
    }
}

/// Collect a stream's lines (without progress lines, which can be many), calling `on_line` on each.
async fn read_lines(
    stream: Option<impl AsyncRead + Unpin>,
    on_line: &(dyn Fn(&str) + Send + Sync),
) -> String {
    let mut out = String::new();
    let Some(stream) = stream else { return out };
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(&line);
        if !line.starts_with(PROGRESS_PREFIX) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Parse one `--progress-template` line; `None` for any other output.
pub fn parse_progress(line: &str) -> Option<DownloadProgress> {
    let mut f = line.strip_prefix(PROGRESS_PREFIX)?.split_whitespace();
    let mut num = || {
        f.next()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
    };
    let downloaded = num()?;
    let (total, estimate, speed, eta) = (num(), num(), num(), num());
    Some(DownloadProgress {
        downloaded_bytes: downloaded as u64,
        total_bytes: total.or(estimate).filter(|t| *t > 0.0).map(|t| t as u64),
        speed_bps: speed,
        eta_s: eta.map(|e| e as u64),
    })
}

#[async_trait]
impl Fetcher for YtDlp {
    async fn probe(&self, url: &str) -> Result<MediaInfo, FetchError> {
        guard_host(url).await?;
        let stdout = self
            .run(&["--dump-single-json", "-f", FORMAT, "--", url], &|_| {})
            .await?;
        parse_info(&stdout)
    }

    async fn download(
        &self,
        url: &str,
        dir: &Path,
        max_bytes: u64,
        progress: ProgressFn<'_>,
    ) -> Result<PathBuf, FetchError> {
        guard_host(url).await?;
        let template = dir.join("original.%(ext)s");
        let max = max_bytes.to_string();
        let stdout = self
            .run(
                &[
                    "-f",
                    FORMAT,
                    "--max-filesize",
                    &max,
                    "--progress",
                    "--newline",
                    "--progress-template",
                    PROGRESS_TEMPLATE,
                    "--no-mtime",
                    "--no-part",
                    "-o",
                    &template.to_string_lossy(),
                    "--",
                    url,
                ],
                &|line| {
                    if let Some(p) = parse_progress(line) {
                        progress(p);
                    }
                },
            )
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
    uploader: Option<String>,
    channel: Option<String>,
    artist: Option<String>,
    extractor_key: Option<String>,
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
        uploader: [raw.artist, raw.uploader, raw.channel]
            .into_iter()
            .flatten()
            .map(|u| u.trim().to_string())
            .find(|u| !u.is_empty()),
        site: raw
            .extractor_key
            .filter(|k| !k.is_empty() && !k.eq_ignore_ascii_case("generic")),
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
    /// When set, `download` reports half its progress and then waits for a permit (tests use
    /// it to observe and cancel an import mid-download).
    pub gate: std::sync::Mutex<Option<std::sync::Arc<tokio::sync::Semaphore>>>,
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
            gate: Default::default(),
        }
    }
}

#[async_trait]
impl Fetcher for FakeFetcher {
    async fn probe(&self, url: &str) -> Result<MediaInfo, FetchError> {
        self.calls.lock().unwrap().push(format!("probe {url}"));
        self.info.lock().unwrap().clone()
    }

    async fn download(
        &self,
        url: &str,
        dir: &Path,
        max_bytes: u64,
        progress: ProgressFn<'_>,
    ) -> Result<PathBuf, FetchError> {
        self.calls.lock().unwrap().push(format!("download {url}"));
        let (ext, size) = self.file.lock().unwrap().clone()?;
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            progress(DownloadProgress {
                downloaded_bytes: size / 2,
                total_bytes: Some(size),
                speed_bps: Some(1e6),
                eta_s: Some(3),
            });
            let _ = gate.acquire().await;
        }
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
        let i = parse_info(
            r#"{"title":"x","uploader":"Up","channel":"Ch","artist":" ","extractor_key":"Youtube"}"#,
        )
        .unwrap();
        assert_eq!(i.uploader.as_deref(), Some("Up"));
        assert_eq!(i.site.as_deref(), Some("Youtube"));
        assert_eq!(
            parse_info(r#"{"extractor_key":"Generic"}"#).unwrap().site,
            None
        );
    }

    #[test]
    fn parses_progress() {
        assert_eq!(
            parse_progress("STEMORA-PROGRESS 15360 8945229 NA 166817.3 53"),
            Some(DownloadProgress {
                downloaded_bytes: 15360,
                total_bytes: Some(8945229),
                speed_bps: Some(166817.3),
                eta_s: Some(53),
            })
        );
        // Fragmented downloads only have an estimate; speed/ETA are unknown at first.
        assert_eq!(
            parse_progress("STEMORA-PROGRESS 1024 NA 5000000.0 NA NA"),
            Some(DownloadProgress {
                downloaded_bytes: 1024,
                total_bytes: Some(5_000_000),
                speed_bps: None,
                eta_s: None,
            })
        );
        assert_eq!(parse_progress("[download] Destination: original.mp3"), None);
        assert_eq!(parse_progress("STEMORA-PROGRESS NA NA NA NA NA"), None);
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
        assert_eq!(
            y.download(&url, &dir, 1000, &|_| {}).await,
            Err(too_large(1000))
        );
        let last = std::sync::Mutex::new(None);
        let path = y
            .download(&url, &dir, 200 << 20, &|p| *last.lock().unwrap() = Some(p))
            .await
            .unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > 1000);
        let last = last.lock().unwrap().clone().expect("no progress reported");
        assert_eq!(last.downloaded_bytes, size);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
