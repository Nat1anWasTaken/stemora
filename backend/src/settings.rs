//! Playback settings sets (docs/playback.md): the mixer, speed, key, which stems follow the key, the metronome click
//! and its sound. The client sends a whole set; the server keeps only well-formed values, filling the rest with
//! defaults, so a set read back is always complete.

use serde_json::{Map, Value, json};

use crate::routes::songs::STEM_NAMES;

pub const MIN_SPEED: f64 = 0.5;
pub const MAX_SPEED: f64 = 1.5;
pub const MAX_SEMITONES: i64 = 12;
/// Stems that follow a key change unless the set says otherwise: drums are unpitched.
const DEFAULT_TRANSPOSED: [&str; 3] = ["vocals", "bass", "other"];
const DEFAULT_CLICK_SOUND: &str = "classic";

/// The stems named in `v` (a JSON array), once each, in STEM_NAMES order; `fallback` when `v` is not an array.
fn stems(v: Option<&Value>, fallback: &[&str]) -> Value {
    match v.and_then(Value::as_array) {
        Some(a) => STEM_NAMES
            .iter()
            .filter(|n| a.iter().any(|x| x.as_str() == Some(n)))
            .map(|n| json!(n))
            .collect(),
        None => fallback.iter().map(|n| json!(n)).collect(),
    }
}

fn click_sound_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// A complete, normalised settings set from untrusted JSON.
pub fn normalize(v: &Value) -> Value {
    let mixer = v.get("mixer");
    let mut volumes = Map::new();
    for n in STEM_NAMES {
        let vol = mixer
            .and_then(|m| m.get("volumes"))
            .and_then(|vs| vs.get(n))
            .and_then(Value::as_f64)
            .filter(|x| x.is_finite())
            .map_or(1.0, |x| (x.clamp(0.0, 1.0) * 1000.0).round() / 1000.0);
        volumes.insert(n.into(), json!(vol));
    }
    let speed = v
        .get("speed")
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .map_or(1.0, |x| {
            (x.clamp(MIN_SPEED, MAX_SPEED) * 1000.0).round() / 1000.0
        });
    let semitones = v
        .get("semitones")
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .map_or(0, |x| {
            (x.round() as i64).clamp(-MAX_SEMITONES, MAX_SEMITONES)
        });
    let flag = |k: &str, d: bool| v.get(k).and_then(Value::as_bool).unwrap_or(d);
    let click_sound = v
        .get("click_sound")
        .and_then(Value::as_str)
        .filter(|s| click_sound_ok(s))
        .unwrap_or(DEFAULT_CLICK_SOUND);
    json!({
        "mixer": {
            "volumes": volumes,
            "muted": stems(mixer.and_then(|m| m.get("muted")), &[]),
            "soloed": stems(mixer.and_then(|m| m.get("soloed")), &[]),
        },
        "speed": speed,
        "semitones": semitones,
        "key_enabled": flag("key_enabled", true),
        "transposed": stems(v.get("transposed"), &DEFAULT_TRANSPOSED),
        "metronome": flag("metronome", false),
        "click_sound": click_sound,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_defaults() {
        let s = normalize(&json!({}));
        assert_eq!(s["speed"], json!(1.0));
        assert_eq!(s["semitones"], json!(0));
        assert_eq!(s["key_enabled"], json!(true));
        assert_eq!(s["transposed"], json!(["vocals", "bass", "other"]));
        assert_eq!(s["mixer"]["volumes"]["drums"], json!(1.0));
        assert_eq!(s["mixer"]["muted"], json!([]));
        assert_eq!(s["click_sound"], json!("classic"));
    }

    #[test]
    fn clamps_and_filters() {
        let s = normalize(&json!({
            "mixer": {"volumes": {"vocals": 3, "bass": -1, "other": "x"}, "muted": ["bass", "nope", "bass", "vocals"]},
            "speed": 9, "semitones": -30.4, "transposed": [], "metronome": true, "click_sound": "../etc",
        }));
        assert_eq!(s["mixer"]["volumes"]["vocals"], json!(1.0));
        assert_eq!(s["mixer"]["volumes"]["bass"], json!(0.0));
        assert_eq!(s["mixer"]["volumes"]["other"], json!(1.0));
        assert_eq!(s["mixer"]["muted"], json!(["vocals", "bass"]));
        assert_eq!(s["speed"], json!(1.5));
        assert_eq!(s["semitones"], json!(-12));
        assert_eq!(s["transposed"], json!([]));
        assert_eq!(s["metronome"], json!(true));
        assert_eq!(s["click_sound"], json!("classic"));
    }
}
