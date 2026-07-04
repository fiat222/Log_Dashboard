#!/usr/bin/env sh
set -eu

export OTEL_SDK_DISABLED=true

mkdir -p reports
rm -rf .venv

if command -v py >/dev/null 2>&1; then
  py -3 -m venv .venv
elif command -v python3 >/dev/null 2>&1; then
  python3 -m venv .venv
elif command -v python >/dev/null 2>&1; then
  python -m venv .venv
else
  echo 'python interpreter not found' >&2
  exit 1
fi

if [ -f .venv/Scripts/activate ]; then
  . .venv/Scripts/activate
else
  . .venv/bin/activate
fi

python -m pip install --upgrade pip
pip install -r apps/api/requirements-dev.txt
python -m pytest tests/backend --junitxml=reports/backend-pytest.xml
