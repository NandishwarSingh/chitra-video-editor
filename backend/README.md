# Chitra Backend

Tokio + axum service for the Chitra video editor. Owns four surfaces:

| Crate              | Path                          | Owns                                                |
| ------------------ | ----------------------------- | --------------------------------------------------- |
| `api`              | `crates/api`                  | HTTP server, routing, CORS, error mapping           |
| `chitra-chat`      | `crates/chat`                 | OpenRouter client, SSE streaming, two-tier caching |
| `chitra-storage`   | `crates/storage`              | Postgres pool + S3-compatible object storage       |
| `chitra-transcode` | `crates/transcode`            | ffmpeg orchestration + job queue                   |
| `chitra-core`      | `crates/core`                 | Wire types shared across the workspace             |

## Quick start

```bash
cd backend
cp .env.example .env           # fill in CHITRA_LLM_API_KEY
cargo run -p api
```

The server listens on `127.0.0.1:8787` by default. The Vite dev server proxies
`/api/*` to it, so the frontend can call same-origin URLs.

## Endpoints

| Method | Path                | Purpose                                              |
| ------ | ------------------- | ---------------------------------------------------- |
| GET    | `/api/health`       | Liveness + feature flags                             |
| POST   | `/api/chat`         | Chat completion. `stream: true` returns SSE          |
| GET    | `/api/projects`     | List saved projects (requires Postgres)              |
| POST   | `/api/projects`     | Save / upsert a project                              |
| POST   | `/api/assets`       | Multipart upload to object store                     |
| POST   | `/api/jobs`         | Enqueue a server-side transcode                      |
| GET    | `/api/jobs/:id`     | Job status                                           |

## Caching

The chat path runs through **two tiers**:

1. **Local response cache** — Moka LRU keyed by a blake3 hash of `(model,
   system prompt, message history)`. TTL 1 hour, capacity 10 000 entries.
   On hit, the cached assistant reply is replayed as a single SSE chunk —
   no network call. Useful for retries and for "show the same answer to
   the same question" inside an editing session.

2. **Provider prompt cache** — for system prompts above `prompt_cache_min_chars`
   (default 800 chars), the request attaches an Anthropic-style
   `cache_control: ephemeral` breakpoint. DeepSeek and Anthropic models on
   OpenRouter use this to cache the prefill of long system prompts; other
   providers silently ignore it. Cache hits are reported back via
   `usage.prompt_cache_hit_tokens` and surfaced to the API caller as
   `cache: "provider"` on the `done` event.

Cold path: `cache: "miss"`. Local hit: `cache: "local"`. Provider hit:
`cache: "provider"`.

## Running with Postgres + MinIO locally

```bash
docker run -d --name chitra-pg  -p 5432:5432 -e POSTGRES_PASSWORD=chitra postgres:16
docker run -d --name chitra-s3  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
  minio/minio server /data --console-address ":9001"
```

Then in `.env`:

```
DATABASE_URL=postgres://postgres:chitra@localhost:5432/chitra
CHITRA_S3_BUCKET=chitra-assets
CHITRA_S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=minio
AWS_SECRET_ACCESS_KEY=minio123
```

Migrations and bucket bootstrap are not yet automated — that's the next step
once the route shapes stabilize.
