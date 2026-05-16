//! Object segmentation / rotoscoping endpoint. Multipart upload:
//!   - `file`   (required): the video clip bytes (the selected source range)
//!   - `prompt` (required): JSON prompt in source-pixel coords —
//!       {"frame":0,"points":[[x,y]],"labels":[1]}  or
//!       {"frame":0,"box":[x0,y0,x1,y1]}
//!
//! Returns the EfficientTAM mask track: a base64 grayscale mask video plus
//! dims/fps so the frontend can persist + composite it. Synchronous like
//! `/api/transcribe` (v1); a job/progress model is the next hardening step.

use axum::{
    extract::{Multipart, State},
    routing::post,
    Json, Router,
};

use crate::{error::ApiError, segment::SegmentResult, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(handle))
}

async fn handle(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<SegmentResult>, ApiError> {
    let client = state
        .segment()
        .ok_or(ApiError::Unavailable("segmentation not configured"))?;

    let mut video: Option<(bytes::Bytes, String)> = None;
    let mut prompt: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let file_name = field.file_name().unwrap_or("clip.bin").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                video = Some((data, file_name));
            }
            "prompt" => {
                prompt = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?
                    .into();
            }
            _ => {}
        }
    }

    let (data, file_name) = video.ok_or(ApiError::BadRequest("file field required".into()))?;
    let prompt = prompt
        .filter(|s| !s.trim().is_empty())
        .ok_or(ApiError::BadRequest("prompt field required".into()))?;

    let result = client
        .segment(data, &file_name, &prompt)
        .await
        .map_err(|e| match e {
            crate::segment::SegmentError::Disabled => {
                ApiError::Unavailable("segmentation not configured")
            }
            crate::segment::SegmentError::BadPrompt(m) => ApiError::BadRequest(m),
            other => ApiError::Internal(anyhow::anyhow!("{other}")),
        })?;

    Ok(Json(result))
}
