#!/usr/bin/env sh
set -eu

export TAG="${TAG:-ci}"

docker-compose --env-file .env.example -f docker-compose.yml config >/tmp/log-dashboard-compose.yml
docker-compose --env-file edge/.env.example -f edge/docker-compose.yml config >/tmp/log-dashboard-edge-compose.yml
