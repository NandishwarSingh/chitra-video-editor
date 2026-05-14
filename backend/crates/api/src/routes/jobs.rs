use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use chitra_core::TranscodeJob;
use serde::Deserialize;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(enqueue))
        .route("/:id", get(detail))
}

#[derive(Deserialize)]
struct EnqueueBody {
    project_id: Uuid,
}

async fn enqueue(
    State(state): State<AppState>,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<TranscodeJob>, ApiError> {
    Ok(Json(state.transcode().enqueue(body.project_id).await))
}

async fn list(State(state): State<AppState>) -> Json<Vec<TranscodeJob>> {
    Json(state.transcode().list().await)
}

async fn detail(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TranscodeJob>, ApiError> {
    Ok(Json(state.transcode().get(id).await?))
}
