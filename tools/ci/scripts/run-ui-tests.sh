#!/usr/bin/env sh
set -eu

mkdir -p reports

if command -v cmd.exe >/dev/null 2>&1; then
  npm_run() {
    cmd.exe //c npm "$@"
  }

  npx_run() {
    cmd.exe //c npx "$@"
  }
elif command -v npm >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
  npm_run() {
    npm "$@"
  }

  npx_run() {
    npx "$@"
  }
else
  echo 'npm/npx not found' >&2
  exit 1
fi

if [ -f package-lock.json ]; then
  npm_run ci
else
  npm_run install
fi

PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ ! -d "$PLAYWRIGHT_CACHE" ] || [ -z "$(find "$PLAYWRIGHT_CACHE" -name chrome-headless-shell -type f 2>/dev/null)" ]; then
  npx_run playwright install chromium
fi

npm_run run test:ui
