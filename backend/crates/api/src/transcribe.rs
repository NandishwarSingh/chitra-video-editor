//! Speech-to-text. Three providers, all normalised to one `TranscriptResult`:
//!
//! - **whisper_cpp** (default): shells out to a local `whisper-cli` binary.
//!   Audio is normalised to 16 kHz mono WAV by ffmpeg first. Now invoked
//!   with Silero VAD pre-segmentation, `--suppress-nst`, and `-mc 0` to
//!   prevent silence-region hallucinations and context cascade. Install
//!   on macOS with `brew install whisper-cpp` and point
//!   `CHITRA_WHISPER_MODEL` at a `ggml-*.bin`. Strongly recommend also
//!   pointing `CHITRA_WHISPER_VAD_MODEL` at `ggml-silero-v5.1.2.bin`.
//!
//! - **whisperx**: shells out to a Python venv running `scripts/
//!   whisperx_runner.py`. Uses faster-whisper for recognition and wav2vec2
//!   for forced alignment, giving ±10–30 ms word timestamps. Heaviest
//!   option, best quality. Set up with `./scripts/install-whisperx.sh`
//!   then point `CHITRA_WHISPERX_PYTHON` at the venv's python.
//!
//! - **groq**: cloud Whisper-large-v3-turbo. One-line opt-in for users
//!   who don't want a local toolchain.
//!
//! All three paths converge on `run_post_filters` which drops the standard
//! hallucination phrases ("Thanks for watching", "[Music]", etc.), repairs
//! whisper.cpp's degenerate per-token timestamps, and filters segments
//! whose average token probability is below 0.35.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use bytes::Bytes;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

#[derive(Debug, Clone)]
pub struct TranscribeConfig {
    pub provider: String,

    // Groq settings (only consulted when provider == "groq")
    pub api_key: String,
    pub model: String,
    pub base_url: String,

    // whisper.cpp settings (only consulted when provider == "whisper_cpp")
    pub whisper_bin: String,
    pub whisper_model: String,
    pub whisper_vad_model: String,
    pub whisperx_python: String,
    pub whisperx_model: String,
    pub whisperx_runner: String,
    pub ffmpeg_path: String,
    pub whisper_threads: u32,
}

impl TranscribeConfig {
    pub fn is_enabled(&self) -> bool {
        match self.provider.as_str() {
            "groq" => !self.api_key.is_empty(),
            "whisper_cpp" => !self.whisper_model.is_empty() && !self.whisper_bin.is_empty(),
            "whisperx" => !self.whisperx_python.is_empty() && !self.whisperx_runner.is_empty(),
            _ => false,
        }
    }
}

impl Default for TranscribeConfig {
    fn default() -> Self {
        Self {
            provider: "whisper_cpp".into(),
            api_key: String::new(),
            model: "whisper-large-v3-turbo".into(),
            base_url: "https://api.groq.com/openai/v1".into(),
            whisper_bin: "whisper-cli".into(),
            whisper_model: String::new(),
            whisper_vad_model: String::new(),
            whisperx_python: String::new(),
            whisperx_model: "large-v3-turbo".into(),
            whisperx_runner: String::new(),
            ffmpeg_path: "ffmpeg".into(),
            whisper_threads: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptResult {
    pub text: String,
    pub language: Option<String>,
    pub duration: Option<f64>,
    pub words: Vec<TranscriptWord>,
    pub segments: Vec<TranscriptSegment>,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Error)]
pub enum TranscribeError {
    #[error("transcription disabled: configure CHITRA_STT_PROVIDER and its credentials")]
    Disabled,
    #[error("unsupported STT provider: {0}")]
    UnsupportedProvider(String),
    #[error("transcription provider error: {0}")]
    Upstream(String),
    #[error("local toolchain error: {0}")]
    Local(String),
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub struct TranscribeClient {
    cfg: TranscribeConfig,
    http: reqwest::Client,
}

impl TranscribeClient {
    pub fn new(cfg: TranscribeConfig) -> Result<Self, TranscribeError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()?;
        Ok(Self { cfg, http })
    }

    pub fn is_enabled(&self) -> bool {
        self.cfg.is_enabled()
    }

    pub fn provider(&self) -> &str {
        &self.cfg.provider
    }

    #[instrument(skip_all, fields(provider = %self.cfg.provider, bytes = audio.len()))]
    pub async fn transcribe(
        &self,
        audio: Bytes,
        file_name: &str,
        language_hint: Option<&str>,
    ) -> Result<TranscriptResult, TranscribeError> {
        if !self.is_enabled() {
            return Err(TranscribeError::Disabled);
        }
        match self.cfg.provider.as_str() {
            "groq" => self.transcribe_groq(audio, file_name, language_hint).await,
            "whisper_cpp" => self.transcribe_whisper_cpp(audio, file_name, language_hint).await,
            "whisperx" => self.transcribe_whisperx(audio, file_name, language_hint).await,
            other => Err(TranscribeError::UnsupportedProvider(other.to_string())),
        }
    }

    // ---------- WhisperX (local Python subprocess) ----------
    //
    // WhisperX gives word-accurate timestamps via wav2vec2 forced alignment
    // on top of faster-whisper. The Python runner script returns a JSON
    // document in the same shape as whisper.cpp's -ojf output, so the rest
    // of this module (hallucination filter, degenerate-time repair, word
    // reconstruction) keeps working unchanged.
    async fn transcribe_whisperx(
        &self,
        audio: Bytes,
        file_name: &str,
        language_hint: Option<&str>,
    ) -> Result<TranscriptResult, TranscribeError> {
        let workdir = TempDir::new().map_err(TranscribeError::Io)?;
        let input_path = workdir.path().join(sanitise(file_name));
        let wav_path = workdir.path().join("audio.wav");

        {
            let mut file = tokio::fs::File::create(&input_path).await?;
            file.write_all(&audio).await?;
            file.flush().await?;
        }

        // Normalise to 16 kHz mono WAV. WhisperX accepts other formats too
        // but this matches the whisper_cpp path and gives deterministic
        // behavior across decoders.
        let ffmpeg_status = Command::new(&self.cfg.ffmpeg_path)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-i",
                input_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 input path".into()))?,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                wav_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 wav path".into()))?,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| TranscribeError::Local(format!("failed to spawn ffmpeg ({}): {e}", self.cfg.ffmpeg_path)))?;

        if !ffmpeg_status.status.success() {
            let stderr = String::from_utf8_lossy(&ffmpeg_status.stderr);
            return Err(TranscribeError::Local(format!("ffmpeg failed: {}", stderr.trim())));
        }

        let real_duration = probe_duration_seconds(&self.cfg.ffmpeg_path, &input_path).await.ok();

        // Write the runner's JSON to a known file rather than piping it
        // through stdout — torch.hub and pyannote spray progress bars and
        // INFO logs into stdout/stderr unpredictably, so a stdout pipe is
        // not safe.
        let out_json_path = workdir.path().join("whisperx.json");
        let mut cmd = Command::new(&self.cfg.whisperx_python);
        cmd.args([
            &self.cfg.whisperx_runner,
            wav_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 wav path".into()))?,
            &self.cfg.whisperx_model,
            out_json_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 out json path".into()))?,
        ]);
        if let Some(lang) = language_hint {
            cmd.arg(lang);
        }
        debug!(?cmd, "spawning whisperx runner");

        let output = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| TranscribeError::Local(format!("failed to spawn python ({}): {e}", self.cfg.whisperx_python)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TranscribeError::Local(format!("whisperx_runner failed: {}", stderr.trim())));
        }

        let raw = tokio::fs::read_to_string(&out_json_path).await.map_err(|e| {
            TranscribeError::Local(format!("whisperx output {} unreadable: {e}", out_json_path.display()))
        })?;
        let parsed: WhisperCppOutput = serde_json::from_str(&raw)?;

        // Reuse the same post-processing as the whisper_cpp path — the
        // runner emits whisper.cpp-shaped JSON deliberately.
        let (words, segments, dropped_h, dropped_lc) = run_post_filters(parsed);
        if dropped_h > 0 || dropped_lc > 0 {
            info!(
                dropped_hallucinations = dropped_h,
                dropped_low_confidence = dropped_lc,
                kept_segments = segments.len(),
                "whisperx post-filter"
            );
        }

        let mut final_segments = segments;
        let mut final_words = words;
        clamp_to_duration(&mut final_segments, &mut final_words, real_duration);

        let text = final_segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        Ok(TranscriptResult {
            duration: real_duration.or_else(|| final_segments.last().map(|s| s.end)),
            language: language_hint.map(|s| s.to_string()),
            model: format!("whisperx/{}", self.cfg.whisperx_model),
            provider: "whisperx".into(),
            segments: final_segments,
            text,
            words: final_words,
        })
    }

    // ---------- whisper.cpp (local) ----------

    async fn transcribe_whisper_cpp(
        &self,
        audio: Bytes,
        file_name: &str,
        language_hint: Option<&str>,
    ) -> Result<TranscriptResult, TranscribeError> {
        let workdir = TempDir::new().map_err(TranscribeError::Io)?;
        let input_path = workdir.path().join(sanitise(file_name));
        let wav_path = workdir.path().join("audio.wav");
        let out_prefix = workdir.path().join("transcript");
        let out_json_path = workdir.path().join("transcript.json");

        // 1. Persist the upload to disk so ffmpeg can read it.
        {
            let mut file = tokio::fs::File::create(&input_path).await?;
            file.write_all(&audio).await?;
            file.flush().await?;
        }

        // 2. Normalise to 16 kHz mono PCM — whisper.cpp's required input.
        let ffmpeg_status = Command::new(&self.cfg.ffmpeg_path)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-i",
                input_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 input path".into()))?,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                wav_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 wav path".into()))?,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| TranscribeError::Local(format!("failed to spawn ffmpeg ({}): {e}", self.cfg.ffmpeg_path)))?;

        if !ffmpeg_status.status.success() {
            let stderr = String::from_utf8_lossy(&ffmpeg_status.stderr);
            return Err(TranscribeError::Local(format!("ffmpeg failed: {}", stderr.trim())));
        }

        // 3. Get the *real* media duration from ffprobe up-front. Whisper
        //    processes audio in 30 s windows and its segment timestamps
        //    inherit those bounds — relying on whisper for duration produced
        //    bogus values like "duration: 30.0" on a 15.13 s clip in QA.
        let real_duration = probe_duration_seconds(&self.cfg.ffmpeg_path, &input_path).await.ok();

        // 4. Run whisper-cli with the anti-hallucination configuration.
        //    `--vad` + Silero pre-segments audio into voiced regions, which
        //    is the single biggest fix against ghost subtitles in silence.
        //    `--suppress-nst` drops [Music] / [Applause] tags. `-mc 0` zeroes
        //    the context window so prior-segment hallucinations can't
        //    cascade. We deliberately do NOT pass `--split-on-word -ml 60`
        //    anymore — that flag combo collapsed per-token timestamps to a
        //    single point on the second+ segments. VAD gives us cleaner
        //    natural segmentation; the frontend cue generator re-splits.
        let mut cmd = Command::new(&self.cfg.whisper_bin);
        cmd.args([
            "-m",
            &self.cfg.whisper_model,
            "-f",
            wav_path.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 wav path".into()))?,
            "-ojf",
            "-of",
            out_prefix.to_str().ok_or_else(|| TranscribeError::Local("non-utf8 out prefix".into()))?,
            "-nt",
            "-t",
            &self.cfg.whisper_threads.to_string(),
            "-mc",
            "0",
            "--suppress-nst",
            "--word-thold",
            "0.05",
        ]);
        if !self.cfg.whisper_vad_model.is_empty() {
            cmd.args([
                "--vad",
                "--vad-model",
                &self.cfg.whisper_vad_model,
                "--vad-threshold",
                "0.5",
                "--vad-min-silence-duration-ms",
                "500",
                "--vad-speech-pad-ms",
                "200",
            ]);
        }
        if let Some(lang) = language_hint {
            cmd.args(["-l", lang]);
        } else {
            cmd.args(["-l", "auto"]);
        }
        debug!(?cmd, "spawning whisper-cli");

        let whisper_status = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| TranscribeError::Local(format!("failed to spawn whisper-cli ({}): {e}", self.cfg.whisper_bin)))?;

        if !whisper_status.status.success() {
            let stderr = String::from_utf8_lossy(&whisper_status.stderr);
            return Err(TranscribeError::Local(format!("whisper-cli failed: {}", stderr.trim())));
        }

        // 4. Read the JSON sidecar.
        let raw = tokio::fs::read_to_string(&out_json_path).await.map_err(|e| {
            TranscribeError::Local(format!(
                "whisper output {} unreadable: {e}",
                out_json_path.display()
            ))
        })?;
        let parsed: WhisperCppOutput = serde_json::from_str(&raw)?;
        let language = parsed.result.as_ref().and_then(|r| r.language.clone());

        let (mut words, mut segments, dropped_h, dropped_lc) = run_post_filters(parsed);
        if dropped_h > 0 || dropped_lc > 0 {
            info!(
                dropped_hallucinations = dropped_h,
                dropped_low_confidence = dropped_lc,
                kept_segments = segments.len(),
                "transcript post-filter"
            );
        }
        clamp_to_duration(&mut segments, &mut words, real_duration);

        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let duration = real_duration.or_else(|| segments.last().map(|s| s.end));

        Ok(TranscriptResult {
            text,
            language,
            duration,
            words,
            segments,
            provider: self.cfg.provider.clone(),
            model: model_basename(&self.cfg.whisper_model),
        })
    }

    // ---------- Groq (cloud) ----------

    async fn transcribe_groq(
        &self,
        audio: Bytes,
        file_name: &str,
        language_hint: Option<&str>,
    ) -> Result<TranscriptResult, TranscribeError> {
        let mut form = Form::new()
            .text("model", self.cfg.model.clone())
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "word")
            .text("timestamp_granularities[]", "segment");
        if let Some(lang) = language_hint {
            form = form.text("language", lang.to_string());
        }
        form = form.part(
            "file",
            Part::stream(audio)
                .file_name(file_name.to_string())
                .mime_str("application/octet-stream")
                .map_err(|e| TranscribeError::Upstream(e.to_string()))?,
        );

        let endpoint = format!(
            "{}/audio/transcriptions",
            self.cfg.base_url.trim_end_matches('/')
        );

        let resp = self
            .http
            .post(&endpoint)
            .bearer_auth(&self.cfg.api_key)
            .multipart(form)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TranscribeError::Upstream(format!("{status}: {body}")));
        }

        let raw: GroqVerboseJson = resp.json().await?;
        Ok(TranscriptResult {
            text: raw.text,
            language: raw.language,
            duration: raw.duration,
            words: raw
                .words
                .unwrap_or_default()
                .into_iter()
                .map(|w| TranscriptWord {
                    word: w.word,
                    start: w.start,
                    end: w.end,
                })
                .collect(),
            segments: raw
                .segments
                .unwrap_or_default()
                .into_iter()
                .map(|s| TranscriptSegment {
                    text: s.text,
                    start: s.start,
                    end: s.end,
                })
                .collect(),
            provider: self.cfg.provider.clone(),
            model: self.cfg.model.clone(),
        })
    }
}

fn sanitise(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect::<String>()
}

fn model_basename(path: &str) -> String {
    PathBuf::from(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "whisper.cpp".to_string())
}

// ---------- whisper.cpp JSON shape ----------

#[derive(Debug, Deserialize)]
struct WhisperCppOutput {
    #[serde(default)]
    result: Option<WhisperCppResult>,
    transcription: Vec<WhisperCppSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperCppResult {
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WhisperCppSegment {
    text: String,
    offsets: WhisperCppOffsets,
    /// Present only with `-ojf` (json full).
    #[serde(default)]
    tokens: Option<Vec<WhisperCppToken>>,
}

#[derive(Debug, Clone, Deserialize)]
struct WhisperCppOffsets {
    /// Milliseconds from the start of the audio.
    from: u64,
    to: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct WhisperCppToken {
    #[serde(default)]
    text: String,
    offsets: WhisperCppOffsets,
    /// Per-token softmax probability. Present in `-ojf` JSON. Used to
    /// compute a segment-level average and drop low-confidence outputs.
    #[serde(default)]
    p: f64,
}

/// Phrases Whisper commonly hallucinates during silence — memorized from
/// YouTube subtitles in training data. If the WHOLE segment text matches
/// (case-insensitive) we drop it. We deliberately match conservatively so
/// real lines like "Thanks." inside a longer utterance survive.
const HALLUCINATION_LINES: &[&str] = &[
    "thank you",
    "thank you.",
    "thanks",
    "thanks.",
    "thanks for watching",
    "thanks for watching.",
    "thank you for watching",
    "thank you for watching.",
    "please subscribe",
    "please subscribe.",
    "like and subscribe",
    "like and subscribe.",
    "subscribe to my channel",
    "see you next time",
    "see you next time.",
    "bye",
    "bye.",
    "bye!",
    "[music]",
    "(music)",
    "[applause]",
    "(applause)",
    "[laughter]",
    "(laughter)",
    "untertitelung des zdf",
    "untertitel im auftrag des zdf",
];

fn is_hallucination(text: &str) -> bool {
    let trimmed = text.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return true;
    }
    HALLUCINATION_LINES.iter().any(|h| trimmed == *h)
}

/// Detect tokens whose start == end (the bug we saw on the JFK sample
/// where every token in segment 2 collapsed to offsets.from = 10990,
/// offsets.to = 10990). When a stretch of tokens has zero duration we
/// redistribute their timestamps linearly across the parent segment's
/// real range so word-level cue generation still produces sensible cues.
fn redistribute_degenerate_tokens(tokens: &mut [WhisperCppToken], seg_from_ms: u64, seg_to_ms: u64) {
    if tokens.is_empty() || seg_to_ms <= seg_from_ms {
        return;
    }
    // A token is degenerate if from == to OR from < seg_from / to > seg_to.
    let degenerate_count = tokens.iter().filter(|t| t.offsets.from >= t.offsets.to).count();
    if degenerate_count < tokens.len() / 2 {
        return;
    }
    let span = (seg_to_ms - seg_from_ms) as f64;
    let step = span / tokens.len() as f64;
    for (i, tok) in tokens.iter_mut().enumerate() {
        let start = seg_from_ms as f64 + i as f64 * step;
        let end = seg_from_ms as f64 + (i as f64 + 1.0) * step;
        tok.offsets.from = start.round() as u64;
        tok.offsets.to = end.round() as u64;
    }
}

/// Walk every segment in the whisper.cpp JSON output (or a whisperx-runner
/// emulation of it) and produce clean `(words, segments)` plus drop counts.
/// Filters applied: empty text, hallucination blocklist, degenerate-token
/// repair, low average token probability.
fn run_post_filters(parsed: WhisperCppOutput) -> (Vec<TranscriptWord>, Vec<TranscriptSegment>, u32, u32) {
    let mut words: Vec<TranscriptWord> = Vec::new();
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut dropped_hallucinations = 0u32;
    let mut dropped_low_confidence = 0u32;
    for mut seg in parsed.transcription.into_iter() {
        let seg_text = seg.text.trim().to_string();
        if seg_text.is_empty() {
            continue;
        }
        if is_hallucination(&seg_text) {
            dropped_hallucinations += 1;
            continue;
        }
        if let Some(tokens) = seg.tokens.as_mut() {
            redistribute_degenerate_tokens(tokens, seg.offsets.from, seg.offsets.to);
            let avg_p = segment_avg_probability(tokens);
            if avg_p < 0.35 {
                dropped_low_confidence += 1;
                continue;
            }
        }
        segments.push(TranscriptSegment {
            text: seg_text,
            start: seg.offsets.from as f64 / 1000.0,
            end: seg.offsets.to as f64 / 1000.0,
        });
        let Some(tokens) = seg.tokens else { continue };
        let mut current: Option<TranscriptWord> = None;
        for tok in tokens {
            if tok.text.is_empty() || tok.text.starts_with('[') || tok.text.starts_with('<') {
                continue;
            }
            let starts_word = tok.text.starts_with(' ') || current.is_none();
            let start_s = tok.offsets.from as f64 / 1000.0;
            let end_s = tok.offsets.to as f64 / 1000.0;
            if starts_word {
                if let Some(prev) = current.take() {
                    if !prev.word.trim().is_empty() {
                        words.push(prev);
                    }
                }
                current = Some(TranscriptWord {
                    word: tok.text.trim_start().to_string(),
                    start: start_s,
                    end: end_s,
                });
            } else if let Some(w) = current.as_mut() {
                w.word.push_str(&tok.text);
                w.end = end_s;
            }
        }
        if let Some(w) = current {
            if !w.word.trim().is_empty() {
                words.push(w);
            }
        }
    }
    (words, segments, dropped_hallucinations, dropped_low_confidence)
}

/// Clamp segment/word end times to the real media duration so a 15 s clip
/// never reports a 30 s last segment.
fn clamp_to_duration(segments: &mut [TranscriptSegment], words: &mut [TranscriptWord], real_duration: Option<f64>) {
    let Some(d) = real_duration else { return };
    for s in segments.iter_mut() {
        if s.end > d { s.end = d; }
        if s.start > d { s.start = d; }
    }
    for w in words.iter_mut() {
        if w.end > d { w.end = d; }
        if w.start > d { w.start = d; }
    }
}

/// Average per-token probability. Returns 1.0 for empty / missing data so
/// callers can treat "unknown" as "trust it" and let other filters decide.
fn segment_avg_probability(tokens: &[WhisperCppToken]) -> f64 {
    let mut count = 0u32;
    let mut sum = 0.0;
    for tok in tokens {
        if tok.text.is_empty() || tok.text.starts_with('[') || tok.text.starts_with('<') {
            continue;
        }
        sum += tok.p;
        count += 1;
    }
    if count == 0 { 1.0 } else { sum / count as f64 }
}

/// Ask ffprobe for the real container duration. `CHITRA_FFMPEG_PATH` points
/// at the ffmpeg binary; ffprobe ships alongside it in every supported install
/// (Homebrew, Debian package, the static builds). We derive the ffprobe path
/// by swapping `ffmpeg` → `ffprobe` in the configured ffmpeg path; if that
/// fails, fall back to whatever `ffprobe` resolves to on PATH.
async fn probe_duration_seconds(
    ffmpeg_path: &str,
    input_path: &std::path::Path,
) -> Result<f64, TranscribeError> {
    let derived = if ffmpeg_path.ends_with("ffmpeg") {
        ffmpeg_path.replacen("ffmpeg", "ffprobe", 1)
    } else {
        "ffprobe".to_string()
    };
    let input_str = input_path
        .to_str()
        .ok_or_else(|| TranscribeError::Local("non-utf8 input path".into()))?;
    for candidate in [derived.as_str(), "ffprobe"] {
        let res = Command::new(candidate)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                input_str,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await;
        let Ok(out) = res else { continue };
        if !out.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        if let Ok(v) = stdout.trim().parse::<f64>() {
            if v.is_finite() && v > 0.0 {
                return Ok(v);
            }
        }
    }
    Err(TranscribeError::Local("ffprobe could not read duration".into()))
}

// ---------- Groq JSON shape ----------

#[derive(Debug, Deserialize)]
struct GroqVerboseJson {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    words: Option<Vec<GroqWord>>,
    #[serde(default)]
    segments: Option<Vec<GroqSegment>>,
}

#[derive(Debug, Deserialize)]
struct GroqWord {
    word: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
struct GroqSegment {
    text: String,
    start: f64,
    end: f64,
}


#[cfg(test)]
mod tests {
    use super::*;

    fn tok(text: &str, from: u64, to: u64, p: f64) -> WhisperCppToken {
        WhisperCppToken {
            text: text.into(),
            offsets: WhisperCppOffsets { from, to },
            p,
        }
    }

    fn seg(text: &str, from: u64, to: u64, tokens: Vec<WhisperCppToken>) -> WhisperCppSegment {
        WhisperCppSegment {
            text: text.into(),
            offsets: WhisperCppOffsets { from, to },
            tokens: Some(tokens),
        }
    }

    #[test]
    fn drops_hallucination_lines() {
        for line in ["Thanks for watching", "thank you for watching.", "Please subscribe", "[Music]", "(Applause)"] {
            assert!(is_hallucination(line), "{line:?} should be dropped");
        }
        assert!(!is_hallucination("Hello there, friend."));
        assert!(!is_hallucination("Thanks. Now letsucceed."));
    }

    #[test]
    fn redistributes_degenerate_tokens() {
        let mut tokens = vec![
            tok(" hello", 1000, 1000, 0.9),
            tok(" world", 1000, 1000, 0.9),
            tok(".", 1000, 1000, 0.9),
        ];
        redistribute_degenerate_tokens(&mut tokens, 1000, 1900);
        assert!(tokens[0].offsets.to > tokens[0].offsets.from);
        assert_eq!(tokens[0].offsets.from, 1000);
        assert!(tokens[2].offsets.to <= 1900);
        // Tokens are now strictly increasing.
        assert!(tokens[1].offsets.from > tokens[0].offsets.from);
        assert!(tokens[2].offsets.from > tokens[1].offsets.from);
    }

    #[test]
    fn does_not_redistribute_when_tokens_are_already_fine() {
        let mut tokens = vec![
            tok(" hello", 1000, 1500, 0.9),
            tok(" world", 1500, 1800, 0.9),
            tok(".", 1800, 1900, 0.9),
        ];
        let original = tokens.clone();
        redistribute_degenerate_tokens(&mut tokens, 1000, 1900);
        for (i, t) in tokens.iter().enumerate() {
            assert_eq!(t.offsets.from, original[i].offsets.from);
            assert_eq!(t.offsets.to, original[i].offsets.to);
        }
    }

    #[test]
    fn run_post_filters_drops_hallucination_and_keeps_real_text() {
        let parsed = WhisperCppOutput {
            result: None,
            transcription: vec![
                seg("Thanks for watching.", 0, 2000, vec![tok("Thanks for watching.", 0, 2000, 0.4)]),
                seg("Hello world.", 2000, 4000, vec![
                    tok(" Hello", 2000, 2500, 0.95),
                    tok(" world", 2500, 3500, 0.93),
                    tok(".", 3500, 4000, 0.9),
                ]),
            ],
        };
        let (words, segments, dropped_h, dropped_lc) = run_post_filters(parsed);
        assert_eq!(dropped_h, 1);
        assert_eq!(dropped_lc, 0);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Hello world.");
        let word_strs: Vec<_> = words.iter().map(|w| w.word.as_str()).collect();
        assert_eq!(word_strs, vec!["Hello", "world."]);
    }

    #[test]
    fn run_post_filters_drops_low_confidence_segments() {
        let parsed = WhisperCppOutput {
            result: None,
            transcription: vec![
                seg("Mumble", 0, 1000, vec![
                    tok(" Mumble", 0, 1000, 0.10),
                ]),
                seg("Clear speech", 1000, 3000, vec![
                    tok(" Clear", 1000, 2000, 0.92),
                    tok(" speech", 2000, 3000, 0.91),
                ]),
            ],
        };
        let (_, segments, _, dropped_lc) = run_post_filters(parsed);
        assert_eq!(dropped_lc, 1);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Clear speech");
    }

    #[test]
    fn clamp_to_duration_pulls_segments_within_bounds() {
        let mut segments = vec![
            TranscriptSegment { text: "a".into(), start: 0.0, end: 10.0 },
            TranscriptSegment { text: "b".into(), start: 12.0, end: 30.0 },
        ];
        let mut words = vec![
            TranscriptWord { word: "a".into(), start: 0.0, end: 10.0 },
            TranscriptWord { word: "b".into(), start: 12.0, end: 30.0 },
        ];
        clamp_to_duration(&mut segments, &mut words, Some(15.0));
        assert_eq!(segments[0].end, 10.0);
        assert_eq!(segments[1].end, 15.0);
        assert_eq!(words[1].end, 15.0);
    }
}

