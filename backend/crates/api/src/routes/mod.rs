use axum::{extract::DefaultBodyLimit, routing::get, Router};
use http::{header, HeaderValue, Method};
use tower_http::cors::CorsLayer;

use crate::state::AppState;

mod assets;
mod beats;
mod chat;
mod health;
mod jobs;
mod projects;
mod segment;
mod transcribe;

pub fn router(state: AppState) -> Router {
    let origins: Vec<HeaderValue> = state
        .allowed_origins()
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::CACHE_CONTROL,
        ]);

    Router::new()
        .route("/api/health", get(health::handler))
        .nest("/api/chat", chat::router())
        .nest("/api/projects", projects::router())
        .nest("/api/assets", assets::router())
        .nest("/api/jobs", jobs::router())
        .nest("/api/transcribe", transcribe::router())
        .nest("/api/segment", segment::router())
        .nest("/api/detect-beats", beats::router())
        .with_state(state)
        // Multipart STT uploads can be GB-scale (raw 4K clip blobs sent
        // directly from IndexedDB). Local dev only sends to localhost so
        // there's no abuse risk — raise both the tower-http RequestBody
        // limit AND axum's per-extractor DefaultBodyLimit (which silently
        // caps every extractor at 2 MB unless overridden).
        .layer(DefaultBodyLimit::disable())
        .layer(tower_http::limit::RequestBodyLimitLayer::new(4 * 1024 * 1024 * 1024))
        .layer(cors)
}
