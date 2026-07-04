#!/usr/bin/env sh
set -eu

mkdir -p reports

TEMP_ENV_CREATED=0
if [ ! -f .env ]; then
  cp .env.example .env
  TEMP_ENV_CREATED=1
fi

cleanup() {
  if [ "$TEMP_ENV_CREATED" -eq 1 ]; then
    rm -f .env
  fi
}
trap cleanup EXIT INT TERM

if command -v docker-compose >/dev/null 2>&1; then
  docker-compose --env-file .env.example -f docker-compose.yml config > reports/compose-central.yml
  docker-compose --env-file edge/.env.example -f edge/docker-compose.yml config > reports/compose-edge.yml
else
  docker compose --env-file .env.example -f docker-compose.yml config > reports/compose-central.yml
  docker compose --env-file edge/.env.example -f edge/docker-compose.yml config > reports/compose-edge.yml
fi

printf 'compose config checks passed
central=reports/compose-central.yml
edge=reports/compose-edge.yml
' > reports/compose-check.txt
