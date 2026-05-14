//! Persistence facade: Postgres for relational records, object storage for
//! large blobs (raw media + rendered exports).
//!
//! The API crate consumes a single [`StorageStack`] that bundles both. Routes
//! never touch sqlx or object_store types directly — keeps the call sites
//! short and lets us swap implementations (SQLite for tests, MinIO vs S3
//! for dev vs prod) without rippling through every handler.

use std::sync::Arc;

use chitra_core::{AssetKind, AssetRecord, ProjectRecord};
use object_store::{aws::AmazonS3Builder, ObjectStore};
use sqlx::{postgres::PgPoolOptions, PgPool};
use thiserror::Error;
use time::OffsetDateTime;
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Object(#[from] object_store::Error),
    #[error("not found")]
    NotFound,
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub database_url: String,
    pub s3_bucket: String,
    pub s3_region: String,
    /// Optional custom endpoint for S3-compatible stores (MinIO, R2).
    pub s3_endpoint: Option<String>,
}

#[derive(Clone)]
pub struct StorageStack {
    db: PgPool,
    objects: Arc<dyn ObjectStore>,
}

impl StorageStack {
    pub async fn connect(cfg: StorageConfig) -> Result<Self, StorageError> {
        info!(url = %redact(&cfg.database_url), "connecting to postgres");
        let db = PgPoolOptions::new()
            .max_connections(8)
            .connect(&cfg.database_url)
            .await?;

        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&cfg.s3_bucket)
            .with_region(&cfg.s3_region);
        if let Some(endpoint) = cfg.s3_endpoint {
            builder = builder.with_endpoint(endpoint).with_allow_http(true);
        }
        let s3 = builder.build()?;

        Ok(Self {
            db,
            objects: Arc::new(s3),
        })
    }

    pub fn db(&self) -> &PgPool {
        &self.db
    }

    pub fn objects(&self) -> &dyn ObjectStore {
        self.objects.as_ref()
    }

    // ----- Projects -----

    pub async fn list_projects(&self) -> Result<Vec<ProjectRecord>, StorageError> {
        // Sketch: the actual SELECT goes here once the migrations land. We
        // return an empty list so the route is observable end-to-end without
        // requiring a live database during scaffolding.
        Ok(Vec::new())
    }

    pub async fn upsert_project(&self, record: ProjectRecord) -> Result<ProjectRecord, StorageError> {
        // TODO: replace with `INSERT ... ON CONFLICT (id) DO UPDATE` once
        // migrations exist. For now we echo the record back so the round-trip
        // contract is testable from the frontend.
        Ok(record)
    }

    // ----- Assets -----

    pub async fn record_asset(
        &self,
        project_id: Uuid,
        kind: AssetKind,
        original_name: String,
        storage_key: String,
        size_bytes: i64,
    ) -> Result<AssetRecord, StorageError> {
        Ok(AssetRecord {
            id: Uuid::new_v4(),
            project_id,
            kind,
            original_name,
            storage_key,
            size_bytes,
            duration_seconds: None,
            width: None,
            height: None,
            uploaded_at: OffsetDateTime::now_utc(),
        })
    }
}

fn redact(url: &str) -> String {
    // Hide credentials from logs while keeping host/db identifiable.
    if let Some(at) = url.find('@') {
        if let Some(scheme_end) = url.find("://") {
            return format!("{}://[REDACTED]@{}", &url[..scheme_end], &url[at + 1..]);
        }
    }
    url.to_string()
}
