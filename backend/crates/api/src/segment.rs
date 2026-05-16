//! Video object segmentation / rotoscoping. Shells out to a local Python
//! venv running `scripts/sam2_runner.py` with the EfficientTAM engine
//! (Apache-2.0, SAM2-API-compatible, the only Mac-viable video tracker —
//! stock Meta SAM 2 is <1 FPS on MPS).
//!
//! Mirrors the WhisperX provider in `transcribe.rs` exactly:
//! - the runner writes its result to a FILE we pass as an argument; stdout is
//!   never trusted (torch/ETAM spray progress there — this exact class of bug
//!   already cost a debugging cycle on WhisperX).
//! - Rust spawns with stdout=null, stderr=piped, reads the manifest file with
//!   `tokio::fs::read_to_string`.
//!
//! v1 is synchronous like `/api/transcribe`. The runner produces a grayscale
//! mask video (mask in the luma plane); we return it base64 in the JSON so
//! the frontend can persist one Blob in IndexedDB (`MASK_STORE`). Masks are
//! tiny (measured 2.65 MB / 1800 1080p frames in the Phase-0 spike).

use std::process::Stdio;

use base64::Engine as _;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{debug, info};

#[derive(Debug, Clone)]
pub struct Sam2Config {
    /// Absolute path to the venv python (`~/.chitra-sam2/bin/python3`).
    pub python: String,
    /// Absolute path to `scripts/sam2_runner.py` in this repo.
    pub runner: String,
    /// EfficientTAM clone dir (has `checkpoints/` + `configs/`).
    pub repo: String,
    /// Model name, e.g. `efficienttam_s_512x512`.
    pub model: String,
    pub ffmpeg_path: String,
}

impl Sam2Config {
    pub fn is_enabled(&self) -> bool {
        !self.python.is_empty() && !self.runner.is_empty() && !self.repo.is_empty()
    }
}

impl Default for Sam2Config {
    fn default() -> Self {
        Self {
            python: String::new(),
            runner: String::new(),
            repo: String::new(),
            model: "efficienttam_s_512x512".into(),
            ffmpeg_path: "ffmpeg".into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum SegmentError {
    #[error("segmentation disabled: configure CHITRA_SAM2_* and run scripts/install-sam2.sh")]
    Disabled,
    #[error("invalid prompt: {0}")]
    BadPrompt(String),
    #[error("local toolchain error: {0}")]
    Local(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Shape the runner writes to its manifest file (a superset is fine —
/// `#[serde(default)]` tolerates the extra benchmark fields).
#[derive(Debug, Deserialize)]
struct RunnerManifest {
    engine: String,
    model: String,
    device: String,
    #[serde(default)]
    frames: u32,
    #[serde(default)]
    propagated: u32,
    #[serde(default)]
    source_fps: f64,
    #[serde(default)]
    mask_width: u32,
    #[serde(default)]
    mask_height: u32,
    mask_video: String,
    #[serde(default)]
    timings_s: serde_json::Value,
}

/// What the HTTP endpoint returns. `mask_video_base64` is a grayscale H.264
/// mp4 (mask in luma); the frontend decodes it to a Blob for `MASK_STORE`.
#[derive(Debug, Serialize)]
pub struct SegmentResult {
    pub engine: String,
    pub model: String,
    pub device: String,
    pub frames: u32,
    pub propagated: u32,
    pub source_fps: f64,
    pub mask_width: u32,
    pub mask_height: u32,
    pub mask_video_base64: String,
    pub timings_s: serde_json::Value,
}

#[derive(Clone)]
pub struct Sam2Client {
    cfg: Sam2Config,
}

impl Sam2Client {
    pub fn new(cfg: Sam2Config) -> Self {
        Self { cfg }
    }

    pub fn is_enabled(&self) -> bool {
        self.cfg.is_enabled()
    }

    pub fn model(&self) -> &str {
        &self.cfg.model
    }

    /// Segment + track one object across the uploaded clip. `prompt_json` is
    /// the runner's prompt contract:
    ///   {"frame":0,"points":[[x,y]],"labels":[1]}  or  {"frame":0,"box":[x0,y0,x1,y1]}
    /// in source-pixel coords.
    pub async fn segment(
        &self,
        video: Bytes,
        file_name: &str,
        prompt_json: &str,
    ) -> Result<SegmentResult, SegmentError> {
        if !self.is_enabled() {
            return Err(SegmentError::Disabled);
        }
        // Validate the prompt is well-formed JSON before spending GPU time.
        serde_json::from_str::<serde_json::Value>(prompt_json)
            .map_err(|e| SegmentError::BadPrompt(e.to_string()))?;

        let workdir = TempDir::new().map_err(SegmentError::Io)?;
        let input_path = workdir.path().join(sanitise(file_name));
        let out_json = workdir.path().join("seg.json");

        {
            let mut f = tokio::fs::File::create(&input_path).await?;
            f.write_all(&video).await?;
            f.flush().await?;
        }

        let mut cmd = Command::new(&self.cfg.python);
        cmd.arg(&self.cfg.runner)
            .arg(
                input_path
                    .to_str()
                    .ok_or_else(|| SegmentError::Local("non-utf8 input path".into()))?,
            )
            .arg(&self.cfg.repo)
            .arg(&self.cfg.model)
            .arg(
                out_json
                    .to_str()
                    .ok_or_else(|| SegmentError::Local("non-utf8 out path".into()))?,
            )
            .arg(prompt_json);
        debug!(?cmd, "spawning sam2 runner");

        let output = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| {
                SegmentError::Local(format!("failed to spawn python ({}): {e}", self.cfg.python))
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // The runner's last stderr lines carry the real error; keep them.
            let tail: String = stderr.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(SegmentError::Local(format!("sam2_runner failed: {tail}")));
        }

        let raw = tokio::fs::read_to_string(&out_json).await.map_err(|e| {
            SegmentError::Local(format!("sam2 manifest {} unreadable: {e}", out_json.display()))
        })?;
        let manifest: RunnerManifest = serde_json::from_str(&raw)?;

        let mask_bytes = tokio::fs::read(&manifest.mask_video).await.map_err(|e| {
            SegmentError::Local(format!(
                "sam2 mask video {} unreadable: {e}",
                manifest.mask_video
            ))
        })?;
        let mask_video_base64 = base64::engine::general_purpose::STANDARD.encode(&mask_bytes);

        info!(
            engine = %manifest.engine,
            device = %manifest.device,
            frames = manifest.propagated,
            mask_kb = mask_bytes.len() / 1024,
            "segmentation complete"
        );

        Ok(SegmentResult {
            engine: manifest.engine,
            model: manifest.model,
            device: manifest.device,
            frames: manifest.frames,
            propagated: manifest.propagated,
            source_fps: manifest.source_fps,
            mask_width: manifest.mask_width,
            mask_height: manifest.mask_height,
            mask_video_base64,
            timings_s: manifest.timings_s,
        })
    }
}

/// Strip path separators / NUL so a hostile filename can't escape the tempdir.
/// (Copied verbatim from the transcribe sidecar — same threat model.)
fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches('.').trim();
    if trimmed.is_empty() {
        "input.bin".to_string()
    } else {
        trimmed.to_string()
    }
}
