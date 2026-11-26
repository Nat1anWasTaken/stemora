//! Links to music catalogs that cannot be downloaded (Spotify), and matching their songs to
//! YouTube Music / YouTube uploads that can (see docs/contract.md, "Import from a link").

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// What a Spotify link points to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpotifyKind {
    Track,
    Album,
    Playlist,
}

impl SpotifyKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Album => "album",
            Self::Playlist => "playlist",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyLink {
    pub kind: SpotifyKind,
    /// Base62 id.
    pub id: String,
}

impl SpotifyLink {
    /// The canonical link, which is what an import of it stores as its `source_url`.
    pub fn url(&self) -> String {
        format!(
            "https://open.spotify.com/{}/{}",
            self.kind.as_str(),
            self.id
        )
    }

    /// The public embed page, which carries the metadata without an API key.
    pub fn embed_url(&self) -> String {
        format!(
            "https://open.spotify.com/embed/{}/{}",
            self.kind.as_str(),
            self.id
        )
    }
}

/// Hosts of Spotify's short links (`spotify.link/abc`), which redirect to open.spotify.com.
pub fn is_spotify_short_link(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("spotify.link" | "spotify.app.link"))
}

/// Parse `https://open.spotify.com/[intl-xx/]{track|album|playlist}/{id}` or a
/// `spotify:{kind}:{id}` URI. Other Spotify pages (artists, podcasts) and other sites are `None`.
pub fn parse_spotify(raw: &str) -> Option<SpotifyLink> {
    let raw = raw.trim();
    let (kind, id): (String, String) = if let Some(rest) = raw.strip_prefix("spotify:") {
        let mut parts = rest.split(':');
        (parts.next()?.into(), parts.next()?.into())
    } else {
        let u = url::Url::parse(raw).ok()?;
        if !matches!(u.scheme(), "http" | "https") || u.host_str()? != "open.spotify.com" {
            return None;
        }
        let mut segs = u.path_segments()?.filter(|s| !s.is_empty()).peekable();
        if segs.peek().is_some_and(|s| s.starts_with("intl-")) {
            segs.next();
        }
        (segs.next()?.into(), segs.next()?.into())
    };
    let kind = match kind.as_str() {
        "track" => SpotifyKind::Track,
        "album" => SpotifyKind::Album,
        "playlist" => SpotifyKind::Playlist,
        _ => return None,
    };
    let valid = (10..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric());
    valid.then_some(SpotifyLink { kind, id })
}

/// A song as a catalog describes it: what to look for on YouTube.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TrackMeta {
    pub title: String,
    pub artists: Vec<String>,
    pub duration_s: Option<f64>,
}

/// A Spotify track, album or playlist.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpotifyEntity {
    pub title: Option<String>,
    /// Album artist or playlist owner.
    pub subtitle: Option<String>,
    /// The track itself for a track link; the songs of an album or playlist (podcast episodes
    /// left out), as many as Spotify's embed shows.
    pub tracks: Vec<(SpotifyLink, TrackMeta)>,
}

#[derive(Deserialize)]
struct EmbedArtist {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedTrack {
    uri: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    duration: Option<f64>,
    entity_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedEntity {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    artists: Vec<EmbedArtist>,
    duration: Option<f64>,
    #[serde(default)]
    track_list: Vec<EmbedTrack>,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Spotify joins a track's artists with a comma and a no-break space.
fn split_artists(s: &str) -> Vec<String> {
    s.split(',')
        .map(|a| a.trim_matches(|c: char| c.is_whitespace()).to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

fn ms_to_s(ms: Option<f64>) -> Option<f64> {
    ms.filter(|d| *d > 0.0).map(|d| (d / 10.0).round() / 100.0)
}

/// Read the metadata out of an `open.spotify.com/embed/...` page (its `__NEXT_DATA__` JSON).
pub fn parse_spotify_embed(html: &str, link: &SpotifyLink) -> Option<SpotifyEntity> {
    const START: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    let from = html.find(START)? + START.len();
    let json = &html[from..from + html[from..].find("</script>")?];
    let data: serde_json::Value = serde_json::from_str(json).ok()?;
    let entity: EmbedEntity =
        serde_json::from_value(data.pointer("/props/pageProps/state/data/entity")?.clone()).ok()?;
    let title = clean(entity.name.or(entity.title));
    if link.kind == SpotifyKind::Track {
        if entity.kind.as_deref().is_some_and(|k| k != "track") {
            return None;
        }
        let meta = TrackMeta {
            title: title.clone()?,
            artists: entity
                .artists
                .into_iter()
                .filter_map(|a| clean(Some(a.name)))
                .collect(),
            duration_s: ms_to_s(entity.duration),
        };
        let id = entity.id.unwrap_or_else(|| link.id.clone());
        let track = parse_spotify(&format!("spotify:track:{id}"))?;
        return Some(SpotifyEntity {
            title,
            subtitle: meta.artists.first().cloned(),
            tracks: vec![(track, meta)],
        });
    }
    let tracks = entity
        .track_list
        .into_iter()
        .filter(|t| t.entity_type.as_deref().is_none_or(|k| k == "track"))
        .filter_map(|t| {
            let link = parse_spotify(t.uri.as_deref()?)?;
            (link.kind == SpotifyKind::Track).then_some(())?;
            Some((
                link,
                TrackMeta {
                    title: clean(t.title)?,
                    artists: t.subtitle.as_deref().map(split_artists).unwrap_or_default(),
                    duration_s: ms_to_s(t.duration),
                },
            ))
        })
        .collect();
    Some(SpotifyEntity {
        title,
        subtitle: clean(entity.subtitle),
        tracks,
    })
}

/// A YouTube upload that might be the song.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Candidate {
    pub url: String,
    pub title: String,
    /// Channel, or the artists YouTube Music lists.
    pub channel: Option<String>,
    pub duration_s: Option<f64>,
    /// Found in YouTube Music's song catalog (the studio recording), not just on YouTube.
    pub music: bool,
}

/// What to search YouTube for.
pub fn search_query(t: &TrackMeta) -> String {
    let artists = t
        .artists
        .iter()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    format!("{artists} {}", core_title(&t.title))
        .trim()
        .to_string()
}

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The title without what catalogs add to it: "(feat. X)", "[Remastered]", "- 2011 Remaster".
fn core_title(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let out = out.split(" - ").next().unwrap_or("").trim().to_string();
    if tokens(&out).is_empty() {
        title.to_string()
    } else {
        out
    }
}

/// Words that mark another version of the song, unless the song's own title has them.
const OTHER_VERSION: &[&str] = &[
    "live",
    "cover",
    "karaoke",
    "instrumental",
    "remix",
    "sped",
    "slowed",
    "reverb",
    "nightcore",
    "8d",
    "acoustic",
    "reaction",
    "tutorial",
    "lesson",
    "mashup",
    "bass boosted",
];

fn fraction_found(wanted: &[String], have: &HashSet<String>) -> f64 {
    if wanted.is_empty() {
        return 0.0;
    }
    wanted.iter().filter(|w| have.contains(*w)).count() as f64 / wanted.len() as f64
}

/// How likely `c` is the recording `t` describes, 0..1.
pub fn score(t: &TrackMeta, c: &Candidate) -> f64 {
    raw_score(t, c).clamp(0.0, 1.0)
}

/// [`score`] before clamping, so uploads that all look right still sort the most official first.
fn raw_score(t: &TrackMeta, c: &Candidate) -> f64 {
    let cand_title = tokens(&c.title);
    let mut have: HashSet<String> = cand_title.iter().cloned().collect();
    if let Some(ch) = &c.channel {
        have.extend(tokens(ch));
    }
    let title = fraction_found(&tokens(&core_title(&t.title)), &have);
    let artist = t
        .artists
        .first()
        .map(|a| fraction_found(&tokens(a), &have))
        .unwrap_or(0.5);
    let duration = match (t.duration_s, c.duration_s) {
        (Some(a), Some(b)) => (1.0 - ((a - b).abs() - 2.0).max(0.0) / 28.0).max(0.0),
        _ => 0.5,
    };
    // A version named on one side only (a live upload for the studio track, or the studio
    // upload for a "(Live)" track) is another recording.
    let song_text = tokens(&t.title).join(" ");
    let cand_text = cand_title.join(" ");
    let other_version = OTHER_VERSION
        .iter()
        .filter(|w| has_phrase(&cand_text, w) != has_phrase(&song_text, w))
        .count() as f64;
    let mut bonus = 0.0;
    if c.music {
        bonus += 0.1;
    }
    if c.channel
        .as_deref()
        .is_some_and(|ch| ch.to_lowercase().ends_with(" - topic"))
    {
        bonus += 0.1;
    }
    // The artist's own channel (official video, visualizer) over a fan's lyric upload.
    if let (Some(ch), Some(a)) = (&c.channel, t.artists.first())
        && !tokens(a).is_empty()
        && tokens(ch).starts_with(&tokens(a))
    {
        bonus += 0.05;
    }
    0.4 * title + 0.25 * artist + 0.35 * duration + bonus - (0.3 * other_version).min(0.6)
}

fn has_phrase(text: &str, phrase: &str) -> bool {
    format!(" {text} ").contains(&format!(" {} ", tokens(phrase).join(" ")))
}

/// Whether `c`'s title (or channel) carries most of the song's title, and names any version
/// (live, remix, ...) the song's title names. Matching without asking requires it: an upload by
/// the right artist at the right length can still be another song or the studio take.
pub fn names_title(t: &TrackMeta, c: &Candidate) -> bool {
    let mut have: HashSet<String> = tokens(&c.title).into_iter().collect();
    if let Some(ch) = &c.channel {
        have.extend(tokens(ch));
    }
    let (song, cand) = (tokens(&t.title).join(" "), tokens(&c.title).join(" "));
    fraction_found(&tokens(&core_title(&t.title)), &have) >= 0.75
        && OTHER_VERSION
            .iter()
            .all(|w| !has_phrase(&song, w) || has_phrase(&cand, w))
}

/// The YouTube video id of a watch link, used to merge results that are the same upload.
fn video_id(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if u.host_str()? == "youtu.be" {
        return u.path_segments()?.next().map(str::to_string);
    }
    u.query_pairs()
        .find(|(k, _)| k == "v")
        .map(|(_, v)| v.into_owned())
}

/// Merge search results (the same upload found twice keeps what each knew) and sort them by
/// [`score`], best first.
pub fn rank(t: &TrackMeta, results: Vec<Candidate>) -> Vec<(Candidate, f64)> {
    let mut merged: Vec<Candidate> = Vec::new();
    for c in results {
        let id = video_id(&c.url);
        match merged
            .iter_mut()
            .find(|m| id.is_some() && video_id(&m.url) == id)
        {
            Some(m) => {
                m.music |= c.music;
                m.duration_s = m.duration_s.or(c.duration_s);
                if m.channel.is_none() {
                    m.channel = c.channel;
                }
            }
            None => merged.push(c),
        }
    }
    let mut ranked: Vec<(Candidate, f64)> = merged
        .into_iter()
        .map(|c| {
            let s = raw_score(t, &c);
            (c, s)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked
        .into_iter()
        .map(|(c, s)| (c, s.clamp(0.0, 1.0)))
        .collect()
}

/// Below this, a result is not offered as the song when matching without asking.
pub const AUTO_MATCH_MIN_SCORE: f64 = 0.5;
/// A match whose length differs from the song's by more than this is another version.
pub const AUTO_MATCH_MAX_DURATION_DIFF_S: f64 = 15.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spotify_links() {
        let t = |s: &str| parse_spotify(s).map(|l| (l.kind, l.id));
        let id = "4cOdK2wGLETKBW3PvgPWqT";
        for ok in [
            format!("https://open.spotify.com/track/{id}"),
            format!("https://open.spotify.com/track/{id}?si=abc123"),
            format!("https://open.spotify.com/intl-de/track/{id}"),
            format!("spotify:track:{id}"),
        ] {
            assert_eq!(t(&ok), Some((SpotifyKind::Track, id.into())), "{ok}");
        }
        assert_eq!(
            t("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").map(|x| x.0),
            Some(SpotifyKind::Playlist)
        );
        assert_eq!(
            t("spotify:album:4aawyAB9vmqN3uQ7FjRGTy").map(|x| x.0),
            Some(SpotifyKind::Album)
        );
        for bad in [
            "https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt",
            "https://open.spotify.com/track/",
            "https://open.spotify.com/track/../../x",
            "https://evil.com/track/4cOdK2wGLETKBW3PvgPWqT",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ] {
            assert_eq!(t(bad), None, "{bad}");
        }
        assert_eq!(
            parse_spotify(&format!("spotify:track:{id}")).unwrap().url(),
            format!("https://open.spotify.com/track/{id}")
        );
    }

    fn page(entity: serde_json::Value) -> String {
        let data = serde_json::json!({"props":{"pageProps":{"state":{"data":{"entity":entity}}}}});
        format!(
            r#"<html><script id="__NEXT_DATA__" type="application/json">{data}</script></html>"#
        )
    }

    #[test]
    fn parses_embeds() {
        let track = parse_spotify("spotify:track:4cOdK2wGLETKBW3PvgPWqT").unwrap();
        let e = parse_spotify_embed(
            &page(serde_json::json!({
                "type":"track","id":"4cOdK2wGLETKBW3PvgPWqT","name":"Never Gonna Give You Up",
                "artists":[{"name":"Rick Astley"}],"duration":213573
            })),
            &track,
        )
        .unwrap();
        assert_eq!(
            e.tracks,
            vec![(
                track.clone(),
                TrackMeta {
                    title: "Never Gonna Give You Up".into(),
                    artists: vec!["Rick Astley".into()],
                    duration_s: Some(213.57),
                }
            )]
        );

        let pl = parse_spotify("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M").unwrap();
        let e = parse_spotify_embed(
            &page(serde_json::json!({
                "type":"playlist","name":"Top Hits","subtitle":"Spotify","trackList":[
                    {"uri":"spotify:track:4HCOHRCSQelz2GPX8iTamO","title":"A (feat. B)","subtitle":"X,\u{a0}Y","duration":224877,"entityType":"track"},
                    {"uri":"spotify:episode:4HCOHRCSQelz2GPX8iTamO","title":"Podcast","subtitle":"Z","duration":1000,"entityType":"episode"},
                    {"uri":"spotify:track:6OmhkSOpvYBokMKQxpIGx2","title":"C","subtitle":"Z","duration":85400}
                ]
            })),
            &pl,
        )
        .unwrap();
        assert_eq!(e.title.as_deref(), Some("Top Hits"));
        assert_eq!(e.subtitle.as_deref(), Some("Spotify"));
        assert_eq!(e.tracks.len(), 2);
        assert_eq!(e.tracks[0].1.artists, vec!["X", "Y"]);
        assert_eq!(e.tracks[1].0.id, "6OmhkSOpvYBokMKQxpIGx2");
        assert!(parse_spotify_embed("<html></html>", &pl).is_none());
    }

    fn cand(title: &str, channel: &str, duration: f64) -> Candidate {
        Candidate {
            url: format!("https://www.youtube.com/watch?v={}", title.len()),
            title: title.into(),
            channel: Some(channel.into()),
            duration_s: Some(duration),
            music: false,
        }
    }

    #[test]
    fn queries_and_scores() {
        let t = TrackMeta {
            title: "Anti-Hero (feat. Bleachers) - Remastered".into(),
            artists: vec!["Taylor Swift".into(), "Bleachers".into()],
            duration_s: Some(200.7),
        };
        assert_eq!(search_query(&t), "Taylor Swift Bleachers Anti-Hero");

        let lyric = raw_score(
            &t,
            &cand(
                "Taylor Swift - Anti-Hero (Official Lyric Video)",
                "Taylor Swift",
                204.0,
            ),
        );
        let mv = raw_score(
            &t,
            &cand(
                "Taylor Swift - Anti-Hero (Official Music Video)",
                "Taylor Swift",
                310.0,
            ),
        );
        let cover = raw_score(&t, &cand("Anti-Hero (Acoustic Cover)", "Someone", 201.0));
        let other = raw_score(&t, &cand("Shake It Off", "Taylor Swift", 219.0));
        let topic = raw_score(&t, &cand("Anti-Hero", "Taylor Swift - Topic", 201.0));
        assert!(topic > lyric && lyric > mv, "{topic} {lyric} {mv}");
        assert!(lyric > cover && lyric > other, "{lyric} {cover} {other}");
        assert!(lyric >= AUTO_MATCH_MIN_SCORE);
        assert!(other < AUTO_MATCH_MIN_SCORE, "{other}");

        // A version the song's own title names is not penalised.
        let live = TrackMeta {
            title: "Song (Live)".into(),
            artists: vec!["Band".into()],
            duration_s: None,
        };
        assert!(
            raw_score(&live, &cand("Band - Song (Live)", "Band", 1.0))
                > raw_score(
                    &t,
                    &cand("Taylor Swift - Anti-Hero (Live)", "Taylor Swift", 200.0)
                )
        );
    }

    #[test]
    fn versions_named_on_one_side_only_are_penalised() {
        let live = TrackMeta {
            title: "Song (Live)".into(),
            artists: vec!["Band".into()],
            duration_s: Some(200.0),
        };
        let studio = raw_score(&live, &cand("Song", "Band - Topic", 200.0));
        let live_upload = raw_score(&live, &cand("Band - Song (Live)", "Band", 200.0));
        assert!(live_upload > studio, "{live_upload} {studio}");
        // Without a live upload, the studio one is offered but never picked without asking.
        assert!(!names_title(&live, &cand("Song", "Band - Topic", 200.0)));
        assert!(names_title(
            &live,
            &cand("Band - Song (Live)", "Band", 200.0)
        ));
    }

    #[test]
    fn auto_matching_needs_the_title() {
        let t = TrackMeta {
            title: "First Song (feat. X)".into(),
            artists: vec!["Band".into()],
            duration_s: Some(180.0),
        };
        assert!(names_title(&t, &cand("Band - First Song", "Band", 180.0)));
        let other = cand("Second Track", "Band - Topic", 180.0);
        assert!(!names_title(&t, &other));
        // It would otherwise pass the score threshold on artist and length alone.
        assert!(score(&t, &other) >= AUTO_MATCH_MIN_SCORE);
    }

    #[test]
    fn ranks_and_merges() {
        let t = TrackMeta {
            title: "Song".into(),
            artists: vec!["Band".into()],
            duration_s: Some(180.0),
        };
        let music = Candidate {
            url: "https://music.youtube.com/watch?v=abc".into(),
            title: "Song".into(),
            channel: None,
            duration_s: None,
            music: true,
        };
        let same = Candidate {
            url: "https://www.youtube.com/watch?v=abc".into(),
            title: "Song".into(),
            channel: Some("Band - Topic".into()),
            duration_s: Some(181.0),
            music: false,
        };
        let worse = cand("Band - Song (Live at Wembley)", "Band", 260.0);
        let r = rank(&t, vec![worse.clone(), music, same]);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].0.url, "https://music.youtube.com/watch?v=abc");
        assert!(r[0].0.music);
        assert_eq!(r[0].0.duration_s, Some(181.0));
        assert_eq!(r[0].0.channel.as_deref(), Some("Band - Topic"));
        assert_eq!(r[1].0, worse);
    }
}
