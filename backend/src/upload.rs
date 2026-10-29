//! Upload validation and planning (pure functions).

use crate::error::{AppError, AppResult};

pub const SINGLE_PUT_MAX: i64 = 50 * 1024 * 1024;
pub const PART_SIZE: i64 = 16 * 1024 * 1024;
pub const MAX_PARTS: i64 = 10_000;

pub const ALLOWED_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma", "webm",
];
/// Besides `audio/*`, browsers report these for some audio files.
const EXTRA_CONTENT_TYPES: &[&str] = &[
    "application/octet-stream",
    "application/ogg",
    "video/webm",
    "video/ogg",
    "video/x-ms-asf",
];

/// Models new jobs may use. Older songs can still carry `htdemucs_ft` (see migration 0003).
pub const MODELS: &[&str] = &["htdemucs", "scnet_xl_ihf"];

#[derive(Debug, PartialEq, Eq)]
pub enum UploadPlan {
    Single,
    Multipart { part_count: i64 },
}

pub fn plan_for_size(size: i64) -> UploadPlan {
    if size <= SINGLE_PUT_MAX {
        UploadPlan::Single
    } else {
        UploadPlan::Multipart {
            part_count: (size + PART_SIZE - 1) / PART_SIZE,
        }
    }
}

pub fn extension_of(filename: &str) -> Option<String> {
    let (_, ext) = filename.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then_some(ext)
}

/// Returns (extension, normalised content type).
pub fn validate_audio(filename: &str, content_type: &str) -> AppResult<(String, String)> {
    let unsupported = |m: &str| {
        AppError::new(
            axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            m,
        )
    };
    let ext = extension_of(filename)
        .filter(|e| ALLOWED_EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| {
            unsupported("unsupported file extension; allowed: mp3, wav, flac, m4a, aac, ogg, opus, aiff, wma, webm")
        })?;
    // Parameters (e.g. "; codecs=opus") are not part of the type.
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let ct = if ct.is_empty() {
        "application/octet-stream".to_string()
    } else {
        ct
    };
    if !(ct.starts_with("audio/") || EXTRA_CONTENT_TYPES.contains(&ct.as_str())) {
        return Err(unsupported("content type is not audio"));
    }
    Ok((ext, ct))
}

pub fn validate_model(model: &str) -> AppResult<()> {
    if MODELS.contains(&model) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "invalid_model",
            "model must be htdemucs or scnet_xl_ihf",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_boundaries() {
        assert_eq!(plan_for_size(1), UploadPlan::Single);
        assert_eq!(plan_for_size(SINGLE_PUT_MAX), UploadPlan::Single);
        assert_eq!(
            plan_for_size(SINGLE_PUT_MAX + 1),
            UploadPlan::Multipart { part_count: 4 }
        );
        assert_eq!(
            plan_for_size(200 * 1024 * 1024),
            UploadPlan::Multipart { part_count: 13 }
        );
        assert_eq!(
            plan_for_size(PART_SIZE * 5),
            UploadPlan::Multipart { part_count: 5 }
        );
    }

    #[test]
    fn audio_validation() {
        assert_eq!(
            validate_audio("Song.MP3", "audio/mpeg").unwrap(),
            ("mp3".into(), "audio/mpeg".into())
        );
        assert!(validate_audio("a.opus", "audio/ogg; codecs=opus").is_ok());
        assert!(validate_audio("a.aiff", "").is_ok());
        assert!(validate_audio("a.webm", "video/webm").is_ok());
        for (f, c) in [
            ("a.exe", "audio/mpeg"),
            ("a.mp3", "text/html"),
            ("noext", "audio/mpeg"),
            ("a.mp3.php", "audio/mpeg"),
            ("a.mp4", "video/mp4"),
        ] {
            let e = validate_audio(f, c).unwrap_err();
            assert_eq!(e.status.as_u16(), 415, "{f} {c}");
        }
    }

    #[test]
    fn models() {
        assert!(validate_model("htdemucs").is_ok());
        assert!(validate_model("scnet_xl_ihf").is_ok());
        assert!(validate_model("htdemucs_ft").is_err());
        assert!(validate_model("mdx").is_err());
    }
}
