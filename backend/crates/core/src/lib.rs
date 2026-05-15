//! Shared types between the API server and its sibling crates.
//!
//! Keep this crate tiny and dependency-light. It only owns the over-the-wire
//! shapes the browser will see and a few enums/IDs that every other crate
//! consumes. Don't pull in tokio, sqlx, or reqwest here.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// A single message in a chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase", tag = "role", content = "content")]
pub enum ChatMessage {
    System(String),
    User(String),
    Assistant(String),
}

impl ChatMessage {
    pub fn role(&self) -> &'static str {
        match self {
            ChatMessage::System(_) => "system",
            ChatMessage::User(_) => "user",
            ChatMessage::Assistant(_) => "assistant",
        }
    }

    pub fn content(&self) -> &str {
        match self {
            ChatMessage::System(s) | ChatMessage::User(s) | ChatMessage::Assistant(s) => s,
        }
    }
}

/// Request body for `POST /api/chat`. The browser sends the full conversation
/// (no server-side session state) so the backend stays horizontally scalable.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    /// Optional override of the system prompt. Falls back to the server default.
    #[serde(default)]
    pub system: Option<String>,
    /// If true, the response is streamed via SSE; otherwise a single JSON reply.
    #[serde(default = "default_true")]
    pub stream: bool,
    /// Live editor context — the current timeline state, selection, and
    /// playhead. Attached as a pinned system block so the model sees what the
    /// user is actually working on, not just the chat history.
    #[serde(default)]
    pub context: Option<EditorContext>,
}

/// Snapshot of the editor that travels with every chat turn. Cheap to send,
/// hugely valuable for the model: it grounds "tighten the intro" or
/// "what's selected" in real data instead of hallucination.
#[derive(Debug, Clone, Deserialize)]
pub struct EditorContext {
    /// Compiled Edit Array Language program. The model treats this as the
    /// ground-truth definition of the timeline.
    pub edit_array: serde_json::Value,
    /// Current playhead position in seconds.
    pub playhead_seconds: f64,
    /// IDs of the user's current selection, if any.
    #[serde(default)]
    pub selected_clip_id: Option<String>,
    #[serde(default)]
    pub selected_text_id: Option<String>,
    #[serde(default)]
    pub selected_track_id: Option<String>,
    /// The clip currently rendered in the viewer (topmost at playhead).
    #[serde(default)]
    pub active_clip_id: Option<String>,
    /// Human-readable project name (shown to the model so it can refer to it).
    #[serde(default)]
    pub project_name: Option<String>,
    /// Transcript excerpts for clips at the playhead. Used by the model to
    /// reason about spoken content (find filler words, cut at sentence
    /// boundaries, generate captions, etc).
    #[serde(default)]
    pub transcripts: Vec<TranscriptExcerpt>,
    /// Beat grids per clip. Empty when the user hasn't detected beats yet.
    /// Times are timeline-time (not source-time) so the model can drop them
    /// directly into `start` / `at` fields without re-projection.
    #[serde(default)]
    pub beats: Vec<BeatExcerpt>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BeatExcerpt {
    pub asset_id: String,
    pub clip_id: String,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub timeline_beats: Vec<f64>,
    /// Subset of `timeline_beats` that fall on bar starts. The model is told
    /// to prefer these for structural cuts (chorus entry, scene change).
    #[serde(default)]
    pub timeline_downbeats: Vec<f64>,
    /// "audio" or "video" — lets the model distinguish the music reference
    /// track (audio) from a video clip that happens to have detected beats.
    #[serde(default)]
    pub clip_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptExcerpt {
    pub asset_id: String,
    pub clip_id: String,
    /// Pre-formatted transcript text with timestamps. Frontend caps the length
    /// before sending to keep the prompt budget under control.
    pub excerpt: String,
    #[serde(default)]
    pub language: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Non-streaming reply shape (`POST /api/chat` when `stream: false`).
#[derive(Debug, Clone, Serialize)]
pub struct ChatReply {
    pub reply: String,
    pub cache: CacheHit,
    pub usage: Option<TokenUsage>,
}

/// Streaming event sent over SSE. Frontend reconstructs the full reply by
/// concatenating `delta` events until it sees a `done` event.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    /// Incremental text fragment.
    Delta { text: String },
    /// Model has decided to propose a structured edit. The frontend renders
    /// this as an "Apply / Discard" card and, on apply, dispatches the
    /// corresponding reducer action. Tool calls are emitted only when the
    /// arguments JSON has finished streaming in — partial fragments are
    /// accumulated server-side and never reach the client.
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Conversation complete. Includes cache status and (when reported by the
    /// provider) token usage.
    Done {
        cache: CacheHit,
        usage: Option<TokenUsage>,
    },
    /// Recoverable provider error surfaced to the client.
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CacheHit {
    /// Local LRU hit — the whole response was served from memory, no provider call.
    Local,
    /// Provider reported a prompt-cache prefix hit (DeepSeek / Anthropic caching).
    Provider,
    /// Cold path — no caching engaged.
    Miss,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// Tokens served from the provider's prompt cache (reported by DeepSeek/Anthropic).
    pub prompt_cache_hit_tokens: u32,
}

/// A persisted project record — minimal scaffold; expand as the sync feature
/// grows. Keep it stable: the frontend's IndexedDB schema mirrors this.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: Uuid,
    pub name: String,
    /// Compiled Edit Array Language program. The frontend sends this back
    /// unchanged on save, the backend stores it as-is.
    pub edit_array: serde_json::Value,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// Metadata about an uploaded asset (video / audio file).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub kind: AssetKind,
    pub original_name: String,
    pub storage_key: String,
    pub size_bytes: i64,
    pub duration_seconds: Option<f64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub uploaded_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Video,
    Audio,
}

/// State machine for a transcode/export job.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscodeJob {
    pub id: Uuid,
    pub project_id: Uuid,
    pub status: JobStatus,
    pub progress: f32,
    pub error: Option<String>,
    pub output_key: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

