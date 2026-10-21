#!/usr/bin/env bash
# Start the Qualilab backend on EC2 (or any Linux host).
# Usage:
#   ./scripts/start-backend.sh
#   VENV=/home/ubuntu/venv APP_DIR=/home/ubuntu/qualilab ./scripts/start-backend.sh

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
VENV="${VENV:-$HOME/venv}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
LOG_FILE="${LOG_FILE:-$APP_DIR/backend.log}"

cd "$APP_DIR"

if [[ ! -f "$VENV/bin/activate" ]]; then
  echo "Virtualenv not found at $VENV — create one with: python3 -m venv $VENV"
  exit 1
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "Installing Python dependencies..."
pip install -q -r requirements.txt

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "ERROR: Missing $APP_DIR/.env"
  echo "Copy .env.example to .env on the server"
  exit 1
fi

echo "Starting uvicorn on $HOST:$PORT (log: $LOG_FILE)"
exec uvicorn main:app --host "$HOST" --port "$PORT" >> "$LOG_FILE" 2>&1
