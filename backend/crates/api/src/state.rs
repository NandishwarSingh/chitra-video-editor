//! Shared application state injected into every route handler.
//!
//! Initialization is fault-tolerant: optional features (database, S3) degrade
//! to `None` so the chat path still works on a developer's laptop without a
//! local Postgres. Required features (chat) fail-fast at startup.

use anyhow::Result;
use chitra_chat::ChatClient;
use chitra_storage::StorageStack;
use chitra_transcode::TranscodeWorker;
use std::sync::Arc;
use tracing::{info, warn};

use crate::config::Config;
use crate::transcribe::TranscribeClient;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    pub chat: ChatClient,
    pub storage: Option<StorageStack>,
    pub transcode: TranscodeWorker,
    pub transcribe: Option<TranscribeClient>,
    pub allowed_origins: Vec<String>,
}

impl AppState {
    pub async fn initialize(cfg: &Config) -> Result<Self> {
        let chat = ChatClient::new(cfg.chat.clone())?;
        info!(model = %cfg.chat.model, "chat client ready");

        let storage = match &cfg.storage {
            Some(storage_cfg) => match StorageStack::connect(storage_cfg.clone()).await {
                Ok(s) => {
                    info!("storage connected");
                    Some(s)
                }
                Err(e) => {
                    warn!(error = ?e, "storage unavailable — /api/projects + /api/assets will return 503");
                    None
                }
            },
            None => {
                warn!("DATABASE_URL not set — /api/projects + /api/assets will return 503");
                None
            }
        };

        let transcode = TranscodeWorker::new(cfg.transcode.clone());

        let transcribe = if cfg.transcribe.is_enabled() {
            match TranscribeClient::new(cfg.transcribe.clone()) {
                Ok(client) => {
                    let model_label = match cfg.transcribe.provider.as_str() {
                        "whisper_cpp" => cfg.transcribe.whisper_model.as_str(),
                        _ => cfg.transcribe.model.as_str(),
                    };
                    info!(provider = %cfg.transcribe.provider, model = %model_label, "transcription ready");
                    Some(client)
                }
                Err(e) => {
                    warn!(error = ?e, "transcription client init failed");
                    None
                }
            }
        } else {
            match cfg.transcribe.provider.as_str() {
                "whisper_cpp" => warn!(
                    "CHITRA_WHISPER_MODEL not set — /api/transcribe will return 503. Install whisper.cpp (`brew install whisper-cpp`) and point CHITRA_WHISPER_MODEL at a ggml-*.bin."
                ),
                _ => warn!(
                    "CHITRA_STT_API_KEY not set — /api/transcribe will return 503 (provider: {})",
                    cfg.transcribe.provider
                ),
            }
            None
        };

        Ok(Self {
            inner: Arc::new(Inner {
                chat,
                storage,
                transcode,
                transcribe,
                allowed_origins: cfg.allowed_origins.clone(),
            }),
        })
    }

    pub fn chat(&self) -> &ChatClient {
        &self.inner.chat
    }

    pub fn storage(&self) -> Option<&StorageStack> {
        self.inner.storage.as_ref()
    }

    pub fn transcode(&self) -> &TranscodeWorker {
        &self.inner.transcode
    }

    pub fn transcribe(&self) -> Option<&TranscribeClient> {
        self.inner.transcribe.as_ref()
    }

    pub fn allowed_origins(&self) -> &[String] {
        &self.inner.allowed_origins
    }
}
