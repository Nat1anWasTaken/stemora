//! Integration tests against a real Postgres (default: docker on localhost:56432, override with
//! TEST_DATABASE_URL = admin connection URL). Each test gets its own fresh database. Storage and
//! Modal are in-memory fakes. If Postgres is unreachable the tests are skipped with a warning.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use stemora_backend::auth::webhook_token;
use stemora_backend::config::Config;
use stemora_backend::fetch::{FakeFetcher, FetchError, MediaInfo};
use stemora_backend::modal::{FakeModal, SpawnError};
use stemora_backend::storage::{self, FakeStorage};
use stemora_backend::{AppState, build_router, db, jobs};
use tower::ServiceExt;
use uuid::Uuid;

const MIB: u64 = 1024 * 1024;

struct TestApp {
    router: Router,
    state: AppState,
    storage: Arc<FakeStorage>,
    modal: Arc<FakeModal>,
    fetcher: Arc<FakeFetcher>,
}

async fn setup_with(tweak: impl FnOnce(&mut Config)) -> Option<TestApp> {
    let admin_url = std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:56432/postgres".into());
    let admin = match PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_secs(3))
        .max_connections(2)
        .connect(&admin_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("SKIPPING integration test: cannot reach Postgres at {admin_url}: {e}");
            return None;
        }
    };
    let name = format!("t_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&admin)
        .await
        .unwrap();
    let url = match admin_url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{name}"),
        None => unreachable!(),
    };
    let pool: PgPool = db::connect(&url).await.unwrap();
    db::migrate(&pool).await.unwrap();
    let mut cfg = Config::for_tests();
    tweak(&mut cfg);
    let storage = Arc::new(FakeStorage::default());
    let modal = Arc::new(FakeModal::default());
    let fetcher = Arc::new(FakeFetcher::default());
    let state =
        AppState::new(pool, cfg, storage.clone(), modal.clone()).with_fetcher(fetcher.clone());
    Some(TestApp {
        router: build_router(state.clone()),
        state,
        storage,
        modal,
        fetcher,
    })
}

async fn setup() -> Option<TestApp> {
    setup_with(|_| {}).await
}

struct Resp {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Value,
}

impl TestApp {
    async fn req(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> Resp {
        let mut b = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, format!("stemora_session={c}"));
        }
        if let Some(t) = bearer {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(v) => b
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => b.body(Body::empty()).unwrap(),
        };
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Resp {
            status,
            headers,
            body,
        }
    }
    async fn get(&self, path: &str, cookie: &str) -> Resp {
        self.req(Method::GET, path, Some(cookie), None, None).await
    }
    async fn post(&self, path: &str, cookie: &str, body: Value) -> Resp {
        self.req(Method::POST, path, Some(cookie), None, Some(body))
            .await
    }
    async fn webhook(&self, job_id: &str, token: &str, body: Value) -> Resp {
        self.req(
            Method::POST,
            &format!("/api/webhooks/jobs/{job_id}"),
            None,
            Some(token),
            Some(body),
        )
        .await
    }

    /// Bootstrap the admin and return its session cookie value.
    async fn admin(&self) -> String {
        let r = self
            .req(
                Method::POST,
                "/api/auth/bootstrap",
                None,
                None,
                Some(json!({"email":"Admin@Example.com","password":"password123"})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        cookie_of(&r)
    }

    /// Admin invites a new user; returns the user's session cookie.
    async fn user(&self, admin: &str, email: &str) -> String {
        let inv = self.post("/api/admin/invites", admin, json!({})).await;
        assert_eq!(inv.status, StatusCode::OK);
        let token = inv.body["token"].as_str().unwrap();
        let r = self
            .req(
                Method::POST,
                "/api/auth/accept-invite",
                None,
                None,
                Some(json!({"token":token,"email":email,"password":"password123"})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        cookie_of(&r)
    }

    /// Create a song and upload it (fake), returning the song id.
    async fn song(&self, cookie: &str, size: u64) -> String {
        let r = self
            .post("/api/songs", cookie, json!({"title":"Test","filename":"a.mp3","content_type":"audio/mpeg","size":size,"model":"htdemucs"}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        r.body["song"]["id"].as_str().unwrap().to_string()
    }

    async fn song_user_id(&self, song_id: &str) -> Uuid {
        let (u,): (Uuid,) = sqlx::query_as("SELECT user_id FROM songs WHERE id = $1")
            .bind(Uuid::parse_str(song_id).unwrap())
            .fetch_one(&self.state.pool)
            .await
            .unwrap();
        u
    }

    /// Create + put + complete. Returns (song_id, job_id, attempt-1 token).
    async fn queued_song(&self, cookie: &str) -> (String, String, String) {
        let id = self.song(cookie, MIB).await;
        let uid = self.song_user_id(&id).await;
        self.storage.put(
            &storage::original_key(uid, Uuid::parse_str(&id).unwrap(), "mp3"),
            MIB,
        );
        let r = self
            .post(&format!("/api/songs/{id}/complete"), cookie, json!({}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let (job_id,): (Uuid,) = sqlx::query_as("SELECT id FROM jobs WHERE song_id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&self.state.pool)
            .await
            .unwrap();
        let token = webhook_token(&self.state.config.webhook_signing_key, job_id, 1);
        (id, job_id.to_string(), token)
    }

    /// Start a link import and wait for it to leave `importing`. Returns the final song.
    async fn import(&self, cookie: &str, body: Value) -> Value {
        let r = self.post("/api/songs/import", cookie, body).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        assert_eq!(r.body["status"], "importing");
        assert!(
            ["waiting", "probing"].contains(&r.body["stage"].as_str().unwrap()),
            "{:?}",
            r.body
        );
        let id = r.body["id"].as_str().unwrap().to_string();
        for _ in 0..200 {
            let d = self.get(&format!("/api/songs/{id}"), cookie).await;
            if d.body["song"]["status"] != "importing" {
                return d.body["song"].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("import did not finish");
    }

    fn done_body(&self, uid: Uuid, sid: &str) -> Value {
        let sid = Uuid::parse_str(sid).unwrap();
        let stems: Vec<Value> = ["vocals", "drums", "bass", "other"]
            .iter()
            .map(|n| json!({"name":n,"m4a_key":storage::stem_key(uid,sid,n,"m4a"),"flac_key":storage::stem_key(uid,sid,n,"flac"),"m4a_size":1000,"flac_size":5000}))
            .collect();
        json!({"status":"done","stage":"done","progress":100,"duration_s":123.4,"stems":stems,"peaks_key":storage::peaks_key(uid,sid)})
    }
}

fn cookie_of(r: &Resp) -> String {
    let sc = r
        .headers
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        sc.contains("HttpOnly") && sc.contains("SameSite=Lax"),
        "{sc}"
    );
    sc.split(';')
        .next()
        .unwrap()
        .strip_prefix("stemora_session=")
        .unwrap()
        .to_string()
}

macro_rules! app {
    () => {
        match setup().await {
            Some(a) => a,
            None => return,
        }
    };
}

#[tokio::test]
async fn update_me_changes_email_and_password() {
    let app = app!();
    let admin = app.admin().await;
    let other_session = {
        let r = app
            .req(
                Method::POST,
                "/api/auth/login",
                None,
                None,
                Some(json!({"email":"admin@example.com","password":"password123"})),
            )
            .await;
        cookie_of(&r)
    };
    let user = app.user(&admin, "taken@example.com").await;
    let patch = |cookie: String, body: Value| {
        let app = &app;
        async move {
            app.req(
                Method::PATCH,
                "/api/auth/me",
                Some(&cookie),
                None,
                Some(body),
            )
            .await
        }
    };

    // Wrong current password, duplicate email, weak password are rejected.
    let r = patch(
        admin.clone(),
        json!({"current_password":"nope","email":"me@example.com"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = patch(
        admin.clone(),
        json!({"current_password":"password123","email":"Taken@Example.com"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r = patch(
        admin.clone(),
        json!({"current_password":"password123","new_password":"short"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Email + password change keeps the role and this session, drops other sessions.
    let r = patch(
        admin.clone(),
        json!({"current_password":"password123","email":" Me@Example.com ","new_password":"newpassword456"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["email"], "me@example.com");
    assert_eq!(r.body["role"], "admin");
    assert_eq!(app.get("/api/auth/me", &admin).await.status, StatusCode::OK);
    assert_eq!(
        app.get("/api/auth/me", &other_session).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(app.get("/api/auth/me", &user).await.status, StatusCode::OK);

    let login = |email: &str, password: &str| {
        let body = json!({"email": email, "password": password});
        let app = &app;
        async move {
            app.req(Method::POST, "/api/auth/login", None, None, Some(body))
                .await
                .status
        }
    };
    assert_eq!(
        login("me@example.com", "newpassword456").await,
        StatusCode::OK
    );
    assert_eq!(
        login("me@example.com", "password123").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login("admin@example.com", "newpassword456").await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn auth_and_invites() {
    let app = app!();
    let r = app
        .req(Method::GET, "/api/auth/status", None, None, None)
        .await;
    assert_eq!(r.body, json!({"needs_bootstrap": true}));
    assert_eq!(
        app.req(Method::GET, "/api/healthz", None, None, None)
            .await
            .status,
        StatusCode::OK
    );

    let admin = app.admin().await;
    let me = app.get("/api/auth/me", &admin).await;
    assert_eq!(me.body["email"], "admin@example.com");
    assert_eq!(me.body["role"], "admin");
    assert_eq!(
        app.req(Method::GET, "/api/auth/status", None, None, None)
            .await
            .body,
        json!({"needs_bootstrap": false})
    );

    let again = app
        .req(
            Method::POST,
            "/api/auth/bootstrap",
            None,
            None,
            Some(json!({"email":"x@y.com","password":"password123"})),
        )
        .await;
    assert_eq!(again.status, StatusCode::FORBIDDEN);

    // login
    let bad = app
        .req(
            Method::POST,
            "/api/auth/login",
            None,
            None,
            Some(json!({"email":"admin@example.com","password":"nope"})),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    assert_eq!(bad.body["code"], "invalid_credentials");
    let ok = app
        .req(
            Method::POST,
            "/api/auth/login",
            None,
            None,
            Some(json!({"email":"ADMIN@example.com","password":"password123"})),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);

    // logout invalidates the session
    let c = cookie_of(&ok);
    let lo = app
        .req(Method::POST, "/api/auth/logout", Some(&c), None, None)
        .await;
    assert_eq!(lo.status, StatusCode::NO_CONTENT);
    assert_eq!(
        app.get("/api/auth/me", &c).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.req(Method::GET, "/api/auth/me", None, None, None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    // invites
    let inv = app.post("/api/admin/invites", &admin, json!({})).await;
    let token = inv.body["token"].as_str().unwrap().to_string();
    assert_eq!(
        inv.body["url"],
        format!("http://localhost:8080/invite/{token}")
    );
    assert_eq!(
        app.req(
            Method::GET,
            &format!("/api/invites/{token}"),
            None,
            None,
            None
        )
        .await
        .body,
        json!({"valid": true})
    );
    assert_eq!(
        app.req(Method::GET, "/api/invites/garbage", None, None, None)
            .await
            .body,
        json!({"valid": false})
    );
    let acc = app
        .req(
            Method::POST,
            "/api/auth/accept-invite",
            None,
            None,
            Some(json!({"token":token,"email":"bob@example.com","password":"password123"})),
        )
        .await;
    assert_eq!(acc.status, StatusCode::OK);
    assert_eq!(acc.body["role"], "user");
    let bob = cookie_of(&acc);
    // single use
    let reuse = app
        .req(
            Method::POST,
            "/api/auth/accept-invite",
            None,
            None,
            Some(json!({"token":token,"email":"eve@example.com","password":"password123"})),
        )
        .await;
    assert_eq!(reuse.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        app.req(
            Method::GET,
            &format!("/api/invites/{token}"),
            None,
            None,
            None
        )
        .await
        .body,
        json!({"valid": false})
    );
    // non-admin cannot invite
    assert_eq!(
        app.post("/api/admin/invites", &bob, json!({})).await.status,
        StatusCode::FORBIDDEN
    );
    let list = app.get("/api/admin/invites", &admin).await;
    assert_eq!(list.body[0]["status"], "used");
    assert_eq!(list.body[0]["used_by_email"], "bob@example.com");
    // duplicate email
    let inv2 = app.post("/api/admin/invites", &admin, json!({})).await;
    let dup = app
        .req(Method::POST, "/api/auth/accept-invite", None, None, Some(json!({"token":inv2.body["token"],"email":"BOB@example.com","password":"password123"})))
        .await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn songs_full_flow() {
    let app = app!();
    let admin = app.admin().await;
    let bob = app.user(&admin, "bob@example.com").await;

    let r = app
        .post("/api/songs", &bob, json!({"title":"My Song","filename":"track.MP3","content_type":"audio/mpeg","size":MIB,"model":"htdemucs_ft"}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["upload"]["mode"], "single");
    assert_eq!(r.body["upload"]["headers"]["Content-Type"], "audio/mpeg");
    assert_eq!(r.body["song"]["status"], "uploading");
    let id = r.body["song"]["id"].as_str().unwrap().to_string();
    let sid = Uuid::parse_str(&id).unwrap();
    let uid = app.song_user_id(&id).await;
    assert!(
        r.body["upload"]["url"]
            .as_str()
            .unwrap()
            .contains(&storage::original_key(uid, sid, "mp3"))
    );

    // not uploaded yet
    let c = app
        .post(&format!("/api/songs/{id}/complete"), &bob, json!({}))
        .await;
    assert_eq!(c.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.body["code"], "upload_missing");

    // other users get 404
    assert_eq!(
        app.get(&format!("/api/songs/{id}"), &admin).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.post(&format!("/api/songs/{id}/complete"), &admin, json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.req(
            Method::DELETE,
            &format!("/api/songs/{id}"),
            Some(&admin),
            None,
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.get("/api/songs", &admin).await.body, json!([]));

    app.storage
        .put(&storage::original_key(uid, sid, "mp3"), MIB);
    let c = app
        .post(&format!("/api/songs/{id}/complete"), &bob, json!({}))
        .await;
    assert_eq!(c.status, StatusCode::OK, "{:?}", c.body);
    assert_eq!(c.body["status"], "queued");
    // Modal was called with the contract payload
    let call = app.modal.calls.lock().unwrap()[0].clone();
    assert_eq!(call.attempt, 1);
    assert_eq!(call.model, "htdemucs_ft");
    assert_eq!(call.user_id, uid);
    assert_eq!(call.song_id, sid);
    assert_eq!(call.max_duration_s, 900);
    assert_eq!(
        call.callback_url,
        format!("http://localhost:8080/api/webhooks/jobs/{}", call.job_id)
    );
    assert_eq!(
        call.callback_token,
        webhook_token(&app.state.config.webhook_signing_key, call.job_id, 1)
    );
    // idempotent complete: still one job, one spawn
    let c2 = app
        .post(&format!("/api/songs/{id}/complete"), &bob, json!({}))
        .await;
    assert_eq!(c2.body["status"], "queued");
    assert_eq!(app.modal.calls.lock().unwrap().len(), 1);

    let job = call.job_id.to_string();
    let tok = call.callback_token.clone();
    let w = app
        .webhook(
            &job,
            &tok,
            json!({"status":"running","stage":"separating","progress":42}),
        )
        .await;
    assert_eq!(w.status, StatusCode::OK);
    let s = app.get(&format!("/api/songs/{id}"), &bob).await;
    assert_eq!(s.body["song"]["status"], "processing");
    assert_eq!(s.body["song"]["progress"], 42);
    assert_eq!(s.body["song"]["stage"], "separating");
    assert_eq!(s.body["stems"], json!([]));
    assert_eq!(s.body["peaks_url"], Value::Null);

    let w = app.webhook(&job, &tok, app.done_body(uid, &id)).await;
    assert_eq!(w.status, StatusCode::OK, "{:?}", w.body);
    let s = app.get(&format!("/api/songs/{id}"), &bob).await;
    assert_eq!(s.body["song"]["status"], "ready");
    assert_eq!(s.body["song"]["duration_s"], 123.4);
    assert_eq!(s.body["song"]["progress"], 100);
    assert_eq!(s.body["stems"].as_array().unwrap().len(), 4);
    assert_eq!(s.body["stems"][0]["name"], "vocals");
    assert_eq!(s.body["stems"][0]["size_bytes"], 1000);
    assert!(s.body["peaks_url"].as_str().unwrap().contains("peaks.json"));
    assert!(s.body["analysis_url"].as_str().unwrap().contains("analysis.json"));

    // usage = original + stems
    let u = app.get("/api/me/usage", &bob).await;
    assert_eq!(
        u.body,
        json!({"used_bytes": MIB + 4 * 6000, "quota_bytes": 5000 * MIB})
    );

    // download
    let d = app
        .get(
            &format!("/api/songs/{id}/stems/vocals/download?format=flac"),
            &bob,
        )
        .await;
    assert_eq!(d.status, StatusCode::FOUND);
    let loc = d.headers.get(header::LOCATION).unwrap().to_str().unwrap();
    assert!(
        loc.contains("vocals.flac") && loc.contains("cd=attachment"),
        "{loc}"
    );
    assert_eq!(
        app.get(
            &format!("/api/songs/{id}/stems/vocals/download?format=wav"),
            &bob
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.get(&format!("/api/songs/{id}/stems/guitar/download"), &bob)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.get(&format!("/api/songs/{id}/stems/vocals/download"), &admin)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // rename
    let p = app
        .req(
            Method::PATCH,
            &format!("/api/songs/{id}"),
            Some(&bob),
            None,
            Some(json!({"title":"Renamed"})),
        )
        .await;
    assert_eq!(p.body["title"], "Renamed");

    // reprocess
    app.storage
        .put(&storage::stem_key(uid, sid, "vocals", "m4a"), 1000);
    let rp = app
        .post(
            &format!("/api/songs/{id}/reprocess"),
            &bob,
            json!({"model":"htdemucs"}),
        )
        .await;
    assert_eq!(rp.status, StatusCode::OK, "{:?}", rp.body);
    assert_eq!(rp.body["status"], "queued");
    assert_eq!(rp.body["model"], "htdemucs");
    assert!(
        !app.storage
            .has(&storage::stem_key(uid, sid, "vocals", "m4a"))
    );
    assert_eq!(app.modal.calls.lock().unwrap().len(), 2);
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM stems WHERE song_id = $1")
        .bind(sid)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    // cannot reprocess while in flight
    assert_eq!(
        app.post(
            &format!("/api/songs/{id}/reprocess"),
            &bob,
            json!({"model":"htdemucs"})
        )
        .await
        .status,
        StatusCode::CONFLICT
    );

    // list shows it, delete removes everything
    assert_eq!(
        app.get("/api/songs", &bob)
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let del = app
        .req(
            Method::DELETE,
            &format!("/api/songs/{id}"),
            Some(&bob),
            None,
            None,
        )
        .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert!(
        app.storage
            .deleted_prefixes
            .lock()
            .unwrap()
            .contains(&storage::song_prefix(uid, sid))
    );
    assert!(!app.storage.has(&storage::original_key(uid, sid, "mp3")));
    assert_eq!(
        app.get(&format!("/api/songs/{id}"), &bob).await.status,
        StatusCode::NOT_FOUND
    );
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM jobs")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn create_song_validation_and_limits() {
    let Some(app) = setup_with(|c| {
        c.max_upload_mb = 100;
        c.user_quota_mb = 120;
    })
    .await
    else {
        return;
    };
    let admin = app.admin().await;
    let mk = |filename: &str, ct: &str, size: u64, model: &str| json!({"title":"t","filename":filename,"content_type":ct,"size":size,"model":model});

    assert_eq!(
        app.req(
            Method::POST,
            "/api/songs",
            None,
            None,
            Some(mk("a.mp3", "audio/mpeg", 1, "htdemucs"))
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.post(
            "/api/songs",
            &admin,
            mk("a.exe", "audio/mpeg", 1, "htdemucs")
        )
        .await
        .status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        app.post(
            "/api/songs",
            &admin,
            mk("a.mp3", "image/png", 1, "htdemucs")
        )
        .await
        .status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        app.post(
            "/api/songs",
            &admin,
            mk("a.mp3", "audio/mpeg", 101 * MIB, "htdemucs")
        )
        .await
        .status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        app.post(
            "/api/songs",
            &admin,
            mk("a.mp3", "audio/mpeg", 0, "htdemucs")
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.post("/api/songs", &admin, mk("a.mp3", "audio/mpeg", 1, "nope"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // quota: 100 MiB fits (multipart), another 100 MiB does not
    let big = app
        .post(
            "/api/songs",
            &admin,
            mk("a.wav", "audio/wav", 100 * MIB, "htdemucs"),
        )
        .await;
    assert_eq!(big.status, StatusCode::OK);
    assert_eq!(big.body["upload"]["mode"], "multipart");
    assert_eq!(big.body["upload"]["part_size"], 16 * MIB);
    assert_eq!(big.body["upload"]["part_count"], 7);
    let q = app
        .post(
            "/api/songs",
            &admin,
            mk("b.wav", "audio/wav", 100 * MIB, "htdemucs"),
        )
        .await;
    assert_eq!(q.status, StatusCode::FORBIDDEN);
    assert_eq!(q.body["code"], "quota_exceeded");

    // part URLs
    let id = big.body["song"]["id"].as_str().unwrap();
    let upload_id = big.body["upload"]["upload_id"].as_str().unwrap();
    let parts = app
        .post(
            &format!("/api/songs/{id}/upload/parts"),
            &admin,
            json!({"part_numbers":[1,2,7]}),
        )
        .await;
    assert_eq!(parts.status, StatusCode::OK, "{:?}", parts.body);
    assert_eq!(parts.body["urls"].as_array().unwrap().len(), 3);
    assert!(
        parts.body["urls"][2]["url"]
            .as_str()
            .unwrap()
            .contains(&format!("uploadId={upload_id}&partNumber=7"))
    );
    assert_eq!(
        app.post(
            &format!("/api/songs/{id}/upload/parts"),
            &admin,
            json!({"part_numbers":[8]})
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.post(
            &format!("/api/songs/{id}/upload/parts"),
            &admin,
            json!({"part_numbers":[0]})
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );

    // complete multipart: wrong part list rejected, right one accepted
    let uid = app.song_user_id(id).await;
    app.storage.put(
        &storage::original_key(uid, Uuid::parse_str(id).unwrap(), "wav"),
        100 * MIB,
    );
    let bad = app
        .post(
            &format!("/api/songs/{id}/complete"),
            &admin,
            json!({"parts":[{"part_number":1,"etag":"a"}]}),
        )
        .await;
    assert_eq!(bad.body["code"], "invalid_parts");
    let parts: Vec<Value> = (1..=7)
        .map(|n| json!({"part_number":n,"etag":format!("\"etag{n}\"")}))
        .collect();
    let ok = app
        .post(
            &format!("/api/songs/{id}/complete"),
            &admin,
            json!({"parts":parts}),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert_eq!(ok.body["status"], "queued");
    assert!(app.storage.uploads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn complete_enforces_size_by_head() {
    let app = app!();
    let admin = app.admin().await;
    let id = app.song(&admin, MIB).await;
    let uid = app.song_user_id(&id).await;
    let key = storage::original_key(uid, Uuid::parse_str(&id).unwrap(), "mp3");
    app.storage.put(&key, MIB + 5); // client uploaded something else than declared
    let r = app
        .post(&format!("/api/songs/{id}/complete"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["code"], "size_mismatch");
    assert!(!app.storage.has(&key), "mismatched object is deleted");
    let s = app.get(&format!("/api/songs/{id}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "failed");
    assert!(app.modal.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn complete_rejects_oversize_object() {
    let Some(app) = setup_with(|c| c.max_upload_mb = 2).await else {
        return;
    };
    let admin = app.admin().await;
    let id = app.song(&admin, MIB).await;
    let uid = app.song_user_id(&id).await;
    let key = storage::original_key(uid, Uuid::parse_str(&id).unwrap(), "mp3");
    app.storage.put(&key, 3 * MIB);
    let r = app
        .post(&format!("/api/songs/{id}/complete"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!app.storage.has(&key));
}

#[tokio::test]
async fn webhook_auth_idempotency_and_terminal_state() {
    let app = app!();
    let admin = app.admin().await;
    let (sid, job, tok) = app.queued_song(&admin).await;
    let uid = app.song_user_id(&sid).await;

    // auth
    assert_eq!(
        app.req(
            Method::POST,
            &format!("/api/webhooks/jobs/{job}"),
            None,
            None,
            Some(json!({"status":"running"}))
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.webhook(&job, "deadbeef", json!({"status":"running"}))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.webhook(
            &job,
            &webhook_token("some-other-key-123456", Uuid::parse_str(&job).unwrap(), 1),
            json!({"status":"running"})
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.webhook(
            &Uuid::new_v4().to_string(),
            &tok,
            json!({"status":"running"})
        )
        .await
        .status,
        StatusCode::GONE
    );
    // invalid stems are rejected and change nothing
    let bad = app.webhook(&job, &tok, json!({"status":"done","duration_s":1.0,"stems":[{"name":"vocals","m4a_key":"users/x/evil.m4a","flac_key":"k","m4a_size":1,"flac_size":1}]})).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // done twice -> second is ignored, data unchanged
    let done = app.done_body(uid, &sid);
    assert_eq!(
        app.webhook(&job, &tok, done.clone()).await.body,
        json!({"ok": true})
    );
    let again = app
        .webhook(
            &job,
            &tok,
            json!({"status":"done","duration_s":999.0,"stems":done["stems"]}),
        )
        .await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.body["ignored"], "terminal");
    assert_eq!(again.body["cancel"], true);
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["duration_s"], 123.4);
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM stems")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 4);

    // late running / failed webhooks cannot regress a finished job
    app.webhook(&job, &tok, json!({"status":"running","progress":10}))
        .await;
    app.webhook(
        &job,
        &tok,
        json!({"status":"failed","error":"late","retryable":false}),
    )
    .await;
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "ready");
    assert_eq!(s.body["song"]["error"], Value::Null);
}

#[tokio::test]
async fn deleting_a_processing_song_tells_the_worker_to_stop() {
    let app = app!();
    let admin = app.admin().await;
    let (sid, job, tok) = app.queued_song(&admin).await;
    app.webhook(&job, &tok, json!({"status":"running","progress":20}))
        .await;
    let del = app
        .req(
            Method::DELETE,
            &format!("/api/songs/{sid}"),
            Some(&admin),
            None,
            None,
        )
        .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    // The worker's next heartbeat (valid token) learns the job is gone.
    let r = app
        .webhook(&job, &tok, json!({"status":"running","progress":30}))
        .await;
    assert_eq!(r.status, StatusCode::GONE);
    assert_eq!(r.body["code"], "job_gone");
}

#[tokio::test]
async fn failure_retry_backoff_and_stale_attempts() {
    let app = app!();
    let admin = app.admin().await;
    let (sid, job, tok1) = app.queued_song(&admin).await;
    let job_id = Uuid::parse_str(&job).unwrap();
    let key = app.state.config.webhook_signing_key.clone();

    app.webhook(&job, &tok1, json!({"status":"running","progress":5}))
        .await;
    // retryable failure on attempt 1 -> queued with 30s backoff, song stays processing
    let f = app
        .webhook(
            &job,
            &tok1,
            json!({"status":"failed","error":"gpu oom","retryable":true}),
        )
        .await;
    assert_eq!(f.status, StatusCode::OK);
    let (attempt, status, secs): (i32, String, f64) =
        sqlx::query_as("SELECT attempt, status, EXTRACT(EPOCH FROM (next_run_at - now()))::float8 FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!((attempt, status.as_str()), (2, "queued"));
    assert!((20.0..=31.0).contains(&secs), "backoff {secs}");
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "processing");

    // not due yet -> reaper does not spawn; a stale attempt-1 update is acknowledged and ignored
    jobs::dispatch(&app.state, None).await.unwrap();
    assert_eq!(app.modal.calls.lock().unwrap().len(), 1);
    let stale = app
        .webhook(&job, &tok1, json!({"status":"running","progress":99}))
        .await;
    assert_eq!(stale.status, StatusCode::OK);
    assert_eq!(stale.body["ignored"], "stale_attempt");
    assert_eq!(stale.body["cancel"], true);

    // make due; the reaper re-spawns attempt 2 with a new token
    sqlx::query("UPDATE jobs SET next_run_at = now() - interval '1 second' WHERE id = $1")
        .bind(job_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(jobs::dispatch(&app.state, None).await.unwrap(), 1);
    {
        let calls = app.modal.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].attempt, 2);
        assert_eq!(calls[1].callback_token, webhook_token(&key, job_id, 2));
    }
    // dispatching again does not double-spawn
    assert_eq!(jobs::dispatch(&app.state, None).await.unwrap(), 0);

    // attempt 2 fails retryably -> 120s backoff
    let tok2 = webhook_token(&key, job_id, 2);
    app.webhook(
        &job,
        &tok2,
        json!({"status":"failed","error":"net","retryable":true}),
    )
    .await;
    let (attempt, secs): (i32, f64) = sqlx::query_as(
        "SELECT attempt, EXTRACT(EPOCH FROM (next_run_at - now()))::float8 FROM jobs WHERE id = $1",
    )
    .bind(job_id)
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(attempt, 3);
    assert!((110.0..=121.0).contains(&secs), "backoff {secs}");

    // attempt 3 fails retryably -> out of attempts -> failed
    sqlx::query("UPDATE jobs SET next_run_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    jobs::dispatch(&app.state, None).await.unwrap();
    let tok3 = webhook_token(&key, job_id, 3);
    app.webhook(
        &job,
        &tok3,
        json!({"status":"failed","error":"still broken","retryable":true}),
    )
    .await;
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "failed");
    assert_eq!(s.body["song"]["error"], "still broken");
    assert_eq!(app.modal.calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn non_retryable_failure_fails_immediately() {
    let app = app!();
    let admin = app.admin().await;
    let (sid, job, tok) = app.queued_song(&admin).await;
    app.webhook(
        &job,
        &tok,
        json!({"status":"failed","error":"not audio","retryable":false}),
    )
    .await;
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "failed");
    assert_eq!(s.body["song"]["error"], "not audio");
}

#[tokio::test]
async fn unconfigured_or_failing_modal_fails_cleanly() {
    let app = app!();
    let admin = app.admin().await;
    *app.modal.fail_with.lock().unwrap() = Some(SpawnError {
        message: "Processing is not configured (MODAL_ENDPOINT_URL is empty)".into(),
        retryable: false,
    });
    let id = app.song(&admin, MIB).await;
    let uid = app.song_user_id(&id).await;
    app.storage.put(
        &storage::original_key(uid, Uuid::parse_str(&id).unwrap(), "mp3"),
        MIB,
    );
    let r = app
        .post(&format!("/api/songs/{id}/complete"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["status"], "failed");
    assert!(
        r.body["error"]
            .as_str()
            .unwrap()
            .contains("MODAL_ENDPOINT_URL")
    );

    // a transient spawn error is retried with backoff instead
    *app.modal.fail_with.lock().unwrap() = Some(SpawnError {
        message: "502".into(),
        retryable: true,
    });
    let id2 = app.song(&admin, MIB).await;
    app.storage.put(
        &storage::original_key(uid, Uuid::parse_str(&id2).unwrap(), "mp3"),
        MIB,
    );
    let r = app
        .post(&format!("/api/songs/{id2}/complete"), &admin, json!({}))
        .await;
    assert_eq!(r.body["status"], "queued");
    let (attempt, status): (i32, String) =
        sqlx::query_as("SELECT attempt, status FROM jobs WHERE song_id = $1")
            .bind(Uuid::parse_str(&id2).unwrap())
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!((attempt, status.as_str()), (2, "queued"));
}

#[tokio::test]
async fn reaper_fails_stale_jobs_and_purges_old_uploads() {
    let app = app!();
    let admin = app.admin().await;
    let (sid, job, _tok) = app.queued_song(&admin).await;
    let job_id = Uuid::parse_str(&job).unwrap();

    // not started by the worker yet (waiting for a GPU): 6 minutes is fine, 31 is not
    sqlx::query("UPDATE jobs SET last_heartbeat_at = now() - interval '6 minutes' WHERE id = $1")
        .bind(job_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(jobs::fail_stale(&app.state).await.unwrap(), 0);
    sqlx::query("UPDATE jobs SET last_heartbeat_at = now() - interval '31 minutes' WHERE id = $1")
        .bind(job_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(jobs::fail_stale(&app.state).await.unwrap(), 1);
    assert_eq!(
        *app.modal.cancelled.lock().unwrap(),
        vec!["fc-test-1".to_string()]
    );
    let (attempt, status): (i32, String) =
        sqlx::query_as("SELECT attempt, status FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!((attempt, status.as_str()), (2, "queued"));
    // a fresh heartbeat is left alone
    assert_eq!(jobs::fail_stale(&app.state).await.unwrap(), 0);
    // once the worker has reported, a heartbeat older than 5 minutes is stale; on the last
    // attempt that fails the song
    sqlx::query("UPDATE jobs SET status = 'running', attempt = 3, stage = 'separating', last_heartbeat_at = now() - interval '6 minutes' WHERE id = $1").bind(job_id).execute(&app.state.pool).await.unwrap();
    assert_eq!(jobs::fail_stale(&app.state).await.unwrap(), 1);
    let s = app.get(&format!("/api/songs/{sid}"), &admin).await;
    assert_eq!(s.body["song"]["status"], "failed");

    // uploads older than 24h are purged (multipart aborted, objects deleted)
    let up = app
        .post("/api/songs", &admin, json!({"title":"old","filename":"a.wav","content_type":"audio/wav","size":60 * MIB,"model":"htdemucs"}))
        .await;
    let old_id = Uuid::parse_str(up.body["song"]["id"].as_str().unwrap()).unwrap();
    let fresh = app.song(&admin, MIB).await;
    assert_eq!(app.storage.uploads.lock().unwrap().len(), 1);
    sqlx::query("UPDATE songs SET created_at = now() - interval '25 hours' WHERE id = $1")
        .bind(old_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(jobs::purge_stale_uploads(&app.state).await.unwrap(), 1);
    assert!(app.storage.uploads.lock().unwrap().is_empty());
    let uid = app.song_user_id(&fresh).await;
    assert!(
        app.storage
            .deleted_prefixes
            .lock()
            .unwrap()
            .contains(&storage::song_prefix(uid, old_id))
    );
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM songs WHERE id = $1")
        .bind(old_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    assert_eq!(
        app.get(&format!("/api/songs/{fresh}"), &admin).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_job_limit_and_rate_limit() {
    let app = app!();
    let admin = app.admin().await;
    app.queued_song(&admin).await;
    app.queued_song(&admin).await;
    let id = app.song(&admin, MIB).await;
    let uid = app.song_user_id(&id).await;
    app.storage.put(
        &storage::original_key(uid, Uuid::parse_str(&id).unwrap(), "mp3"),
        MIB,
    );
    let r = app
        .post(&format!("/api/songs/{id}/complete"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.body["code"], "too_many_jobs");

    // rate limit: 30 per 10 minutes shared by create + complete (several were used above)
    let mut last = StatusCode::OK;
    for _ in 0..40 {
        last = app
            .post("/api/songs", &admin, json!({"title":"t","filename":"a.mp3","content_type":"audio/mpeg","size":1,"model":"htdemucs"}))
            .await
            .status;
        if last == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn import_from_link_queues_a_job() {
    let app = app!();
    let admin = app.admin().await;
    let song = app
        .import(
            &admin,
            json!({"url":"https://www.youtube.com/watch?v=abc","model":"htdemucs_ft"}),
        )
        .await;
    assert_eq!(song["status"], "queued", "{song:?}");
    assert_eq!(song["title"], "Fetched Title");
    assert_eq!(song["source_url"], "https://www.youtube.com/watch?v=abc");
    assert_eq!(song["size_bytes"], 4 * MIB);
    let id = song["id"].as_str().unwrap();
    let uid = app.song_user_id(id).await;
    let key = storage::original_key(uid, Uuid::parse_str(id).unwrap(), "webm");
    assert!(app.storage.has(&key));
    // The song turns `queued` just before the job is spawned.
    for _ in 0..100 {
        if !app.modal.calls.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let calls = app.modal.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].original_key, key);
    assert_eq!(calls[0].model, "htdemucs_ft");

    // A title the user typed is kept.
    let song = app
        .import(
            &admin,
            json!({"url":"https://soundcloud.com/a/b","title":"Mine","model":"htdemucs"}),
        )
        .await;
    assert_eq!(song["title"], "Mine");
    let u = app.get("/api/me/usage", &admin).await;
    assert_eq!(u.body["used_bytes"], 8 * MIB);
}

#[tokio::test]
async fn import_failures_are_reported_on_the_song() {
    let app = app!();
    let admin = app.admin().await;
    let link = json!({"url":"https://example.com/watch","model":"htdemucs"});

    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo {
        duration_s: Some(3600.0),
        ..Default::default()
    });
    let song = app.import(&admin, link.clone()).await;
    assert_eq!(song["status"], "failed");
    assert!(
        song["error"]
            .as_str()
            .unwrap()
            .contains("maximum is 15.0 min")
    );
    // The placeholder title (the link) stays when nothing better is known.
    assert_eq!(song["title"], "https://example.com/watch");

    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo {
        is_live: true,
        ..Default::default()
    });
    let song = app.import(&admin, link.clone()).await;
    assert!(song["error"].as_str().unwrap().contains("Live"));

    *app.fetcher.info.lock().unwrap() = Err(FetchError("This link is not supported.".into()));
    let song = app.import(&admin, link.clone()).await;
    assert_eq!(song["error"], "This link is not supported.");

    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo::default());
    *app.fetcher.file.lock().unwrap() = Ok(("webm".into(), 300 * MIB));
    let song = app.import(&admin, link.clone()).await;
    assert!(song["error"].as_str().unwrap().contains("200 MB"));

    *app.fetcher.file.lock().unwrap() = Ok(("html".into(), MIB));
    let song = app.import(&admin, link.clone()).await;
    assert!(song["error"].as_str().unwrap().contains("not audio"));
    let id = song["id"].as_str().unwrap();
    assert!(app.storage.objects.lock().unwrap().is_empty());
    assert!(app.modal.calls.lock().unwrap().is_empty());

    // Failed imports cannot be reprocessed (there is no original), only re-imported.
    let r = app
        .post(
            &format!("/api/songs/{id}/reprocess"),
            &admin,
            json!({"model":"htdemucs"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["code"], "original_missing");
}

#[tokio::test]
async fn import_reports_progress_and_can_be_cancelled() {
    let app = app!();
    let admin = app.admin().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *app.fetcher.gate.lock().unwrap() = Some(gate.clone());
    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo {
        title: Some("Fetched Title".into()),
        duration_s: Some(180.0),
        uploader: Some("Artist".into()),
        ..Default::default()
    });
    let link = json!({"url":"https://www.youtube.com/watch?v=abc","model":"htdemucs"});

    // Waits mid-download (the fake reports half of 4 MiB): the song shows the live progress,
    // and the fetched title and duration before the download is done.
    let wait_downloading = |id: String| {
        let app = &app;
        let admin = &admin;
        async move {
            for _ in 0..200 {
                let d = app.get(&format!("/api/songs/{id}"), admin).await;
                if d.body["song"]["stage"] == "downloading" {
                    return d.body["song"].clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("import never reported downloading");
        }
    };
    let r = app.post("/api/songs/import", &admin, link.clone()).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let song = wait_downloading(id.clone()).await;
    assert_eq!(song["status"], "importing");
    assert_eq!(song["title"], "Fetched Title");
    assert_eq!(song["duration_s"], 180.0);
    assert_eq!(song["progress"], 50);
    assert_eq!(song["download"]["downloaded_bytes"], 2 * MIB);
    assert_eq!(song["download"]["total_bytes"], 4 * MIB);
    assert_eq!(song["download"]["eta_s"], 3);
    let list = app.get("/api/songs", &admin).await;
    assert_eq!(list.body[0]["download"]["total_bytes"], 4 * MIB);

    let r = app
        .post(&format!("/api/songs/{id}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["status"], "failed");
    assert_eq!(r.body["error"], "The import was cancelled.");
    assert!(r.body["download"].is_null());
    // The download never finishes, even once it could.
    gate.add_permits(10);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let d = app.get(&format!("/api/songs/{id}"), &admin).await;
    assert_eq!(d.body["song"]["status"], "failed");
    assert!(app.storage.objects.lock().unwrap().is_empty());
    assert!(app.modal.calls.lock().unwrap().is_empty());
    let r = app
        .post(&format!("/api/songs/{id}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["code"], "not_importing");

    // Deleting an import stops it too.
    gate.forget_permits(10);
    let r = app.post("/api/songs/import", &admin, link.clone()).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    wait_downloading(id.clone()).await;
    let r = app
        .req(
            Method::DELETE,
            &format!("/api/songs/{id}"),
            Some(&admin),
            None,
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    gate.add_permits(10);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(app.storage.objects.lock().unwrap().is_empty());
    assert!(!app.state.imports.abort(Uuid::parse_str(&id).unwrap()));
}

#[tokio::test]
async fn link_preview() {
    let app = app!();
    let admin = app.admin().await;
    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo {
        title: Some("Song".into()),
        duration_s: Some(200.0),
        uploader: Some("Artist".into()),
        site: Some("Youtube".into()),
        filesize: Some(3 * MIB),
        ..Default::default()
    });
    let r = app
        .post(
            "/api/songs/import/preview",
            &admin,
            json!({"url":"https://www.youtube.com/watch?v=abc"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        r.body,
        json!({"title":"Song","duration_s":200.0,"uploader":"Artist","site":"Youtube","filesize":3 * MIB,"problem":null})
    );
    // Nothing is imported.
    assert!(
        app.get("/api/songs", &admin)
            .await
            .body
            .as_array()
            .unwrap()
            .is_empty()
    );

    *app.fetcher.info.lock().unwrap() = Ok(MediaInfo {
        duration_s: Some(3600.0),
        ..Default::default()
    });
    let r = app
        .post(
            "/api/songs/import/preview",
            &admin,
            json!({"url":"https://x.com/a"}),
        )
        .await;
    assert!(
        r.body["problem"]
            .as_str()
            .unwrap()
            .contains("maximum is 15.0 min")
    );

    *app.fetcher.info.lock().unwrap() = Err(FetchError("This link is not supported.".into()));
    let r = app
        .post(
            "/api/songs/import/preview",
            &admin,
            json!({"url":"https://x.com/a"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.body["error"], "This link is not supported.");
    let r = app
        .post(
            "/api/songs/import/preview",
            &admin,
            json!({"url":"http://127.0.0.1/"}),
        )
        .await;
    assert_eq!(r.body["code"], "invalid_url");
}

#[tokio::test]
async fn import_validation_and_limits() {
    let app = app!();
    let admin = app.admin().await;
    for url in [
        "not a link",
        "ftp://x.com/a",
        "http://127.0.0.1/",
        "http://localhost/a",
    ] {
        let r = app
            .post(
                "/api/songs/import",
                &admin,
                json!({"url":url,"model":"htdemucs"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{url}");
        assert_eq!(r.body["code"], "invalid_url");
    }
    let r = app
        .post(
            "/api/songs/import",
            &admin,
            json!({"url":"https://x.com/a","model":"nope"}),
        )
        .await;
    assert_eq!(r.body["code"], "invalid_model");

    // Imports still downloading count toward the concurrent-job limit.
    *app.fetcher.info.lock().unwrap() = Err(FetchError("x".into()));
    let link = json!({"url":"https://example.com/a","model":"htdemucs"});
    let _permits = app
        .state
        .import_slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    for _ in 0..2 {
        let r = app.post("/api/songs/import", &admin, link.clone()).await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let r = app.post("/api/songs/import", &admin, link.clone()).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.body["code"], "too_many_jobs");

    // A restart leaves them orphaned; startup marks them failed.
    assert_eq!(
        jobs::fail_orphaned_imports(&app.state.pool).await.unwrap(),
        2
    );
    let list = app.get("/api/songs", &admin).await;
    assert!(
        list.body
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "failed")
    );
}
