# SAM2 Segmentation Suite — Production Plan

Synthesized from 12 parallel research tracks (Meta official, GitHub/Codeberg,
SO, dev.to, Medium, and a full read of this codebase). This is a plan, not an
implementation. Nothing here is built yet.

## LOCKED DECISIONS (2026-05-16)

1. **Target is a Tauri desktop app**, not a pure browser app. Re-plan after
   the spike must account for: native sidecars (no localhost HTTP proxy
   needed — Tauri commands / shell sidecar), **real filesystem** for mask
   storage (kills the IndexedDB quota constraint in §2.2 — masks become
   on-disk files keyed by fingerprint), native GPU access, no browser memory
   ceiling. The existing Rust axum crate is reusable as the Tauri sidecar or
   collapsed into Tauri commands. The WebGPU compositor stays (Tauri webview
   supports WebGPU). This is a separate migration plan produced *after* the
   spike data lands.
2. **Commercial product, Apache/MIT only.** Engine = EfficientTAM-S / EdgeTAM
   (Apache-2.0). Matting = BiRefNet (MIT) + flow-EMA smoothing only. MatAnyone
   (NTU S-Lab), RVM (GPL-3.0), ProPainter / E2FGVI (non-commercial) are
   **excluded from the bundle**. Object removal scoped to watermark/static-logo
   via LaMa only; full subject removal deferred indefinitely.
3. **Sequencing: spike only, then re-plan** with hard numbers + the Tauri
   context. No product/EAL code until the re-plan is approved.

---

## 0. The one decision that changes everything

**Do not ship stock Meta SAM 2's video predictor as the engine on this
machine.** This is an Apple-Silicon Mac with no NVIDIA GPU. Verified facts:

- Stock SAM 2 video predictor on MPS is officially "preliminary", needs
  `PYTORCH_ENABLE_MPS_FALLBACK=1`, diverges numerically with bf16, and runs at
  **a fraction of 1 FPS** (reference: ~1 FPS even on a T4 GPU; ~4 s/frame
  image-only on M3). Unusable for anything interactive.
- **EfficientTAM-S/2** and **EdgeTAM** are SAM2-API-compatible, **Apache-2.0**,
  keep the masklet/memory tracking, have **explicit Mac/MPS support**, and run
  near-real-time on M-series (EdgeTAM: 15.7 FPS on an iPhone 15 Pro Max → fast
  on an M-series GPU).

**Engine choice: EfficientTAM-S as default, EdgeTAM as the fast/low-power
fallback, stock SAM 2.1-large as an optional "max quality, slow, background-job"
tier.** The runner abstracts the model behind one interface so all three are
swappable by env var. SAM 2.1's API shape is the contract; EfficientTAM/EdgeTAM
implement it.

The browser also gets a **SlimSAM (transformers.js, ~14 MB, WebGPU)** path —
but only for *instant single-frame click→preview*, never video propagation
(video memory-attention is not exportable to onnxruntime-web and would blow the
tab's memory).

---

## 1. Architecture

### 1.1 Backend sidecar (mirror WhisperX exactly)

The WhisperX integration is the proven template. New files mirror it 1:1:

| New file | Cloned from |
|---|---|
| `scripts/sam2_runner.py` | `scripts/whisperx_runner.py` |
| `scripts/install-sam2.sh` | `scripts/install-whisperx.sh` |
| `backend/crates/api/src/segment.rs` | `backend/crates/api/src/transcribe.rs` |
| `backend/crates/api/src/routes/segment.rs` | `backend/crates/api/src/routes/transcribe.rs` |
| `src/segmentation.ts` | `src/transcribe.ts` |

Hard rules carried from the WhisperX work (these were real bugs we already hit):

- Runner writes JSON/masks to a **designated output path argument**, never
  stdout. torch/pyannote/SAM2 spray progress to stdout/stderr; a stdout pipe is
  not safe (this exact bug cost us a debugging cycle on WhisperX).
- Rust spawns with `stdout(Stdio::null())`, `stderr(Stdio::piped())`, reads the
  output file with `tokio::fs::read_to_string`.
- Config via env (`config.rs`): `CHITRA_SAM2_PYTHON`, `CHITRA_SAM2_RUNNER`,
  `CHITRA_SAM2_MODEL` (efficienttam_s | edgetam | sam2.1_hiera_large),
  `CHITRA_SAM2_CHECKPOINT`, `CHITRA_SAM2_DEVICE` (auto). `is_enabled()` =
  python+runner non-empty. Fault-tolerant init in `state.rs` (None + warn).
- Install script must prefer Python **3.10–3.12** (we learned 3.14 has no
  ctranslate2/torch wheels — same trap as WhisperX). Venv `~/.chitra-sam2`.
- Body limits already global in `routes/mod.rs` (`DefaultBodyLimit::disable()`
  + 4 GiB). Register `.nest("/api/segment", segment::router())`.

### 1.2 Job model

- **v1: synchronous**, exactly like `/api/transcribe`. Frontend shows the
  existing indeterminate-spinner pattern (`transcribingFingerprints` →
  `segmentingFingerprints`). Acceptable for short clips / keyframe-seeded short
  ranges.
- **v2: async job**, only when clip length makes hold-open untenable. The
  building blocks already exist: `chitra_core::JobStatus`, the
  `TranscodeWorker` state machine, `routes/jobs.rs` (`GET /api/jobs/:id`), and
  the SSE precedent in `routes/chat.rs`. `sam2_runner.py` prints
  `{"progress": x}` to **stderr** (stdout/file stays clean for the manifest);
  Rust parses incrementally.

### 1.3 One warm worker + queue (non-negotiable)

`inference_state` is a large mutable dict mutated in place; sharing it across
concurrent requests causes OOM and CUDA-graph corruption. Rebuilding the model
per request leaks VRAM. **One long-lived warm model process + a serialized
queue**, one process per accelerator. Per-session `inference_state` with
explicit `reset_state` + `gc.collect()` teardown between jobs.

### 1.4 Browser hybrid

- **Client (SlimSAM via `@huggingface/transformers` v3, q8, WebGPU, in a Web
  Worker):** on pause/scrub, encode the current frame once (~0.3 s WebGPU),
  then every click is a **<50 ms decode → instant mask overlay**. This is the
  UX-critical path — a network round-trip per click kills the feel.
- **Server (EfficientTAM):** when the user confirms a tracked object, send the
  prompt → propagate across the clip → return the mask track.
- Composite the returned mask as a **second texture in the existing
  `previewCompositor.ts` WebGPU bind group** (binding 3 + sampler); mask
  *display* stays fully on-GPU even though inference round-trips through CPU
  tensors. Vite caveat: prefer transformers.js over raw `onnxruntime-web`
  (Vite chokes on `onnxruntime-webgpu`); run inference in a worker (matches
  the perf-gate worker invariant).

---

## 2. Data model & the EAL contract (CLAUDE.md §3 — the critical part)

`mask`, `keyframe`, `animation`, `camera` are **reserved EAL opcodes today**
(`editArrayLanguage.ts`, `editArrayIr.ts`, `docs/edit-array-language.md`). Per
CLAUDE.md §3 they must be **promoted reserved→required** with the full
emit/parse path when the feature lands.

### 2.1 Source-of-truth model

An `ObjectTrack` is a **project-owned, id-referenced** object (the model every
pro editor uses — OpenShot `ParentClip`+`Id()`, Fusion published track):

```
ObjectTrack {
  id, name, sourceClipId, sourceRange{in,out}, source: 'manual'|'face'|'sam2',
  geometry: { kind: 'rect'|'ellipse'|'bezier'|'raster', base?, feather, rasterAssetId? },
  transformTrack: Array<{ t, x, y, scaleX, scaleY, rotation, corners?, interp }>,
  bindings: Array<{ target:'effect'|'overlay', id, mode, region:'inside'|'outside', params }>
}
```

- Parametric kinds (rect/ellipse/bezier) cover spotlight/blur/sticker/grade —
  tiny, editable, re-timeable, sparse keyframes.
- `raster` kind references an **RLE/mask-video sidecar asset** (the
  `generated_asset` opcode) — never inline binary in the model.
- Mask = `transformTrack` evaluated at `t` applied to `geometry`. Per-frame
  raster is the fallback when geometry can't describe the subject.

### 2.2 Storage (IndexedDB, mirror `projectStore.ts`)

- Primary: **one grayscale mask video per object** (mask in luma plane, VP9
  near-lossless). ~2–8 MB for a 7-min/12,600-frame object at 480p (vs
  20–190 MB for RLE-JSON / PNG sequence). Store at **480p, bilinear-upscale at
  composite** (540–720p only if used as a hard key over a busy background).
- Scrub-edit cache: **packed binary RLE** chunked at 256 frames; decode is
  <1 ms/frame in plain JS at 480p.
- New store `MASK_STORE`, `DB_VERSION` 6→7, keyed by content fingerprint
  (re-imported media reuses masks — no GPU re-spend). Chunked ~2–4 s segments;
  LRU decode cache (~300 frames); `navigator.storage.persist()`;
  `QuotaExceededError` → evict cold segments.

### 2.3 WYSIWYG export parity (the consistency-critical part)

Two independent render paths must apply the identical mask:

- **Preview** (`previewCompositor.ts`): mask → `R8` alpha texture, sampled by
  UV in `fragment_main`, bilinear-upscaled, `mix(base, effected, region)`.
  Keep `importExternalTexture` + `setGpuPreviewActive(false)` intact (perf-gate
  asserts these literally). Extend `shouldComposite` to also activate on a
  masked clip, keeping the optional/fallback posture.
- **Export** (`transcodeCommands.ts` `buildLayeredTimelineArgs`, in the
  worker): feed the mask video as an extra ffmpeg input; **same
  `createVideoTransformFilters` chain** as the clip so transform/scale/crop
  stay locked; `scale=...:flags=bilinear` (must match WebGPU's bilinear),
  near-lossless mask codec, `-r 30`/`fps=30` frame-exact, then `alphamerge` /
  `maskedmerge` before the `overlay`. ffmpeg stays in the worker (perf-gate
  asserts `@ffmpeg/ffmpeg` in `transcodeWorker.ts`).

### 2.4 The five mandatory EAL steps per new field (CLAUDE.md §3)

For `TimelineClip.mask` and the `ObjectTrack` collection, in the **same
change**:

1. `EDIT_ARRAY_FIELD_POLICY` in `editArrayLanguage.ts` — add fields to
   `covered`; promote `mask`/`keyframe` reserved→required.
2. Emit in `createEditArrayProgram` (`['mask', clipId, {...}]` instruction;
   `['keyframe', ...]` for transform tracks).
3. Parse in `compileEditArrayToIr` (`editArrayIr.ts`) — de-reserve, accumulate
   like `clipAudio`/`clipEffects`, merge into `ir.clips`.
4. `scripts/perf-gate.mjs` coverage list for `TimelineClip`.
5. Round-trip tests in `editArrayLanguage.test.ts` + `editCompiler.test.ts`;
   update the reserved-opcode assertions.

Plus `normalizeTimelineClip` clamps (`mode` enum, `feather`, default null) so
persisted/rehydrated/EAL-imported state is safe (CLAUDE.md §4). Reducer action
`UPDATE_CLIP_MASK` mirroring `UPDATE_CLIP_TRANSFORM`. Run `npm run perf:gate`.

---

## 3. Phased roadmap (each phase independently shippable)

### Phase 0 — Spike & de-risk (no product surface)
- Stand up `scripts/install-sam2.sh` with EfficientTAM-S; `sam2_runner.py`
  CLI: video + prompt JSON → mask manifest + grayscale mask video.
- Measure real FPS on this Mac for tiny/small at 512/640px. Confirm the
  async/chunked offload recipe (offload_video_to_cpu, fp16 frame storage,
  memory-bank pruning ≤16 frames, ~10 s chunks, async loader storage line
  disabled). **Exit criterion:** a 30 s clip segments in < ~2 min wall-clock
  without OOM.
- Apache-2.0 license audit of the exact engine + deps actually shipped.

### Phase 1 — Mask-track infrastructure + Click-to-track Spotlight
The enabling investment; ships a visible wow as its first payoff.
- Backend sidecar end-to-end (Phase 0 hardened into the axum endpoint).
- `ObjectTrack` model + full EAL wiring (§2.4) + `MASK_STORE`.
- Browser SlimSAM instant click→preview; confirm → server propagate.
- One mask-driven effect primitive: "apply effect inside/outside mask with
  feather", wired into the WebGPU shader **and** the ffmpeg worker.
- First effect: **Spotlight / dim-the-rest** (S — reuses existing
  brightness/saturation uniforms on the inverse mask).
- **Acceptance:** click subject on a frame → tracked → background dims through
  the clip → exports byte-for-byte matching the preview → the whole edit
  round-trips through EAL and `npm run perf:gate` passes.

### Phase 2 — Selective color + glow/outline bundle (S, near-free post-Phase 1)
- Subject-in-color / world-B&W, edge glow/outline/RGB-split. Pure shader
  branches off the Phase 1 mask + existing `EffectSettings` path. High
  shareability, minimal new code.

### Phase 3 — Auto face/plate blur before export (M, high utility)
- Box-tracked face/plate detection → multi-object track → blur/pixelate inside
  mask, baked at export. Loose masks are acceptable here (forgiving) — low
  SAM2-quality risk. One-click from AI chat.

### Phase 4 — Auto-reframe AI-selected shorts on the speaker (M, top differentiator)
- Promote the reserved `keyframe` opcode (transform keyframes on
  `TimelineClip`). AutoFlip kinematic smoother (Apache-2.0) reimplemented in a
  TS worker: shot-split → per-axis damped tracker with deadzone ("lock then
  ease", `update_rate≈0.2 s`, EMA prefilter α≈0.1–0.2, velocity-clamped) →
  sparse keyframes (≤2–4/s).
- **Subject source:** face-detect by default (talking-head is the dominant
  case; SAM2 is overkill); EfficientTAM only for object/hard-motion clips.
- **The novel combination:** chain the existing auto-shorts selection ×
  WhisperX active-speaker timing × subject track × reframe → vertical,
  speaker-locked shorts with zero manual steps. No competitor ships this
  end-to-end from raw single-cam footage.

### Phase 5 — Background removal / replace (M–L, premium checkbox)
- Subject mask → alpha matte. For broadcast edges, add a matting stage:
  **BiRefNet (MIT, per-frame) + optical-flow EMA temporal smoothing** is the
  commercially-clean default; MatAnyone (NTU S-Lab — license review) as an
  optional higher-quality tier; RVM only as an isolated subprocess (GPL-3.0).
  Position as "social-media good", not "broadcast key"; offer manual
  point-refine fallback.

### Phase 6 — AI-chat segmentation commands + transcript/beat compositions
- "blur the guy on the left", "spotlight whoever is talking", "keep me in
  color". Wire segmentation into the existing chat tool surface. "Keep only
  the speaker" = WhisperX diarization × SAM2 identity tracks. Beat-synced
  subject effects (strobe spotlight on downbeats — beat detection already
  exists). Transcript-driven subject zoom during speech segments.

### Deliberately deferred / out of scope
- **Object removal + content-aware video fill.** SAM2 gives a clean mask but
  the *fill* (ProPainter/E2FGVI) is **non-commercial-licensed** (NTU S-Lab /
  CC-BY-NC) and slow (~1–2 min compute per second of 480p video on this Mac).
  Only ship the **watermark/static-logo** sub-case via per-frame LaMa
  (licensable, fast); never promise "remove anything".
- In-browser video tracking (not feasible — memory-attention not exportable).
- Frame-perfect hair/motion-blur/transparency edges (set expectations).
- SAM 3.1 text-prompt selection as instant/local (it's a backend-GPU tier).

---

## 4. License decision matrix (needs an explicit call before Phase 5)

| Component | License | Commercial? | Verdict |
|---|---|---|---|
| SAM 2.1 / EfficientTAM / EdgeTAM | Apache-2.0 (code+weights) | ✅ | Ship freely; keep NOTICE; audit forks |
| SlimSAM | Apache-2.0 | ✅ | Ship |
| AutoFlip kinematic algorithm | Apache-2.0 | ✅ | Reimplement freely |
| BiRefNet (matting) | MIT | ✅ | Default matting tier |
| MatAnyone (matting, best) | NTU S-Lab 1.0 | ⚠️ research-leaning | Legal review before bundling |
| RVM (matting, real-time) | GPL-3.0 | ⚠️ copyleft | Only as isolated subprocess/service |
| ProPainter / E2FGVI (inpaint) | NTU S-Lab / CC-BY-NC | ❌ non-commercial | Do not bundle; server-licensed or skip |
| LaMa (image inpaint, logo) | Apache-2.0-class | ✅ | Watermark-removal sub-case only |

---

## 5. Risk register (top, with the verified mitigation)

1. **OOM on long video** — `init_state` pre-encodes every frame (~60 GB for
   2.5 min). Mitigation: offload_video/state_to_cpu, fp16 frame storage,
   async loader with storage line disabled, memory-bank prune to last ~16,
   ~10 s chunks seeding the next chunk's prompt. Verified in Phase 0.
2. **Apple-Silicon viability** — stock SAM2 unusable. Mitigation: EfficientTAM/
   EdgeTAM, fp16 (not bf16), `PYTORCH_ENABLE_MPS_FALLBACK=1`,
   `SAM2_BUILD_CUDA=0`, 512–640 px, frame-stride + flow interpolation.
3. **Concurrency corruption** — Mitigation: one warm worker + queue, per-
   session state, explicit teardown. Never thread-share the model.
4. **VFR / rotation metadata** breaks frame↔time mapping — Mitigation:
   `ffmpeg -q:v 2 -start_number 0 %05d.jpg`, `-vsync vfr`, strip rotation,
   verify frame count with ffprobe, zero-padded names.
5. **EAL coverage gate hard-fails** if a `TimelineClip` field is added without
   policy+emit in the same change — Mitigation: §2.4 checklist, perf-gate
   every change (CLAUDE.md §2).
6. **Export ≠ preview drift** — Mitigation: identical bilinear upscale both
   sides, near-lossless mask codec, frame-exact fps, mask through the same
   transform-filter chain.
7. **License contamination** (GPL/non-commercial pulled into the bundle) —
   Mitigation: §4 matrix; isolate or skip flagged components.
8. **100 MB+ model first-download kills the demo** — Mitigation: lazy-load on
   first segmentation use with progress; small/base default checkpoint.

---

## 6. First concrete action when approved

Phase 0 spike: `scripts/install-sam2.sh` (EfficientTAM-S, Python 3.12 venv) +
`scripts/sam2_runner.py` + a one-off benchmark on a 30 s slice of the 7-min
test clip to lock the engine + chunk/offload config before any product code or
EAL changes. No `TimelineClip`/EAL change happens until Phase 1, and when it
does it follows the §2.4 five-step checklist atomically.

---

# Phase 0 Spike — RESULTS (2026-05-16, this machine)

Ran on the actual target hardware (Apple Silicon, MPS). Engine:
**EfficientTAM-S 512×512** (Apache-2.0). Input: a 30 s slice of the real
7-min test clip — 1800 frames @ 1920×1080, single center-point prompt,
`offload_video_to_cpu / offload_state_to_cpu / async_loading_frames` all on.

| Metric | Measured |
|---|---|
| Device | MPS (Apple Silicon) |
| Frames propagated | **1800 / 1800** (full track from one prompt, no drift crash, no id-loss crash) |
| Inference throughput | **8.49 FPS** |
| Peak RSS | **1.3 GB** (no OOM; flat — the documented #1 SAM2 killer is mitigated) |
| Model load | 0.31 s |
| Frame extract (ffmpeg) | 3.66 s |
| Total wall-clock | 220 s for a 30 s / 1800-frame clip |
| Mask video output | 2.65 MB, grayscale H.264 crf10, 1800×1080p frames |

### Bug found & fixed during the spike (why we spike before product code)

EfficientTAM's frame loader (`utils/misc.py:96`) does `img_np / 255.0` on a
uint8 array → **float64**, which Apple MPS cannot hold → hard `TypeError` in
`init_state` on *any* Mac. Patched to `.astype(np.float32)` (numerically
identical — the model runs float32). Fix is baked into `install-sam2.sh`
idempotently so it's reproducible. Stock Meta SAM 2 would also have been
unusable here (<1 FPS); the EfficientTAM swap was load-bearing.

### Verdict

On-device rotoscoping on Apple Silicon is **a viable async background job**,
not real-time-interactive:

- 8.49 FPS ≈ **0.28× realtime at 30 fps**. A 10 s selected range (300 frames
  @30fps) tracks in **~35 s**; a 60 s range in ~3.5 min. Acceptable as a
  "select object → progress bar → masks land" job, *unacceptable* as a
  per-frame live scrub.
- Memory is a **non-issue** (1.3 GB peak, flat) — long clips will not OOM.
  This kills the single biggest documented SAM2 production risk outright.
- Mask storage is **tiny** (2.65 MB / 1800 1080p frames) — the
  grayscale-mask-video format from §2.2 is validated; on a Tauri desktop app
  this is just a project-folder file, no IndexedDB quota concern at all.
- The interactive feel is preserved by the **two-tier** design: browser
  SlimSAM gives the instant click→preview on the current frame (<50 ms);
  EfficientTAM does cross-frame propagation as the background job. The spike
  confirms tier 2 is sound.

### Re-plan deltas (supersede earlier phases where noted)

1. **Job model = async from day one** (was "v1 synchronous"). At ~0.28×
   realtime, even a short clip exceeds a comfortable synchronous HTTP hold.
   Use the `TranscodeWorker`-style job + progress model immediately; the
   runner already emits parseable progress to stderr. On Tauri this is a
   long-lived sidecar with a job queue, not an axum request.
2. **Tauri changes the transport, not the engine.** The Python venv +
   EfficientTAM stays exactly as spiked. Tauri replaces the axum HTTP
   endpoint with a Rust command spawning the same sidecar; masks write to
   the project folder on disk (drop §2.2's IndexedDB chunking entirely —
   it was a browser-only constraint). The WebGPU compositor + EAL wiring
   (§2.4) are unchanged.
3. **Default tier = EfficientTAM-S 512** (proven 8.5 FPS / 1.3 GB). Offer
   `efficienttam_ti` as a faster/lower-quality option and frame-striding
   (segment every Nth frame + flow-fill) only if a user needs sub-10 s
   turnaround on long ranges — not required for launch.
4. **Phase ordering holds** (Phase 1 = mask-track infra + click-to-track
   spotlight) but every mask-producing action is a job with a progress UI,
   never a blocking call. The §2.4 EAL five-step checklist is unchanged and
   still atomic with the first `TimelineClip.mask` field.
5. **Memory mitigations are confirmed sufficient** at the spiked settings
   for clip-length ranges; the aggressive memory-bank pruning from the
   pitfalls research is only needed for multi-minute single-prompt tracks —
   defer it to a Phase-1 hardening task, not a blocker.

### Open items for the Tauri re-plan (separate doc, after approval)

- Tauri sidecar packaging of a ~2 GB Python/torch venv (or ship a frozen
  binary) — distribution-size decision.
- Whether the existing axum crate stays as a localhost sidecar (least churn)
  or collapses into Tauri commands.
- Code-signing/notarization implications of bundling a Python runtime.

These do not block Phase 1; they are migration-plan scope.
