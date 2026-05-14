//! Chat routes — both streaming (SSE) and non-streaming JSON.
//!
//! The browser-side `ChatPanel` consumes the streaming endpoint. The
//! non-streaming variant exists for tooling and tests that prefer a single
//! request/response cycle.

use axum::{
    extract::State,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::post,
    Json, Router,
};
use chitra_core::{ChatReply, ChatRequest, ChatStreamEvent};
use futures::{Stream, StreamExt};
use std::convert::Infallible;
use std::time::Duration;

use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(handler))
}

async fn handler(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<axum::response::Response, ApiError> {
    if req.messages.is_empty() {
        return Err(ApiError::BadRequest("messages array is empty".into()));
    }

    if req.stream {
        let stream = sse_stream(state, req);
        return Ok(Sse::new(stream)
            .keep_alive(
                axum::response::sse::KeepAlive::new()
                    .interval(Duration::from_secs(15))
                    .text(":ka"),
            )
            .into_response());
    }

    let (reply, cache, usage) = state
        .chat()
        .complete(req.system.as_deref(), &req.messages, req.context.as_ref())
        .await?;

    Ok(Json(ChatReply { reply, cache, usage }).into_response())
}

fn sse_stream(
    state: AppState,
    req: ChatRequest,
) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
    let inner = state.chat().stream(req.system.as_deref(), req.messages, req.context);
    inner.map(|event: ChatStreamEvent| {
        let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{\"type\":\"error\"}".to_string());
        Ok(Event::default().data(payload))
    })
}
