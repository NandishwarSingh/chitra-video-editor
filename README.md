# Chitra Video Editor

A browser-native, AI-assisted video editor. The whole editor runs in the
browser (React + Vite + TypeScript, WebGPU preview, FFmpeg.wasm export); a
small Rust backend (Tokio + axum) provides the heavy local AI services —
chat-driven editing, speech-to-text, beat detection, and object
segmentation — by shelling out to local model toolchains. No clip ever has
to leave the machine.

---

## Table of contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [The Edit Array Language (EAL)](#the-edit-array-language-eal)
- [AI chat editing](#ai-chat-editing)
- [Speech-to-text](#speech-to-text)
- [Subtitles](#subtitles)
- [Beat detection](#beat-detection)
- [Rotoscoping & object tracking (SAM2 / EfficientTAM)](#rotoscoping--object-tracking-sam2--efficienttam)
- [The performance gate](#the-performance-gate)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Status & roadmap](#status--roadmap)

---

## Highlights

- **Real timeline editor** — multi-track (video / audio / text) timeline,
  clip trim/split/move with ripple, per-clip transform (x / y / scale /
  rotation), color effects (brightness / contrast / saturation), audio
  fades and volume, and a virtualized timeline that stays smooth with
  hundreds of clips and overlays.
- **WebGPU preview compositor** — frame-accurate preview with the colour
  pipeline applied on-GPU. Entirely optional: a clean canvas/video fallback
  runs when WebGPU is unavailable.
- **WYSIWYG MP4 export** — FFmpeg runs in a Web Worker. Text/position math
  comes from a single shared anchor helper used by *both* the CSS preview
  and the FFmpeg `drawtext` filter, so the export matches the preview
  instead of drifting.
- **AI chat that actually edits** — describe the edit in plain language
  ("remove the filler and dead air, prepare this for production", "cut the
  best 5 shorts", "only keep the parts about France and Germany") and the
  model returns a complete new program the editor applies with one click.
- **Local speech-to-text** — whisper.cpp with Silero VAD and an
  anti-hallucination post-filter, or WhisperX (faster-whisper +
  wav2vec2 forced alignment) for ±10–30 ms word timing. No API key, no
  upload.
- **Automatic subtitles** — sentence / phrase / word cues from real
  word-level timestamps, a styled template registry, half-open cue
  boundaries (no double-rendered frames), bulk style + timing edits.
- **Beat detection** — madmom downbeat tracking surfaced as timeline
  markers for beat-synced cutting.
- **Object segmentation / rotoscoping** — click a subject, EfficientTAM
  tracks it across the clip; the matte drives spotlight / cutout /
  blur-background effects (in active development — see status).
- **Everything is serializable** — the entire project round-trips through
  the Edit Array Language, which is what makes AI editing, undo, and
  persistence all the same mechanism.

---

## Architecture

```
┌───────────────────────────── browser ─────────────────────────────┐
│  React + Vite + TypeScript                                         │
│    • timeline runtime (owns the playhead, hot path)                │
│    • WebGPU preview compositor  (optional, falls back)             │
│    • FFmpeg.wasm export          (Web Worker)                      │
│    • IndexedDB: projects, media blobs, proxies, transcripts,       │
│      beats, masks                                                  │
│    • Edit Array Language: emit / parse / compile / run             │
└───────────────────────────────┬────────────────────────────────────┘
                                 │  /api/*  (Vite dev proxy → :8787)
┌────────────────────────────────┴───────────────────────────────────┐
│  Rust backend (Tokio + axum workspace)                             │
│    crates/api        HTTP surface, route handlers, app state       │
│    crates/chat       OpenRouter client + prompt cache + EAL tools  │
│    crates/transcode  FFmpeg job worker                             │
│    crates/storage    Postgres + object-storage sync (optional)     │
│    crates/core       shared types (JobStatus, ChatStreamEvent, …)  │
│                                                                    │
│  Local model sidecars (subprocess, results written to a file):     │
│    whisper.cpp / WhisperX   speech-to-text                         │
│    madmom                   beat & downbeat tracking               │
│    EfficientTAM             object segmentation / tracking         │
└────────────────────────────────────────────────────────────────────┘
```

**Sidecar pattern.** Every heavy local model runs the same way: the Rust
handler writes the upload to a temp dir, spawns a Python/CLI process with
`stdout` discarded and the *result written to a file path passed as an
argument*, then reads that file. Model libraries spray progress to stdout —
trusting a stdout pipe is a bug that was fixed once and never repeated. New
sidecars (`segment.rs`) are 1:1 clones of the proven `transcribe.rs`.

---

## The Edit Array Language (EAL)

EAL is a flat JSON array of `[opcode, …payload]` tuples that fully describes
a project — assets, tracks, clips, transforms, effects, text overlays,
masks, export settings. It is the single source of truth for three things
at once:

1. **AI editing** — the model receives the current program in context and
   returns a complete new one; the editor compiles → validates → applies.
2. **Persistence** — projects serialize to / from EAL.
3. **Determinism** — `compile(program) → IR → runtime` is pure and tested
   for round-trip safety.

A hard project rule (enforced by the performance gate, not convention):
**every field on `ProjectAsset`, `TimelineClip`, `TimelineTrack`,
`TextOverlay`, `ProjectPresent`, `PersistedAsset`, `ProjectSettings` must be
covered by EAL emit + parse + policy + a round-trip test, in the same
change that introduces the field.** Reserved opcodes (`keyframe`,
`animation`, `camera`, …) are placeholders that get promoted to fully wired
opcodes when a feature lands (this is exactly how `mask` was added).

---

## AI chat editing

The chat panel streams from OpenRouter (default model
`deepseek/deepseek-v4-flash`) and exposes one tool, `apply_eal`, which takes
a complete new program. The editor renders an Apply / Discard card; on
apply it runs the same compile → validate → execute path as any other edit.

**Verified end-to-end** against a real 7-minute clip via an integration
harness (`src/aiEditHarness.spec.ts`, opt-in via `AIEDIT_HARNESS=1`). Every
one of these prompt classes produces a valid, tightened timeline:

| Prompt | Result on the 7-min test clip |
|---|---|
| remove filler words | 420 s → 253 s |
| remove silence / dead air | 420 s → 253 s |
| remove repeated takes | 420 s → 134 s |
| prepare for production | 420 s → 253 s |
| make this more fast-paced | 420 s → 253 s |
| best 30–60 s reel | 30.6 s |
| cut the best 5 shorts | 49 s, 7 clips |
| keep only high-value sections | 420 s → 253 s |
| only keep parts about a topic | 420 s → 94 s |

**Caching.** Two tiers: a local Moka response cache (exact-match,
tool-calls included — a cached edit replays the *edit*, not just the prose)
and provider prompt caching. The editor context is laid out
stable-prefix-first (system prompt → EAL → transcripts → *then* volatile
playhead/selection) so scrubbing never invalidates the cached bulk.

---

## Speech-to-text

Two interchangeable local providers, selected by `CHITRA_STT_PROVIDER`:

- **`whisper_cpp`** — `whisper-cli` with Silero VAD pre-segmentation,
  `--suppress-nst`, zeroed context window, plus a post-filter that drops the
  classic training-data hallucinations ("Thanks for watching", "[Music]",
  …), repairs degenerate per-token timestamps, and discards
  low-confidence segments.
- **`whisperx`** — faster-whisper + wav2vec2 **forced alignment** for
  ±10–30 ms word timestamps. Heaviest, highest quality. Set up with
  `./scripts/install-whisperx.sh`.

Both converge on one `TranscriptResult` shape, cached in IndexedDB keyed by
content fingerprint so re-importing a file never re-spends compute.

---

## Subtitles

Generated from real word-level timestamps. Sentence / phrase / word
granularity, a styled template registry (clean lower-third, bold social,
karaoke, documentary, …), and:

- **Half-open cue activation** `[start, end)` — two adjacent cues sharing a
  boundary never both render on the same frame; the final cue stays visible
  at the very end of the timeline.
- **`REPLACE_TEXTS_IN_RANGE`** — re-generating subtitles atomically
  replaces cues in the clip's range instead of stacking duplicates, and
  places them at exact computed times (no overlap-push).
- **Bulk editing** — "Select All Text" fans style / position / transform
  changes across every overlay; a separate "Shift all by ±N s" control
  moves timing in lockstep without touching style.

---

## Beat detection

`madmom`'s DBN downbeat tracker (Python subprocess) produces beats +
downbeats, surfaced as confined top-strip timeline markers (downbeats
emphasised) for beat-synced cutting. Cached per asset fingerprint.

---

## Rotoscoping & object tracking (SAM2 / EfficientTAM)

Click a subject in the preview; the backend tracks it across the clip and
returns a grayscale matte that drives spotlight / cutout / blur-background
effects.

- **Engine: EfficientTAM** (Apache-2.0, SAM2-API-compatible). Stock Meta
  SAM 2's video predictor was measured at well under 1 FPS on Apple
  Silicon and was ruled out; EfficientTAM-S runs at ~8.5 FPS on MPS with a
  flat ~1.3 GB footprint (benchmarked on real hardware before any product
  code was written).
- **Pipeline:** `POST /api/segment` (sidecar, mirrors WhisperX) → matte
  mp4 → IndexedDB `MASK_STORE` → `TimelineClip.mask` (round-trips through
  EAL) → inspector controls (mode / feather / invert) + a live matte
  preview.

This is shipping in slices; see status.

---

## The performance gate

`npm run perf:gate` (`scripts/perf-gate.mjs`) is run after every non-doc
change. It builds, runs the full test suite, and asserts hot-path
invariants:

- the playhead is owned by the timeline runtime,
- thumbnails and FFmpeg stay in workers,
- the WebGPU compositor stays optional,
- **EAL covers every field** of the serializable model types.

A failing gate is treated as a regression, not something to relax.

---

## Getting started

### Prerequisites

- Node.js 20+ and npm
- Rust (stable) + Cargo
- `ffmpeg` / `ffprobe` on `PATH`
- For speech-to-text: `brew install whisper-cpp` and a `ggml-*.bin` model,
  or run `./scripts/install-whisperx.sh`
- For beat detection: `madmom` in a Python env (see `.env.example`)
- For rotoscoping: `./scripts/install-sam2.sh`
- An OpenRouter API key for the AI chat panel

### Run

```bash
# 1. install frontend deps
npm install

# 2. configure the backend
cp backend/.env.example backend/.env
# edit backend/.env — at minimum set CHITRA_LLM_API_KEY

# 3. start the backend (Tokio + axum) on :8787
cd backend && cargo run -p api

# 4. start the frontend (Vite proxies /api → :8787)
npm run dev      # http://localhost:5173
```

The frontend works without the backend for pure editing; AI chat,
transcription, beats and segmentation require it.

---

## Configuration

All backend configuration is environment variables (see
`backend/.env.example` for the authoritative, commented list). Highlights:

| Variable | Purpose |
|---|---|
| `CHITRA_LLM_API_KEY` / `CHITRA_LLM_MODEL` | OpenRouter key + chat model |
| `CHITRA_STT_PROVIDER` | `whisper_cpp` (default) or `whisperx` |
| `CHITRA_WHISPER_MODEL` / `CHITRA_WHISPER_VAD_MODEL` | ggml model + Silero VAD |
| `CHITRA_WHISPERX_PYTHON` / `_RUNNER` / `_MODEL` | WhisperX venv wiring |
| `CHITRA_SAM2_PYTHON` / `_RUNNER` / `_REPO` / `_MODEL` | EfficientTAM wiring |
| `CHITRA_BEAT_PROVIDER` / `CHITRA_BEAT_PYTHON` | madmom (or aubio) |
| `CHITRA_FFMPEG_PATH` | ffmpeg binary |
| `DATABASE_URL`, `CHITRA_S3_*` | optional project sync (omit to run local-only) |

`backend/.env` is gitignored and never leaves the machine.

---

## Project layout

```
src/                      frontend (React + Vite + TS)
  App.tsx                 the editor shell, timeline, preview, inspector
  projectModel.ts         model types + reducer (the EAL-governed types)
  editArrayLanguage.ts    EAL emit + policy + opcode registry
  editArrayIr.ts          EAL → IR parser
  editCompiler.ts         IR → runtime operations
  editRuntime.ts          executes a compiled plan against a project
  previewCompositor.ts    WebGPU preview pipeline (optional)
  transcodeCommands.ts    FFmpeg filtergraph builder (WYSIWYG)
  subtitles.ts            cue generation + template registry
  segmentation.ts         /api/segment client
  projectStore.ts         IndexedDB (projects, media, transcripts, beats, masks)
  *.test.ts               vitest suites
  aiEditHarness.spec.ts   opt-in real-backend AI-edit integration harness
backend/
  crates/api              HTTP surface, config, state, routes, sidecars
  crates/chat             OpenRouter client, prompt cache, EAL tools
  crates/transcode        FFmpeg worker
  crates/storage          Postgres + object storage (optional)
  crates/core             shared types
scripts/
  perf-gate.mjs           the performance / EAL-coverage gate
  install-whisperx.sh     WhisperX venv setup
  install-sam2.sh         EfficientTAM venv setup
  whisperx_runner.py      WhisperX sidecar
  sam2_runner.py          EfficientTAM sidecar
docs/
  edit-array-language.md  the EAL contract
  sam2-integration-plan.md research + phased plan + spike results
```

---

## Testing

```bash
npm run test         # vitest (frontend unit + integration)
npm run build        # tsc --noEmit + production build
npm run perf:gate    # build + test + hot-path/EAL invariants
cd backend && cargo test -p api
```

The AI-edit harness is excluded from the normal suite (it needs the live
backend + real models) and runs on demand:

```bash
AIEDIT_HARNESS=1 npx vitest run src/aiEditHarness.spec.ts
```

---

## Status & roadmap

Working and verified: timeline editing, WebGPU preview + fallback,
WYSIWYG FFmpeg export, EAL round-trip, AI chat editing (all prompt classes
above), whisper.cpp + WhisperX STT, subtitles, beat detection, the
performance gate.

In active development — **SAM2 / EfficientTAM rotoscoping**, shipping in
slices:

- ✅ `/api/segment` sidecar (EfficientTAM, benchmarked on-device)
- ✅ `TimelineClip.mask` + the promoted `mask` EAL opcode (atomic,
  round-trip tested)
- ✅ `MASK_STORE` persistence
- ✅ Click-to-track UI + full data round-trip + live matte preview
- 🚧 On-screen spotlight / cutout / blur-bg render in the preview
- 🚧 FFmpeg export parity for mask-driven effects

Deferred deliberately (commercial / Apache-MIT-only constraint): video
object-removal inpainting beyond static-watermark removal.

See `docs/sam2-integration-plan.md` for the full research, the on-device
spike numbers, and the phased plan.
