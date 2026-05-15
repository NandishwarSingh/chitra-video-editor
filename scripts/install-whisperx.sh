#!/usr/bin/env bash
# Set up a dedicated WhisperX virtual environment for chitra-video-editor.
#
#   ./scripts/install-whisperx.sh [venv_path]
#
# Default venv path: ~/.chitra-whisperx
#
# After install, point the backend at it:
#   export CHITRA_STT_PROVIDER=whisperx
#   export CHITRA_WHISPERX_PYTHON=<venv_path>/bin/python3
#
# WhisperX brings: VAD pre-segmentation (Silero), faster-whisper backend,
# and wav2vec2 forced alignment for ~10-30ms word timestamp accuracy.

set -euo pipefail

VENV_PATH="${1:-$HOME/.chitra-whisperx}"

# whisperx pins ctranslate2==4.4.0 which only ships wheels for Python
# 3.10–3.13. Prefer a 3.12 binary if available so we avoid building
# ctranslate2 from source on 3.14+ (which doesn't even have a wheel).
PYTHON_BIN="${CHITRA_WHISPERX_PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.12 python3.11 python3.10 python3.13 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      ver=$("$candidate" -c 'import sys; print("%d%02d" % sys.version_info[:2])')
      if [ "$ver" -ge 310 ] && [ "$ver" -le 313 ]; then
        PYTHON_BIN=$(command -v "$candidate")
        break
      fi
    fi
  done
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "error: no compatible Python found. WhisperX needs Python 3.10-3.13."
  echo "       Install with:  brew install python@3.12"
  exit 1
fi

PY_VERSION=$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "Using $PYTHON_BIN (Python $PY_VERSION)"

if [ ! -d "$VENV_PATH" ]; then
  echo "Creating venv at $VENV_PATH ..."
  "$PYTHON_BIN" -m venv "$VENV_PATH"
fi

"$VENV_PATH/bin/pip" install --upgrade pip --quiet
echo "Installing whisperx + faster-whisper ..."
"$VENV_PATH/bin/pip" install --quiet "whisperx>=3.1.5" "faster-whisper>=1.0.0"

echo
echo "Done. Add to backend/.env:"
echo "  CHITRA_STT_PROVIDER=whisperx"
echo "  CHITRA_WHISPERX_PYTHON=$VENV_PATH/bin/python3"
echo "  CHITRA_WHISPERX_MODEL=large-v3-turbo"
echo
echo "On first run, WhisperX will download the wav2vec2 alignment model"
echo "(~360 MB) and the whisper weights (~1.5 GB) under ~/.cache/."
