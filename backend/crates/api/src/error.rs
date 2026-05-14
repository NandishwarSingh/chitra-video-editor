//! Unified API error type. Converts internal errors into JSON responses with
//! appropriate HTTP status codes. Routes return `Result<T, ApiError>` and
//! let the `IntoResponse` impl do the rest — no boilerplate at call sites.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;
use tracing::error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error(transparent)]
    Chat(#[from] chitra_chat::ChatError),
    #[error(transparent)]
    Storage(#[from] chitra_storage::StorageError),
    #[error(transparent)]
    Transcode(#[from] chitra_transcode::TranscodeError),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("not found")]
    NotFound,
    #[error("feature unavailable: {0}")]
    Unavailable(&'static str),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.clone()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found", "resource not found".to_string()),
            ApiError::Unavailable(reason) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                (*reason).to_string(),
            ),
            ApiError::Chat(chitra_chat::ChatError::MissingApiKey) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "missing_api_key",
                "OpenRouter API key not configured".to_string(),
            ),
            ApiError::Chat(err) => (StatusCode::BAD_GATEWAY, "chat_upstream", err.to_string()),
            ApiError::Storage(_) | ApiError::Transcode(_) | ApiError::Internal(_) => {
                error!(error = ?self, "internal api error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error".to_string(),
                )
            }
        };

        let body = Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        }));
        (status, body).into_response()
    }
}
