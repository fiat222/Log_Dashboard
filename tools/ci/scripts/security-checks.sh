#!/usr/bin/env sh
set -eu

mkdir -p reports
REPORT="reports/security-checks.txt"
: > "$REPORT"

if command -v gitleaks >/dev/null 2>&1; then
  echo "[gitleaks] running" | tee -a "$REPORT"
  gitleaks detect --source . --no-git --redact 2>&1 | tee -a "$REPORT"
else
  echo "[gitleaks] unavailable; skipped" | tee -a "$REPORT"
fi

if command -v trivy >/dev/null 2>&1; then
  echo "[trivy] running" | tee -a "$REPORT"
  trivy fs --severity HIGH,CRITICAL --exit-code 1 . 2>&1 | tee -a "$REPORT"
else
  echo "[trivy] unavailable; skipped" | tee -a "$REPORT"
fi
