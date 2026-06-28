#!/usr/bin/env sh
set -eu

export OTEL_SDK_DISABLED=true

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install -r backend/requirements-dev.txt
mkdir -p reports
python -m pytest tests/backend --junitxml=reports/backend-pytest.xml
