use std::sync::Arc;

use anyhow::Context;
use stemora_backend::config::Config;
use stemora_backend::modal::ModalClient;
use stemora_backend::storage::R2Storage;
use stemora_backend::{AppState, build_router, db, jobs};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `stemora-backend healthcheck`: used by the container HEALTHCHECK (no curl in distroless).
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck().await;
    }
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn"));
    if std::env::var("LOG_FORMAT").is_ok_and(|v| v == "json") {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let config = Config::from_env().context("configuration error")?;
    if config.modal_endpoint_url.is_empty() {
        tracing::warn!(
            "MODAL_ENDPOINT_URL is empty: uploads will be accepted but processing jobs will fail"
        );
    }
    let pool = db::connect(&config.database_url)
        .await
        .context("connecting to database")?;
    db::migrate(&pool).await.context("running migrations")?;

    let storage = Arc::new(R2Storage::new(&config)?);
    let modal = Arc::new(ModalClient::new(
        config.modal_endpoint_url.clone(),
        config.modal_shared_secret.clone(),
    ));
    let bind = config.bind_addr.clone();
    let state = AppState::new(pool, config, storage, modal);

    let reaper = tokio::spawn(jobs::reaper_loop(state.clone()));
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    tracing::info!(addr = %bind, "stemora backend listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    reaper.abort();
    tracing::info!("shut down cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received");
}

async fn healthcheck() -> anyhow::Result<()> {
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let port = bind.rsplit(':').next().unwrap_or("8080");
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()?
        .get(format!("http://127.0.0.1:{port}/api/healthz"))
        .send()
        .await?;
    anyhow::ensure!(resp.status().is_success(), "unhealthy: {}", resp.status());
    Ok(())
}
