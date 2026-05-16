#!/usr/bin/env python3
"""Phase-0 spike runner for the SAM2 segmentation suite (EfficientTAM engine).

Invoked as:
    python3 sam2_runner.py <video> <repo_dir> <model_name> <out_json> <prompt_json>

- <repo_dir>      EfficientTAM clone (has checkpoints/ and configs/)
- <model_name>    e.g. efficienttam_s_512x512
- <prompt_json>   {"frame": 0, "points": [[x,y]], "labels": [1]}  (pixel coords)
                  or {"frame": 0, "box": [x0,y0,x1,y1]}

Writes a manifest JSON to <out_json> and a grayscale mask video next to it.
Like the WhisperX runner: progress/logs go to STDERR, the result is a FILE —
torch/ETAM spray stdout, so stdout is never trusted.

This is a benchmark/spike: it also records wall-clock, peak RSS, and FPS so the
re-plan has hard numbers from this exact machine.
"""
from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import tempfile
import time
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def pick_device() -> str:
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def peak_rss_mb() -> float:
    # ru_maxrss is bytes on macOS, kB on Linux.
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


def extract_frames(video: str, out_dir: str) -> tuple[int, float]:
    """ffmpeg → zero-padded JPEGs. -vsync vfr + -noautorotate guard the
    frame↔time mapping (the VFR/rotation pitfall from research)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate,nb_read_frames",
         "-count_frames", "-of", "json", video],
        capture_output=True, text=True,
    )
    fps = 30.0
    try:
        st = json.loads(probe.stdout)["streams"][0]
        num, den = st["r_frame_rate"].split("/")
        fps = float(num) / float(den) if float(den) else 30.0
    except Exception:
        pass
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-noautorotate", "-i", video,
         "-vsync", "vfr", "-q:v", "2", "-start_number", "0",
         os.path.join(out_dir, "%05d.jpg")],
        check=True,
    )
    n = len([f for f in os.listdir(out_dir) if f.endswith(".jpg")])
    return n, fps


def main() -> int:
    if len(sys.argv) < 6:
        log("usage: sam2_runner.py <video> <repo> <model> <out_json> <prompt_json>")
        return 2
    video, repo, model, out_json, prompt_json = sys.argv[1:6]
    prompt = json.loads(prompt_json)

    sys.path.insert(0, repo)
    import numpy as np
    import torch
    from efficient_track_anything.build_efficienttam import (
        build_efficienttam_video_predictor,
    )

    device = pick_device()
    cfg = f"configs/efficienttam/{model}.yaml"
    ckpt = os.path.join(repo, "checkpoints", f"{model}.pt")
    log(f"device={device} cfg={cfg} ckpt={ckpt}")

    t0 = time.time()
    with tempfile.TemporaryDirectory() as work:
        frames_dir = os.path.join(work, "frames")
        os.makedirs(frames_dir)
        n_frames, fps = extract_frames(video, frames_dir)
        t_extract = time.time() - t0
        log(f"frames={n_frames} fps={fps:.3f} extract={t_extract:.1f}s")

        predictor = build_efficienttam_video_predictor(cfg, ckpt, device=device)
        t_load = time.time() - t0 - t_extract
        log(f"model loaded in {t_load:.1f}s")

        autocast = (
            torch.autocast(device, dtype=torch.bfloat16)
            if device == "cuda"
            else torch.autocast("cpu", dtype=torch.float32)
        )
        t_infer0 = time.time()
        masks_dir = os.path.join(work, "masks")
        os.makedirs(masks_dir)

        with torch.inference_mode(), autocast:
            state = predictor.init_state(
                frames_dir,
                offload_video_to_cpu=True,
                offload_state_to_cpu=True,
                async_loading_frames=True,
            )
            f = int(prompt.get("frame", 0))
            if "box" in prompt:
                predictor.add_new_points_or_box(
                    state, frame_idx=f, obj_id=1,
                    box=np.array(prompt["box"], dtype=np.float32),
                )
            else:
                predictor.add_new_points_or_box(
                    state, frame_idx=f, obj_id=1,
                    points=np.array(prompt["points"], dtype=np.float32),
                    labels=np.array(prompt.get("labels", [1]), dtype=np.int32),
                )
            propagated = 0
            for fidx, _obj_ids, logits in predictor.propagate_in_video(state):
                m = (logits[0] > 0.0).squeeze().cpu().numpy().astype(np.uint8) * 255
                from PIL import Image
                Image.fromarray(m, mode="L").save(
                    os.path.join(masks_dir, f"{fidx:05d}.png")
                )
                propagated += 1
                if propagated % 30 == 0:
                    log(f"propagate {propagated}/{n_frames}")

        t_infer = time.time() - t_infer0
        mask_video = os.path.splitext(out_json)[0] + "_mask.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", f"{fps}",
             "-i", os.path.join(masks_dir, "%05d.png"),
             "-c:v", "libx264", "-pix_fmt", "gray", "-crf", "10", mask_video],
            check=True,
        )

    total = time.time() - t0
    manifest = {
        "engine": "efficienttam",
        "model": model,
        "device": device,
        "frames": n_frames,
        "propagated": propagated,
        "source_fps": fps,
        "mask_video": mask_video,
        "timings_s": {
            "extract": round(t_extract, 2),
            "model_load": round(t_load, 2),
            "inference": round(t_infer, 2),
            "total": round(total, 2),
        },
        "infer_fps": round(propagated / t_infer, 3) if t_infer > 0 else None,
        "peak_rss_mb": round(peak_rss_mb(), 1),
    }
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    log("MANIFEST " + json.dumps(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
