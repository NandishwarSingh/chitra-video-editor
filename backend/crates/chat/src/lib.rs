//! OpenRouter-backed chat client with two-tier caching.
//!
//! ## Caching strategy
//!
//! 1. **Local response cache (Moka)** — keyed by a blake3 hash of the
//!    (system prompt, model, message history). On hit, we replay the cached
//!    assistant reply as a single SSE chunk. Useful for repeated questions
//!    inside an editing session and for retries after transient errors.
//!
//! 2. **Provider prompt cache (OpenRouter `cache_control`)** — for any
//!    sufficiently long system prompt or pinned context block, we attach an
//!    `{"type":"ephemeral"}` cache breakpoint so the provider (DeepSeek /
//!    Anthropic / OpenAI) hashes that prefix and reuses prefill compute on
//!    subsequent turns. This is the same mechanism Anthropic exposes under
//!    "prompt caching" and DeepSeek under "Context Caching on Disk".
//!
//! Both caches are opportunistic — a cold path produces a correct response,
//! a warm path produces a correct response faster and cheaper.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use chitra_core::{CacheHit, ChatMessage, ChatStreamEvent, EditorContext, TokenUsage};
use futures::stream::{Stream, StreamExt};
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use tracing::{debug, instrument, warn};

mod tools;
pub use tools::tool_catalog;

#[derive(Debug, Clone)]
pub struct ChatConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub default_system_prompt: String,
    pub cache_capacity: u64,
    pub cache_ttl: Duration,
    /// Threshold (in characters) above which the system prompt gets tagged
    /// with `cache_control: ephemeral` so the provider caches the prefill.
    pub prompt_cache_min_chars: usize,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api_key: String::new(),
            model: "deepseek/deepseek-v4-flash".to_string(),
            default_system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            cache_capacity: 10_000,
            cache_ttl: Duration::from_secs(60 * 60),
            prompt_cache_min_chars: 800,
        }
    }
}

const DEFAULT_SYSTEM_PROMPT: &str = r##"You are Chitra, an embedded AI assistant for the Chitra browser-native video editor.

You help the user reason about their timeline, suggest cuts, draft captions, find filler words, balance color, and explain features.

## Editor model: Edit Array Language (EAL)

Each turn you receive the COMPLETE current EAL program as part of the system context, plus the playhead and current selection. EAL is the editor's authoritative state representation: every clip, track, text overlay, transform, fade, effect, audio level, project setting — everything — is encoded in it.

EAL is a JSON array of instructions. Each instruction is a tuple `[opcode, ...payload]`. Common opcodes:
- `["schema", "chitra_edit_array", { "version": 1 }]` — required header
- `["project", { "name": ..., "settings": ... }]`
- `["timeline", { ... summary ... }]`
- `["export_settings", { "width": ..., "height": ..., "fps": ..., "sampleRate": 48000 }]`
- `["track", { "id": ..., "kind": "video"|"audio"|"text", "index": ..., "name": ..., "visible": ..., "muted": ..., "locked": ... }]`
- `["composite", { "mode": "track_order", "tracks": [...] }]`
- `["import", "video"|"audio", <name>, { ... metadata ... }]`
- `["clip", <assetId>, { "id": ..., "trackId": ..., "start": ..., "duration": ..., "from": ..., "to": ..., "fadeIn": ..., "fadeOut": ..., "muted": ..., "volume": ..., "effects": {...}, "transform": {...}, "layer": ... }]`
- `["audio", <clipId>, { "fadeIn": ..., "fadeOut": ..., "muted": ..., "volume": ... }]`
- `["effect", <clipId>, "color_grade", { "brightness": ..., "contrast": ..., "saturation": ... }]`
- `["cut", { "afterClip": <clip_id>, "at": "00:00:01.000" }]` — **splits** the referenced clip at the given timeline time. The runtime materialises each cut into one additional adjacent clip with the same asset / transform / volume. Multiple cuts on the same clip produce multiple adjacent pieces.
- `["text", <text>, { "id": ..., "trackId": ..., "at": ..., "end": ..., "duration": ..., "position": { "x": ..., "y": ... }, "size": ..., "align": ..., "color": ..., "fontFamily": ..., "bold": ..., ... }]`

Times are formatted as `"hh:mm:ss.mmm"` strings.

## How to edit

When the user asks for any change, emit the `apply_eal` tool call with the COMPLETE new program reflecting your intended timeline state. Do NOT emit a patch or a diff — emit the full new program. Start from the program in the context, copy it, modify the relevant instructions, emit the result. Always keep the load-bearing headers (`schema`, `project`, `timeline`, `track`, `composite`, `export_settings`) intact.

The editor compiles and validates your program. If it's malformed (unknown asset, overlap, out-of-range time), you'll see diagnostics on the next turn and can correct the program.

### Splitting a clip

Two equivalent ways to split clip `clip-a` (timelineStart 0, duration 8) at 1, 2, 3, 4 seconds — pick whichever is easier:

1. **Cut markers (preferred for beat-sync and N evenly-spaced splits)** — keep the original `clip` entry unchanged and emit one `cut` per split point. The runtime materialises adjacent pieces with the right `sourceIn` / `sourceOut`:
   ```
   ["clip", "asset-X", { "id": "clip-a", "start": "00:00:00.000", "duration": "00:00:08.000", "from": "00:00:00.000", "to": "00:00:08.000", ... }],
   ["cut", { "afterClip": "clip-a", "at": "00:00:01.000" }],
   ["cut", { "afterClip": "clip-a", "at": "00:00:02.000" }],
   ["cut", { "afterClip": "clip-a", "at": "00:00:03.000" }],
   ["cut", { "afterClip": "clip-a", "at": "00:00:04.000" }]
   ```
2. **Multiple adjacent clip entries** — explicitly list every piece with its own `id`, `start`, `from`, `to`, `duration`. Use this when pieces need different properties (different volumes, different fades, reordering).

A single `clip` entry with no `cut` markers will **stay one clip on the timeline** — it will not magically split itself.

## When NOT to use the tool

Use prose for explanations, judgement calls, asking clarifying questions, or any request that doesn't require a concrete state change. Don't emit `apply_eal` to "do nothing" — just reply with prose.

## Transcripts

You may receive `## Transcripts (clips at playhead)` blocks with per-segment timestamps. Treat the timestamps as **source-time** (relative to the asset, not the timeline). Translate by adding the clip's `start` and subtracting its `from` when proposing timeline-time edits.

## Subtitles

When the user asks for subtitles / captions / "burn in dialogue":
1. Read each spoken segment's source-time `[start-end]` from the transcript block.
2. Project to timeline-time with the clip's `start` and `from`:
   `timeline_time = clip.start + (source_time - clip.from)`.
3. Emit one `text` opcode per cue with the projected `at` (timeline-time start) and `end` (timeline-time end).
4. Style the cue. The user often asks for a specific template — apply the matching style fields:
   - **clean-lower-third**: `align: "center"`, `y: 0.85`, `size: 54`, `color: "#ffffff"`, `backgroundColor: "#000000b3"`, `bold: true`, `fontFamily: "inter"`
   - **bold-social**: `align: "center"`, `y: 0.78`, `size: 96`, `color: "#ffffff"`, `bold: true`, `strokeWidth: 6`, `strokeColor: "#000000"`, `fontFamily: "bebas"`, `textCase: "upper"`
   - **karaoke-highlight**: `align: "center"`, `y: 0.86`, `size: 72`, `color: "#f5cb47"`, `backgroundColor: "#000000d9"`, `bold: true`
   - **documentary**: `align: "center"`, `y: 0.88`, `size: 46`, `color: "#ffffff"`, `italic: true`, `fontFamily: "serif"`
   - **minimal-white**: `align: "center"`, `y: 0.87`, `size: 56`, `color: "#ffffff"`, `bold: true`, `shadowBlur: 6`, `shadowColor: "#000000a8"`
   - **boxed-caption**: `align: "center"`, `y: 0.85`, `size: 52`, `color: "#ffffff"`, `backgroundColor: "#000000ee"`, `bold: true`
5. Keep cues short — sentence or short-phrase length. Don't dump entire transcripts into one giant overlay.
6. Avoid overlap between successive cues; leave at least 40 ms of gap.
7. Use `trackId` of an existing `kind: "text"` track. If none exists, the editor auto-creates one.

## Beat grids and beat-sync edits

You may receive a `## Beat grids` section listing per-clip beat positions in **timeline-time seconds** (already projected — no translation needed). Each clip block lists `beats:` and, when known, `downbeats:` — the latter are bar starts (the "1" of each measure).

**Critical rule for beat sync**: a beat grid is *information about the music*, **not** an instruction to edit that music clip. The grid is the metronome you align *video clips* to. Inspect the EAL `layer:` field on each clip:

- `layer: "audio:..."` clips with a beat grid → these are the **reference track** (the music). They are the source of the metronome. **Never** emit `cut` markers on them and never modify their `start` / `end` / `from` / `to`. Edit them only if the user types something unambiguous like *"trim the song to 30 s"* or *"fade out the music at the end"*.
- `layer: "video:..."` clips → these are the **edit targets**. Splits, moves, trims, and `start` / `end` updates land here so the video matches the music's beats.

When the user says "beat sync this", "split this on the beats", "cut on every downbeat", "make cuts match the music", etc., the workflow is:
1. Read beat / downbeat timestamps from the **audio** clip's grid.
2. Build a new EAL where each *video* clip on the timeline is split with `cut` markers at those timestamps. If there are no video clips, ask the user which clip you should cut — do **not** cut the music as a workaround.
3. Leave every `layer: "audio:..."` clip's `start` / `end` / `from` / `to` untouched.

**Override for ambiguous selection**: if the user's selected clip is `layer: "audio:..."` but they say "beat sync" / "split on beats" / "cut on the beats", **disregard the selection**. The selection convention in editors is "the clip the user wants me to act on", but for beat-sync requests this convention does not apply — the user is treating the music as the metronome, not as the target. Cut the video clips, not the selected music.

Prefer **downbeats** for structural cuts (scene changes, title-card on/off) and ordinary **beats** for smaller transitions. If a clip has no beat list, ask the user to detect beats first or fall back to even-tempo cuts derived from the BPM if it's given.

Keep replies tight. This is a tool window, not a chatbot homepage."##;

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("missing OpenRouter API key — set CHITRA_LLM_API_KEY")]
    MissingApiKey,
    #[error("upstream provider error: {0}")]
    Upstream(String),
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct ChatClient {
    cfg: Arc<ChatConfig>,
    http: reqwest::Client,
    cache: Cache<String, CachedReply>,
}

#[derive(Clone)]
struct CachedReply {
    text: String,
    usage: Option<TokenUsage>,
}

/// Editor context split into a long cacheable prefix and a tiny tail that
/// changes on every interaction. Keeping them separate is the whole point:
/// the provider's prompt cache matches the stable prefix across turns and
/// only the volatile tail + new user message get reprocessed.
#[derive(Default, Clone)]
struct ContextBlocks {
    stable: String,
    volatile: String,
}

impl ChatClient {
    pub fn new(cfg: ChatConfig) -> Result<Self, ChatError> {
        if cfg.api_key.trim().is_empty() {
            return Err(ChatError::MissingApiKey);
        }
        let http = reqwest::Client::builder()
            // A *total* request timeout kills long-but-healthy streaming
            // generations: reasoning models (deepseek-v4-pro) on a large
            // editor context can stream for several minutes, and OpenRouter
            // sends ": OPENROUTER PROCESSING" keepalives the whole time.
            // Use a per-read timeout instead — it only trips on a genuine
            // stall (no bytes for 120 s), not on a slow overall response.
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(120))
            .build()?;
        let cache = Cache::builder()
            .max_capacity(cfg.cache_capacity)
            .time_to_live(cfg.cache_ttl)
            .build();
        Ok(Self {
            cfg: Arc::new(cfg),
            http,
            cache,
        })
    }

    fn cache_key(&self, system: &str, ctx: &ContextBlocks, messages: &[ChatMessage]) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(self.cfg.model.as_bytes());
        hasher.update(b"\x1e");
        hasher.update(system.as_bytes());
        hasher.update(b"\x1e");
        hasher.update(ctx.stable.as_bytes());
        hasher.update(b"\x1e");
        hasher.update(ctx.volatile.as_bytes());
        for m in messages {
            hasher.update(b"\x1e");
            hasher.update(m.role().as_bytes());
            hasher.update(b"\x1f");
            hasher.update(m.content().as_bytes());
        }
        hasher.finalize().to_hex().to_string()
    }

    fn resolve_system<'a>(&'a self, override_prompt: Option<&'a str>) -> &'a str {
        override_prompt
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(self.cfg.default_system_prompt.as_str())
    }

    /// Format the editor snapshot, split into a long *stable* block (project
    /// name, EAL program, transcripts, beat grids — identical across a Q&A
    /// flow) and a tiny *volatile* block (playhead, selection — changes on
    /// every scrub/click). The stable block forms a long cacheable prefix;
    /// the volatile block is appended AFTER it so a 1 ms playhead change
    /// doesn't invalidate the provider's prefix cache of the bulk context.
    fn format_context(&self, ctx: Option<&EditorContext>) -> ContextBlocks {
        let Some(ctx) = ctx else { return ContextBlocks::default() };

        // --- STABLE: the big, slow-changing bulk. Goes first so the
        //     provider prefix-cache covers as many tokens as possible. ---
        let mut buf = String::with_capacity(2048);
        if let Some(name) = &ctx.project_name {
            buf.push_str(&format!("## Project\nproject: {name}\n"));
        }
        buf.push_str("\n## Edit Array Language (current timeline)\n```eal\n");
        let pretty = serde_json::to_string_pretty(&ctx.edit_array).unwrap_or_else(|_| "[]".into());
        buf.push_str(&pretty);
        buf.push_str("\n```\n");

        if !ctx.transcripts.is_empty() {
            buf.push_str("\n## Transcripts (clips at playhead)\n");
            for t in &ctx.transcripts {
                let lang = t.language.as_deref().unwrap_or("?");
                buf.push_str(&format!("\n### {} (clip {}, lang {})\n", t.asset_id, t.clip_id, lang));
                buf.push_str(t.excerpt.trim());
                buf.push('\n');
            }
        }

        if !ctx.beats.is_empty() {
            buf.push_str("\n## Beat grids (timeline-time, seconds)\n");
            for b in &ctx.beats {
                let bpm = b.bpm.map(|v| format!("{v:.1}")).unwrap_or_else(|| "?".to_string());
                let kind = b.clip_kind.as_deref().unwrap_or("?");
                let role = match kind {
                    "audio" => "REFERENCE TRACK — DO NOT cut this clip",
                    "video" => "EDIT TARGET — cuts may land here",
                    _ => "kind unknown",
                };
                buf.push_str(&format!("\n### {} (clip {}, kind {}, ~{} BPM) [{}]\n", b.asset_id, b.clip_id, kind, bpm, role));
                let beats_str = b
                    .timeline_beats
                    .iter()
                    .map(|t| format!("{t:.2}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                buf.push_str("beats: ");
                buf.push_str(&beats_str);
                buf.push('\n');
                if !b.timeline_downbeats.is_empty() {
                    let downbeats_str = b
                        .timeline_downbeats
                        .iter()
                        .map(|t| format!("{t:.2}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    buf.push_str("downbeats: ");
                    buf.push_str(&downbeats_str);
                    buf.push('\n');
                }
            }
        }

        // --- VOLATILE: a few hundred bytes that change every interaction.
        //     Kept OUT of the cacheable prefix so scrubbing/selecting never
        //     forces a full context reprocess. ---
        let mut vol = String::with_capacity(256);
        vol.push_str("## Live editor state (volatile)\n");
        vol.push_str(&format!("playhead: {:.3}s\n", ctx.playhead_seconds));
        if let Some(id) = &ctx.active_clip_id {
            vol.push_str(&format!("active_clip: {id}\n"));
        }
        if let Some(id) = &ctx.selected_clip_id {
            vol.push_str(&format!("selected_clip: {id}\n"));
        }
        if let Some(id) = &ctx.selected_text_id {
            vol.push_str(&format!("selected_text: {id}\n"));
        }
        if let Some(id) = &ctx.selected_track_id {
            vol.push_str(&format!("selected_track: {id}\n"));
        }

        ContextBlocks { stable: buf, volatile: vol }
    }

    /// Build the OpenRouter request body, attaching `cache_control: ephemeral`
    /// to the system prompt when it's long enough to be worth caching.
    ///
    /// OpenRouter accepts Anthropic-style content blocks even for non-Anthropic
    /// models; providers that don't support cache_control silently ignore it,
    /// providers that do (DeepSeek, Anthropic) use it as a prefix cache point.
    fn build_payload(
        &self,
        system: &str,
        ctx: &ContextBlocks,
        messages: &[ChatMessage],
        stream: bool,
    ) -> serde_json::Value {
        let mut payload_messages = Vec::with_capacity(messages.len() + 3);
        let min = self.cfg.prompt_cache_min_chars;

        // Helper: a system message, cache-tagged when long enough to be worth
        // a provider prefix-cache breakpoint. DeepSeek auto-caches prefixes
        // regardless; the explicit breakpoint additionally lets Anthropic-
        // family models cache, and is silently ignored by providers that
        // don't support it.
        let sys_block = |text: &str, cache: bool| {
            if cache && text.len() >= min {
                json!({
                    "role": "system",
                    "content": [{
                        "type": "text",
                        "text": text,
                        "cache_control": {"type": "ephemeral"}
                    }]
                })
            } else {
                json!({"role": "system", "content": text})
            }
        };

        // Order is the optimization. Longest-lived content first so the
        // cacheable prefix is maximal:
        //   1. Static system prompt          (never changes)   — cached
        //   2. Stable editor context         (EAL+transcripts) — cached
        //   3. Volatile state                (playhead/sel)    — NOT cached
        //   4. User/assistant turns          (the new delta)
        // Breakpoints 1 and 2 mean: even when the timeline (EAL) changes,
        // the system-prompt prefix still hits; when only the playhead moves,
        // BOTH the system prompt AND the entire stable block still hit and
        // only a few hundred volatile bytes + the user message reprocess.
        if !system.is_empty() {
            payload_messages.push(sys_block(system, true));
        }
        if !ctx.stable.is_empty() {
            payload_messages.push(sys_block(&ctx.stable, true));
        }
        if !ctx.volatile.is_empty() {
            payload_messages.push(sys_block(&ctx.volatile, false));
        }

        for msg in messages {
            payload_messages.push(json!({
                "role": msg.role(),
                "content": msg.content(),
            }));
        }

        json!({
            "model": self.cfg.model,
            "messages": payload_messages,
            "stream": stream,
            "usage": {"include": true},
            "tools": tool_catalog(),
            "tool_choice": "auto",
        })
    }

    /// Non-streaming entry point. Returns the full reply text plus cache/usage info.
    #[instrument(skip_all, fields(model = %self.cfg.model))]
    pub async fn complete(
        &self,
        system_override: Option<&str>,
        messages: &[ChatMessage],
        context: Option<&EditorContext>,
    ) -> Result<(String, CacheHit, Option<TokenUsage>), ChatError> {
        let system = self.resolve_system(system_override);
        let context_block = self.format_context(context);
        let key = self.cache_key(system, &context_block, messages);

        if let Some(hit) = self.cache.get(&key).await {
            debug!("local cache hit");
            return Ok((hit.text, CacheHit::Local, hit.usage));
        }

        let payload = self.build_payload(system, &context_block, messages, false);
        let resp = self
            .http
            .post(format!("{}/chat/completions", self.cfg.base_url.trim_end_matches('/')))
            .bearer_auth(&self.cfg.api_key)
            .header("HTTP-Referer", "https://chitra.local")
            .header("X-Title", "Chitra Video Editor")
            .json(&payload)
            .send()
            .await?
            .error_for_status()
            .map_err(|e| ChatError::Upstream(e.to_string()))?;

        let body: OpenRouterCompletion = resp.json().await?;
        let text = body
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.unwrap_or_default())
            .unwrap_or_default();
        let usage = body.usage.map(Into::into);
        let cache_hit = classify_cache(usage.as_ref());

        self.cache
            .insert(key, CachedReply { text: text.clone(), usage })
            .await;

        Ok((text, cache_hit, usage))
    }

    /// Streaming entry point. Yields a sequence of `ChatStreamEvent`s suitable
    /// for forwarding over SSE. On a local cache hit, we emit a single
    /// synthetic `Delta` and a `Done` immediately. On a miss, we proxy
    /// OpenRouter's SSE stream chunk-by-chunk.
    pub fn stream(
        &self,
        system_override: Option<&str>,
        messages: Vec<ChatMessage>,
        context: Option<EditorContext>,
    ) -> impl Stream<Item = ChatStreamEvent> + Send + 'static {
        let client = self.clone();
        let system_owned = self.resolve_system(system_override).to_string();
        let context_owned = client.format_context(context.as_ref());
        async_stream::stream! {
            let key = client.cache_key(&system_owned, &context_owned, &messages);

            if let Some(hit) = client.cache.get(&key).await {
                debug!("local cache hit (stream)");
                yield ChatStreamEvent::Delta { text: hit.text };
                yield ChatStreamEvent::Done { cache: CacheHit::Local, usage: hit.usage };
                return;
            }

            let payload = client.build_payload(&system_owned, &context_owned, &messages, true);
            let send = client
                .http
                .post(format!(
                    "{}/chat/completions",
                    client.cfg.base_url.trim_end_matches('/')
                ))
                .bearer_auth(&client.cfg.api_key)
                .header("HTTP-Referer", "https://chitra.local")
                .header("X-Title", "Chitra Video Editor")
                .header("Accept", "text/event-stream")
                .json(&payload)
                .send()
                .await;

            let resp = match send {
                Ok(r) => match r.error_for_status() {
                    Ok(r) => r,
                    Err(e) => {
                        yield ChatStreamEvent::Error { message: format!("upstream {e}") };
                        return;
                    }
                },
                Err(e) => {
                    yield ChatStreamEvent::Error { message: e.to_string() };
                    return;
                }
            };

            let mut accumulated = String::new();
            let mut final_usage: Option<TokenUsage> = None;
            let mut tool_calls: HashMap<u32, PendingToolCall> = HashMap::new();
            let mut byte_stream = resp.bytes_stream();
            let mut buffer: Vec<u8> = Vec::new();

            while let Some(chunk) = byte_stream.next().await {
                let chunk: Bytes = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield ChatStreamEvent::Error { message: e.to_string() };
                        return;
                    }
                };
                buffer.extend_from_slice(&chunk);

                // SSE frames are separated by a blank line (\n\n). Parse each
                // complete frame and leave any trailing partial frame in the
                // buffer for the next iteration.
                while let Some(pos) = find_double_newline(&buffer) {
                    let frame = buffer.drain(..pos + 2).collect::<Vec<u8>>();
                    let frame_str = match std::str::from_utf8(&frame) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };

                    for line in frame_str.lines() {
                        let line = line.trim_start();
                        let Some(payload) = line.strip_prefix("data:") else { continue };
                        let payload = payload.trim();
                        if payload.is_empty() { continue; }
                        if payload == "[DONE]" {
                            // Flush any tool calls whose arguments parsed
                            // successfully even though we never saw a
                            // finish_reason. Best-effort.
                            for (_, mut pending) in tool_calls.drain() {
                                if pending.emitted { continue; }
                                if let Some(event) = try_finalize_tool(&mut pending) {
                                    yield event;
                                }
                            }
                            let cache = classify_cache(final_usage.as_ref());
                            client
                                .cache
                                .insert(
                                    key.clone(),
                                    CachedReply { text: accumulated.clone(), usage: final_usage },
                                )
                                .await;
                            yield ChatStreamEvent::Done { cache, usage: final_usage };
                            return;
                        }

                        match serde_json::from_str::<OpenRouterChunk>(payload) {
                            Ok(parsed) => {
                                if let Some(choice) = parsed.choices.into_iter().next() {
                                    if let Some(delta) = choice.delta.content {
                                        if !delta.is_empty() {
                                            accumulated.push_str(&delta);
                                            yield ChatStreamEvent::Delta { text: delta };
                                        }
                                    }
                                    if let Some(deltas) = choice.delta.tool_calls {
                                        for tc in deltas {
                                            let entry = tool_calls
                                                .entry(tc.index)
                                                .or_insert_with(PendingToolCall::default);
                                            if let Some(id) = tc.id {
                                                entry.id = id;
                                            }
                                            if let Some(func) = tc.function {
                                                if let Some(name) = func.name {
                                                    entry.name = name;
                                                }
                                                if let Some(args) = func.arguments {
                                                    entry.arguments_buffer.push_str(&args);
                                                }
                                            }
                                            // Try to finalize whenever the
                                            // buffer parses as valid JSON.
                                            // This avoids waiting for
                                            // finish_reason on providers that
                                            // don't emit it consistently.
                                            if !entry.emitted {
                                                if let Some(event) = try_finalize_tool(entry) {
                                                    yield event;
                                                }
                                            }
                                        }
                                    }
                                }
                                if let Some(usage) = parsed.usage {
                                    final_usage = Some(usage.into());
                                }
                            }
                            Err(e) => {
                                warn!(err=?e, frame=%payload, "failed to parse SSE chunk");
                            }
                        }
                    }
                }
            }

            // Stream ended without an explicit [DONE] — flush whatever we have.
            for (_, mut pending) in tool_calls.drain() {
                if pending.emitted { continue; }
                if let Some(event) = try_finalize_tool(&mut pending) {
                    yield event;
                }
            }
            if !accumulated.is_empty() {
                client
                    .cache
                    .insert(
                        key,
                        CachedReply { text: accumulated, usage: final_usage },
                    )
                    .await;
            }
            yield ChatStreamEvent::Done {
                cache: classify_cache(final_usage.as_ref()),
                usage: final_usage,
            };
        }
    }
}

/// Try to parse a pending tool call's accumulated argument buffer as JSON
/// and, on success, emit the corresponding `ToolCall` event and mark it as
/// emitted so it isn't re-emitted later.
fn try_finalize_tool(pending: &mut PendingToolCall) -> Option<ChatStreamEvent> {
    if pending.name.is_empty() {
        return None;
    }
    let trimmed = pending.arguments_buffer.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    pending.emitted = true;
    Some(ChatStreamEvent::ToolCall {
        id: if pending.id.is_empty() {
            format!("tool-{}", blake3::hash(pending.name.as_bytes()).to_hex())
        } else {
            std::mem::take(&mut pending.id)
        },
        name: std::mem::take(&mut pending.name),
        arguments: parsed,
    })
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn classify_cache(usage: Option<&TokenUsage>) -> CacheHit {
    match usage {
        Some(u) if u.prompt_cache_hit_tokens > 0 => CacheHit::Provider,
        _ => CacheHit::Miss,
    }
}

// ---------- OpenRouter wire shapes ----------

#[derive(Debug, Deserialize)]
struct OpenRouterCompletion {
    choices: Vec<OrChoice>,
    #[serde(default)]
    usage: Option<OrUsage>,
}

#[derive(Debug, Deserialize)]
struct OrChoice {
    message: OrMessage,
}

#[derive(Debug, Deserialize)]
struct OrMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterChunk {
    choices: Vec<OrChunkChoice>,
    #[serde(default)]
    usage: Option<OrUsage>,
}

#[derive(Debug, Deserialize)]
struct OrChunkChoice {
    delta: OrDelta,
    #[serde(default)]
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OrDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OrToolCallDelta>>,
}

/// A fragment of a tool call. `arguments` arrives in pieces of JSON text;
/// `id` and `function.name` show up once on the first fragment for each index.
#[derive(Debug, Deserialize)]
struct OrToolCallDelta {
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OrToolCallFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct OrToolCallFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments_buffer: String,
    emitted: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, Default)]
struct OrUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
    /// OpenRouter / DeepSeek report cached prefix tokens here. Field name
    /// varies — accept any of the canonical spellings.
    #[serde(default, alias = "prompt_cache_hit_tokens", alias = "cached_tokens", alias = "prompt_tokens_cached")]
    prompt_cache_hit_tokens: u32,
}

impl From<OrUsage> for TokenUsage {
    fn from(u: OrUsage) -> Self {
        Self {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            prompt_cache_hit_tokens: u.prompt_cache_hit_tokens,
        }
    }
}
