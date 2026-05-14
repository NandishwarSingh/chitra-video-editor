//! Asset upload endpoint. Accepts a multipart body, streams it to object
//! storage, returns a metadata record. Heavy ffprobe/duration extraction
//! happens lazily on first read (or via a follow-up `POST /:id/probe` call
//! once the transcode worker is wired in).

use axum::{
    extract::{Multipart, State},
    Json, Router,
    routing::post,
};
use chitra_core::{AssetKind, AssetRecord};
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(upload))
}

async fn upload(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<AssetRecord>, ApiError> {
    let storage = state.storage().ok_or(ApiError::Unavailable("storage not configured"))?;

    let mut project_id: Option<Uuid> = None;
    let mut kind = AssetKind::Video;
    let mut file_name: Option<String> = None;
    let mut bytes_collected: i64 = 0;
    let mut storage_key: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        match field.name().unwrap_or("") {
            "project_id" => {
                let s = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                project_id = Some(Uuid::parse_str(&s).map_err(|_| ApiError::BadRequest("bad project_id".into()))?);
            }
            "kind" => {
                let s = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                kind = match s.as_str() {
                    "audio" => AssetKind::Audio,
                    _ => AssetKind::Video,
                };
            }
            "file" => {
                let name = field.file_name().unwrap_or("upload.bin").to_string();
                file_name = Some(name.clone());
                let key = format!("{}/{}/{}", project_id.unwrap_or_else(Uuid::nil), Uuid::new_v4(), name);
                // Buffer the file into memory and write to the object store in
                // one shot. This is fine for typical clip sizes (<200 MB); for
                // larger uploads we'd switch to a multipart upload here.
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                bytes_collected = data.len() as i64;
                let path = object_store::path::Path::from(key.as_str());
                storage
                    .objects()
                    .put(&path, data.into())
                    .await
                    .map_err(chitra_storage::StorageError::from)?;
                storage_key = Some(key);
            }
            _ => {}
        }
    }

    let project_id = project_id.ok_or(ApiError::BadRequest("project_id required".into()))?;
    let storage_key = storage_key.ok_or(ApiError::BadRequest("file required".into()))?;
    let name = file_name.unwrap_or_else(|| "upload.bin".to_string());

    Ok(Json(
        storage
            .record_asset(project_id, kind, name, storage_key, bytes_collected)
            .await?,
    ))
}
