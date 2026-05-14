use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn handler(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "chitra-api",
        "storage": state.storage().is_some(),
    }))
}
