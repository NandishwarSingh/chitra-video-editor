use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chitra_core::ProjectRecord;
use serde::Deserialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/:id", post(upsert))
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<ProjectRecord>>, ApiError> {
    let storage = state.storage().ok_or(ApiError::Unavailable("storage not configured"))?;
    Ok(Json(storage.list_projects().await?))
}

#[derive(Deserialize)]
struct CreateProject {
    name: String,
    edit_array: Value,
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<CreateProject>,
) -> Result<Json<ProjectRecord>, ApiError> {
    let storage = state.storage().ok_or(ApiError::Unavailable("storage not configured"))?;
    let now = OffsetDateTime::now_utc();
    let record = ProjectRecord {
        id: Uuid::new_v4(),
        name: input.name,
        edit_array: input.edit_array,
        created_at: now,
        updated_at: now,
    };
    Ok(Json(storage.upsert_project(record).await?))
}

async fn upsert(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<CreateProject>,
) -> Result<Json<ProjectRecord>, ApiError> {
    let storage = state.storage().ok_or(ApiError::Unavailable("storage not configured"))?;
    let now = OffsetDateTime::now_utc();
    let record = ProjectRecord {
        id,
        name: input.name,
        edit_array: input.edit_array,
        created_at: now,
        updated_at: now,
    };
    Ok(Json(storage.upsert_project(record).await?))
}
