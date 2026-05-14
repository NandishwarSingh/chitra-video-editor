//! Server-side ffmpeg orchestrator.
//!
//! The browser-side editor already has a wasm ffmpeg path that works for short
//! exports. This crate is the eventual escape hatch for long timelines: queue
//! a job, spawn a real ffmpeg child process, stream progress back to the
//! client via the API's `/api/jobs/:id/events` SSE endpoint.
//!
//! The current implementation is a deliberate skeleton — it owns the job
//! state machine and the spawn surface so the API routes stay thin, but the
//! actual filter graph generation will be ported from the wasm worker once
//! we're ready. Leaving it stubbed avoids a half-built parallel encoder.

use std::sync::Arc;

use chitra_core::{JobStatus, TranscodeJob};
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum TranscodeError {
    #[error("job not found")]
    NotFound,
    #[error("ffmpeg not available at {0}")]
    FfmpegMissing(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct TranscodeConfig {
    /// Path to the ffmpeg binary (looked up via $PATH if just `ffmpeg`).
    pub ffmpeg_path: String,
}

#[derive(Clone)]
pub struct TranscodeWorker {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: TranscodeConfig,
    jobs: RwLock<Vec<TranscodeJob>>,
    spawn_guard: Mutex<()>,
}

impl TranscodeWorker {
    pub fn new(cfg: TranscodeConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                jobs: RwLock::new(Vec::new()),
                spawn_guard: Mutex::new(()),
            }),
        }
    }

    pub async fn enqueue(&self, project_id: Uuid) -> TranscodeJob {
        let job = TranscodeJob {
            id: Uuid::new_v4(),
            project_id,
            status: JobStatus::Queued,
            progress: 0.0,
            error: None,
            output_key: None,
            created_at: time::OffsetDateTime::now_utc(),
            updated_at: time::OffsetDateTime::now_utc(),
        };
        self.inner.jobs.write().await.push(job.clone());

        // TODO: wire the actual ffmpeg child process here. For now the job
        // stays in Queued until a future commit ports the filter graph.
        let _spawn_token = self.inner.spawn_guard.try_lock();

        job
    }

    pub async fn list(&self) -> Vec<TranscodeJob> {
        self.inner.jobs.read().await.clone()
    }

    pub async fn get(&self, id: Uuid) -> Result<TranscodeJob, TranscodeError> {
        self.inner
            .jobs
            .read()
            .await
            .iter()
            .find(|j| j.id == id)
            .cloned()
            .ok_or(TranscodeError::NotFound)
    }

    pub fn ffmpeg_path(&self) -> &str {
        &self.inner.cfg.ffmpeg_path
    }
}
