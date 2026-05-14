//! Speech-to-text endpoint. Accepts a multipart upload of an audio (or
//! video) file and returns a word-timestamped transcript. Body fields:
//!   - `file` (required): the audio/video bytes
//!   - `language` (optional): BCP-47 language hint (e.g. "en") — improves
//!     accuracy and latency when known.

use axum::{
    extract::{Multipart, State},
    routing::post,
    Json, Router,
};

use crate::{error::ApiError, state::AppState, transcribe::TranscriptResult};

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(handle))
}

async fn handle(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TranscriptResult>, ApiError> {
    let client = state
        .transcribe()
        .ok_or(ApiError::Unavailable("transcription not configured"))?;

    let mut audio: Option<(bytes::Bytes, String)> = None;
    let mut language: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let file_name = field.file_name().unwrap_or("audio.bin").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                audio = Some((data, file_name));
            }
            "language" => {
                language = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?
                    .trim()
                    .to_lowercase()
                    .into();
            }
            _ => {}
        }
    }

    let (data, file_name) = audio.ok_or(ApiError::BadRequest("file field required".into()))?;
    let language = language.filter(|s| !s.is_empty());

    let result = client
        .transcribe(data, &file_name, language.as_deref())
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("{e}")))?;

    Ok(Json(result))
}
