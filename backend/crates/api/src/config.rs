//! Process-level configuration. Read once at startup from env vars and held
//! immutably for the lifetime of the server. Missing values get sensible
//! defaults for local development — production deploys should set them
//! explicitly via the environment.

use std::env;

use anyhow::{anyhow, Result};
use chitra_chat::ChatConfig;
use chitra_storage::StorageConfig;
use chitra_transcode::TranscodeConfig;

use crate::transcribe::TranscribeConfig;

pub struct Config {
    pub bind_addr: String,
    pub allowed_origins: Vec<String>,
    pub storage: Option<StorageConfig>,
    pub chat: ChatConfig,
    pub transcode: TranscodeConfig,
    pub transcribe: TranscribeConfig,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind_addr = env::var("CHITRA_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());

        let allowed_origins = env::var("CHITRA_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:5173,http://localhost:5183".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // Database + S3 are optional during scaffolding. The /api/projects
        // and /api/assets routes degrade to in-memory/no-op when this is None.
        let storage = match env::var("DATABASE_URL") {
            Ok(database_url) => Some(StorageConfig {
                database_url,
                s3_bucket: env::var("CHITRA_S3_BUCKET").unwrap_or_else(|_| "chitra-assets".to_string()),
                s3_region: env::var("CHITRA_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
                s3_endpoint: env::var("CHITRA_S3_ENDPOINT").ok().filter(|s| !s.is_empty()),
            }),
            Err(_) => None,
        };

        let chat = {
            let api_key = env::var("CHITRA_LLM_API_KEY")
                .map_err(|_| anyhow!("CHITRA_LLM_API_KEY is required (set it in backend/.env)"))?;
            ChatConfig {
                base_url: env::var("CHITRA_LLM_BASE_URL")
                    .unwrap_or_else(|_| "https://openrouter.ai/api/v1".to_string()),
                api_key,
                model: env::var("CHITRA_LLM_MODEL").unwrap_or_else(|_| "deepseek/deepseek-v4-flash".to_string()),
                ..ChatConfig::default()
            }
        };

        let ffmpeg_path = env::var("CHITRA_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string());
        let transcode = TranscodeConfig {
            ffmpeg_path: ffmpeg_path.clone(),
        };

        // STT defaults to local whisper.cpp. No key, no network call. Set
        // CHITRA_WHISPER_MODEL to your ggml-*.bin to enable. Switch to Groq
        // with CHITRA_STT_PROVIDER=groq + CHITRA_STT_API_KEY.
        let transcribe = TranscribeConfig {
            provider: env::var("CHITRA_STT_PROVIDER").unwrap_or_else(|_| "whisper_cpp".to_string()),
            api_key: env::var("CHITRA_STT_API_KEY").unwrap_or_default(),
            model: env::var("CHITRA_STT_MODEL").unwrap_or_else(|_| "whisper-large-v3-turbo".to_string()),
            base_url: env::var("CHITRA_STT_BASE_URL")
                .unwrap_or_else(|_| "https://api.groq.com/openai/v1".to_string()),
            whisper_bin: env::var("CHITRA_WHISPER_BIN").unwrap_or_else(|_| "whisper-cli".to_string()),
            whisper_model: env::var("CHITRA_WHISPER_MODEL").unwrap_or_default(),
            ffmpeg_path,
            whisper_threads: env::var("CHITRA_WHISPER_THREADS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(4),
        };

        Ok(Self {
            bind_addr,
            allowed_origins,
            storage,
            chat,
            transcode,
            transcribe,
        })
    }
}
