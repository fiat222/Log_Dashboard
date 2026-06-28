#!/usr/bin/env sh
set -eu

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ ! -d "$PLAYWRIGHT_CACHE" ] || [ -z "$(find "$PLAYWRIGHT_CACHE" -name chrome-headless-shell -type f 2>/dev/null)" ]; then
  npx playwright install chromium
fi

npm run test:ui
