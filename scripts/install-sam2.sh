#!/usr/bin/env bash
# Phase-0 spike installer for the SAM2 segmentation suite.
#
#   ./scripts/install-sam2.sh [venv_path]
#
# Default venv: ~/.chitra-sam2
#
# Engine: EfficientTAM (Apache-2.0) — SAM2-API-compatible, real video tracking,
# explicit Apple-Silicon/MPS support. Stock Meta SAM 2's video predictor is
# unusable on MPS (<1 FPS); EfficientTAM is the commercial, Mac-viable engine.
#
# Installs the 512x512 small variant (efficienttam_s_512x512) — the
# lowest-latency tier, correct for benchmarking on an M-series Mac.
#
# After install, point the backend at it:
#   CHITRA_SAM2_PYTHON=<venv>/bin/python3
#   CHITRA_SAM2_RUNNER=<repo>/scripts/sam2_runner.py
#   CHITRA_SAM2_REPO=<venv>/EfficientTAM
#   CHITRA_SAM2_MODEL=efficienttam_s_512x512

set -euo pipefail

VENV_PATH="${1:-$HOME/.chitra-sam2}"
ETAM_DIR="$VENV_PATH/EfficientTAM"
HF_BASE="https://huggingface.co/yunyangx/efficient-track-anything/resolve/main"
CKPT="efficienttam_s_512x512.pt"

# EfficientTAM (a SAM2 fork) pins to the SAM2 toolchain: torch>=2.5, py 3.10-3.12.
# 3.14 (Homebrew default) has no torch wheel — same trap WhisperX hit.
PYTHON_BIN="${CHITRA_SAM2_PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  for c in python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1; then
      v=$("$c" -c 'import sys;print("%d%02d"%sys.version_info[:2])')
      if [ "$v" -ge 310 ] && [ "$v" -le 312 ]; then PYTHON_BIN=$(command -v "$c"); break; fi
    fi
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "error: need Python 3.10-3.12. Install: brew install python@3.12"
  exit 1
fi
echo "Using $PYTHON_BIN ($("$PYTHON_BIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])'))"

if [ ! -d "$VENV_PATH" ]; then
  "$PYTHON_BIN" -m venv "$VENV_PATH"
fi
PY="$VENV_PATH/bin/python3"
PIP="$VENV_PATH/bin/pip"

"$PIP" install --upgrade pip --quiet

if [ ! -d "$ETAM_DIR/.git" ]; then
  echo "Cloning EfficientTAM ..."
  git clone --depth 1 https://github.com/yformer/EfficientTAM.git "$ETAM_DIR"
fi

echo "Installing torch + EfficientTAM (this is the slow part, ~2 GB) ..."
# SAM2_BUILD_CUDA=0: the optional CUDA post-proc kernel is irrelevant on Mac
# and its build failure otherwise looks like a fatal error.
SAM2_BUILD_CUDA=0 "$PIP" install --quiet "torch>=2.5.1" "torchvision>=0.20.1"
SAM2_BUILD_CUDA=0 "$PIP" install --quiet -e "$ETAM_DIR"
"$PIP" install --quiet opencv-python-headless pillow numpy

# Patch the documented MPS float64 bug: `img_np / 255.0` on a uint8 array
# yields float64, which Apple MPS cannot hold (hard TypeError in init_state).
# Coercing to float32 is numerically identical — the model runs in float32.
MISC_PY="$ETAM_DIR/efficient_track_anything/utils/misc.py"
if grep -q 'img_np = img_np / 255.0$' "$MISC_PY" 2>/dev/null; then
  sed -i '' 's|img_np = img_np / 255.0$|img_np = (img_np / 255.0).astype(np.float32)  # chitra: MPS has no float64|' "$MISC_PY"
  echo "Patched MPS float64 bug in misc.py"
fi

mkdir -p "$ETAM_DIR/checkpoints"
if [ ! -f "$ETAM_DIR/checkpoints/$CKPT" ]; then
  echo "Downloading $CKPT ..."
  curl -fL "$HF_BASE/$CKPT" -o "$ETAM_DIR/checkpoints/$CKPT"
fi

echo
echo "Done."
echo "  venv : $VENV_PATH"
echo "  repo : $ETAM_DIR"
echo "  ckpt : $ETAM_DIR/checkpoints/$CKPT"
echo
echo "Backend env:"
echo "  CHITRA_SAM2_PYTHON=$PY"
echo "  CHITRA_SAM2_REPO=$ETAM_DIR"
echo "  CHITRA_SAM2_MODEL=efficienttam_s_512x512"
