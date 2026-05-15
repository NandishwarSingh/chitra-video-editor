#!/usr/bin/env python3
"""WhisperX wrapper used by the chitra backend's whisperx provider.

Invoked as:
    python3 whisperx_runner.py <wav_path> <model_size> [<language_hint>]

Emits a JSON document on stdout in the same shape the Rust parser expects
from whisper.cpp's -ojf output, so downstream code only sees one transcript
format:

    {
      "transcription": [
        {
          "text": "...",
          "offsets": {"from": <ms>, "to": <ms>},
          "tokens": [
            {"text": " word", "offsets": {"from": ms, "to": ms}, "p": 0.95}
          ]
        }
      ],
      "result": {"language": "en"}
    }

WhisperX itself provides VAD + alignment so we DON'T re-run the
hallucination filter on the Rust side; pass the result through as-is.
"""
from __future__ import annotations

import json
import os
import sys
import warnings

# Silence the chatty third-party warnings (torch, ctranslate2, etc.) so
# stdout stays clean JSON for the Rust parser.
warnings.filterwarnings("ignore")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def pick_device() -> str:
    """MPS on Apple Silicon, CUDA where available, CPU otherwise."""
    try:
        import torch  # noqa: WPS433
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    # WhisperX still has known issues on MPS for alignment models; CPU is
    # safer on Apple Silicon and is still fast with ctranslate2.
    return "cpu"


def transcribe(wav_path: str, model_size: str, language_hint: str | None) -> dict:
    import whisperx  # noqa: WPS433

    device = pick_device()
    compute_type = "int8" if device == "cpu" else "float16"

    asr = whisperx.load_model(
        model_size,
        device=device,
        compute_type=compute_type,
        asr_options={
            # condition_on_previous_text=False prevents prior-segment
            # hallucinations from cascading through the file.
            "suppress_numerals": False,
            "max_new_tokens": None,
            "clip_timestamps": "0",
            "hallucination_silence_threshold": 2.0,
        },
        vad_options={
            "vad_onset": 0.500,
            "vad_offset": 0.363,
            "chunk_size": 30,
        },
    )

    audio = whisperx.load_audio(wav_path)
    asr_result = asr.transcribe(
        audio,
        batch_size=16,
        language=language_hint,
    )

    # Align using wav2vec2 for word-level accuracy.
    language = asr_result.get("language", language_hint or "en")
    try:
        align_model, align_meta = whisperx.load_align_model(
            language_code=language, device=device,
        )
        aligned = whisperx.align(
            asr_result["segments"],
            align_model,
            align_meta,
            audio,
            device,
            return_char_alignments=False,
        )
        segments = aligned["segments"]
    except Exception as exc:  # noqa: BLE001
        # Alignment can fail for languages without a wav2vec2 model; fall
        # back to ASR-level word timestamps.
        print(f"warn: alignment failed, using ASR timestamps: {exc}", file=sys.stderr)
        segments = asr_result["segments"]

    transcription = []
    for seg in segments:
        words = seg.get("words") or []
        tokens = []
        for w in words:
            start = float(w.get("start", seg.get("start", 0.0)))
            end = float(w.get("end", seg.get("end", start)))
            tokens.append({
                "text": f" {w.get('word', '').strip()}",
                "offsets": {
                    "from": int(round(start * 1000)),
                    "to": int(round(end * 1000)),
                },
                "p": float(w.get("score", 1.0)) if w.get("score") is not None else 1.0,
            })

        transcription.append({
            "text": seg.get("text", "").strip(),
            "offsets": {
                "from": int(round(float(seg.get("start", 0.0)) * 1000)),
                "to": int(round(float(seg.get("end", 0.0)) * 1000)),
            },
            "tokens": tokens,
        })

    return {
        "result": {"language": language},
        "transcription": transcription,
    }


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: whisperx_runner.py <wav> <model> [<lang>]", file=sys.stderr)
        return 2

    wav_path = sys.argv[1]
    model_size = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) >= 4 and sys.argv[3] not in ("", "auto") else None

    out = transcribe(wav_path, model_size, language)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
