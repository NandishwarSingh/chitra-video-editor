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

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not on PATH. Install Python 3.10+ first."
  exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "Using Python $PY_VERSION"

if [ ! -d "$VENV_PATH" ]; then
  echo "Creating venv at $VENV_PATH ..."
  python3 -m venv "$VENV_PATH"
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
