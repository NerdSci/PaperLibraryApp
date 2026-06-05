#!/usr/bin/env bash
# Local setup and run helper for DocsReader (macOS / Linux).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-python3}"
VENV_DIR=".venv"
PORT="${PORT:-5000}"

usage() {
  cat <<EOF
Usage: ./setup.sh [command]

Commands:
  (none)    Create venv, install dependencies, ensure data/ exists
  run       Activate venv and start the dev server (port $PORT)
  docker    Build and run via Docker (see Dockerfile)

Environment:
  PYTHON    Python executable (default: python3)
  PORT      Dev server port for 'run' (default: 5000)
EOF
}

require_python() {
  if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "Error: '$PYTHON' not found. Install Python 3.9+ and try again." >&2
    exit 1
  fi
  "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
    || { echo "Error: Python 3.9+ is required." >&2; exit 1; }
}

setup_venv() {
  require_python
  if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment in $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  mkdir -p data/pdfs
  echo ""
  echo "Setup complete."
  echo "  source .venv/bin/activate && python app.py"
  echo "  or: ./setup.sh run"
  echo ""
  echo "Open http://127.0.0.1:${PORT}/"
}

run_dev() {
  if [ ! -d "$VENV_DIR" ]; then
    setup_venv
  else
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
  fi
  mkdir -p data/pdfs
  echo "Starting DocsReader on http://127.0.0.1:${PORT}/"
  exec python app.py
}

run_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found." >&2
    exit 1
  fi
  docker build -t docsreader .
  docker run --rm -it \
    -p "${PORT}:5000" \
    -v docsreader-data:/app/data \
    --name docsreader \
    docsreader
}

case "${1:-setup}" in
  setup|"") setup_venv ;;
  run) run_dev ;;
  docker) run_docker ;;
  -h|--help|help) usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    exit 1
    ;;
esac
