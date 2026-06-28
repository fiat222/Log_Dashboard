#!/usr/bin/env sh
set -eu

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --no-git --redact
else
  echo "gitleaks not installed; skipping secret scan"
fi

if command -v trivy >/dev/null 2>&1; then
  trivy fs --severity HIGH,CRITICAL --exit-code 1 .
else
  echo "trivy not installed; skipping filesystem scan"
fi

