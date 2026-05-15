//! Beat detection endpoint. Multipart upload (`file` field) returns a JSON
//! `BeatResult` with timestamps in **source-time seconds**.

use axum::{
    extract::{Multipart, State},
    routing::post,
    Json, Router,
};

use crate::{beats::BeatResult, error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(handle))
}

async fn handle(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<BeatResult>, ApiError> {
    let client = state.beats();
    if !client.is_enabled() {
        return Err(ApiError::Unavailable("beat detection not configured"));
    }

    let mut audio: Option<(bytes::Bytes, String)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        if field.name().unwrap_or("") != "file" {
            continue;
        }
        let file_name = field.file_name().unwrap_or("audio.bin").to_string();
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        audio = Some((data, file_name));
    }

    let (data, file_name) = audio.ok_or(ApiError::BadRequest("file field required".into()))?;
    let result = client
        .detect(data, &file_name)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("{e}")))?;
    Ok(Json(result))
}
