use std::net::SocketAddr;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

mod beats;
mod config;
mod error;
mod routes;
mod state;
mod transcribe;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,api=debug")))
        .with(fmt::layer().compact())
        .init();

    let cfg = config::Config::from_env().context("loading configuration")?;
    let bind: SocketAddr = cfg.bind_addr.parse().context("parsing CHITRA_BIND_ADDR")?;
    let state = state::AppState::initialize(&cfg).await?;
    let app = routes::router(state.clone()).layer(TraceLayer::new_for_http());

    let listener = TcpListener::bind(bind).await.context("binding listener")?;
    info!(addr = %bind, "chitra-api listening");
    axum::serve(listener, app).await.context("serving http")?;
    Ok(())
}
