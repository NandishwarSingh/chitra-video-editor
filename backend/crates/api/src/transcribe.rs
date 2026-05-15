//! Speech-to-text. Two providers:
//!
//! - **whisper_cpp** (default): shells out to a local `whisper-cli` binary.
//!   Audio is normalised to 16 kHz mono WAV by ffmpeg first (whisper.cpp
//!   wants that exact format). No network call, no API key, no quota.
//!   Install on macOS with `brew install whisper-cpp` then download a model
//!   via `bash ./models/download-ggml-model.sh small` from the upstream
//!   whisper.cpp repo (or point CHITRA_WHISPER_MODEL at any existing
//!   `ggml-*.bin`).
//!
//! - **groq**: proxy to Groq's hosted whisper-large-v3-turbo. Kept as a
//!   one-line opt-in for users who don't want the local toolchain.
//!
//! Both providers normalise to a single `TranscriptResult` shape so the
//! frontend doesn't care which one is active.

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
use tracing::{debug, instrument, warn};

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
    pub ffmpeg_path: String,
    pub whisper_threads: u32,
}

impl TranscribeConfig {
    pub fn is_enabled(&self) -> bool {
        match self.provider.as_str() {
            "groq" => !self.api_key.is_empty(),
            "whisper_cpp" => !self.whisper_model.is_empty() && !self.whisper_bin.is_empty(),
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
            other => Err(TranscribeError::UnsupportedProvider(other.to_string())),
        }
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

        // 4. Run whisper-cli with phrase-level segmentation. `--split-on-word`
        //    + `-ml 60` produce ~5–10 word segments instead of one big blob
        //    of the whole take. `-ojf` emits per-token timestamps in the
        //    JSON sidecar; we use those below to reconstruct word-level
        //    timing for the AI's phrase-aware editing.
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
            "--split-on-word",
            "-ml",
            "60",
        ]);
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

        // Reconstruct word-level timings from per-token data (whisper.cpp
        // tokens are sub-word pieces; a token's text begins with a leading
        // space when it starts a new word).
        let mut words: Vec<TranscriptWord> = Vec::new();
        let mut segments: Vec<TranscriptSegment> = Vec::new();
        for seg in parsed.transcription.into_iter() {
            let seg_text = seg.text.trim().to_string();
            if seg_text.is_empty() {
                continue;
            }
            segments.push(TranscriptSegment {
                text: seg_text,
                start: seg.offsets.from as f64 / 1000.0,
                end: seg.offsets.to as f64 / 1000.0,
            });
            let Some(tokens) = seg.tokens else { continue };
            let mut current: Option<TranscriptWord> = None;
            for tok in tokens {
                // Skip special tokens (BOS, EOS, language tags, timestamps).
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

        // Clamp segment/word end times to the real media duration so a
        // 15 s clip never reports a 30 s last segment.
        if let Some(d) = real_duration {
            for s in segments.iter_mut() {
                if s.end > d {
                    s.end = d;
                }
                if s.start > d {
                    s.start = d;
                }
            }
            for w in words.iter_mut() {
                if w.end > d {
                    w.end = d;
                }
                if w.start > d {
                    w.start = d;
                }
            }
        }

        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let duration = real_duration.or_else(|| segments.last().map(|s| s.end));
        let language = parsed.result.and_then(|r| r.language);

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

#[derive(Debug, Deserialize)]
struct WhisperCppOffsets {
    /// Milliseconds from the start of the audio.
    from: u64,
    to: u64,
}

#[derive(Debug, Deserialize)]
struct WhisperCppToken {
    #[serde(default)]
    text: String,
    offsets: WhisperCppOffsets,
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
