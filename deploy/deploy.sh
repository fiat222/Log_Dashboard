#!/bin/bash
# deploy.sh — pull new tag, roll backend+dashboard, health-check, auto-rollback on fail
# Usage: ./deploy.sh <git-sha-tag>
# Example: ./deploy.sh a1b2c3d

set -euo pipefail

TAG="${1:-latest}"
COMPOSE="docker compose"

echo "=== Deploy: TAG=$TAG ==="

# Capture currently-running tag BEFORE pulling (used for rollback)
PREVIOUS_TAG=$(
    $COMPOSE ps -q backend 2>/dev/null \
    | xargs -r docker inspect --format='{{index .Config.Image}}' \
    | cut -d: -f2
)
PREVIOUS_TAG="${PREVIOUS_TAG:-latest}"
echo "Current running tag: $PREVIOUS_TAG"

# Pull new images
echo "Pulling TAG=$TAG ..."
TAG=$TAG $COMPOSE pull backend log-dashboard backup

# Roll only custom services (leaves clickhouse/redis/postgres untouched)
echo "Bringing up TAG=$TAG ..."
TAG=$TAG $COMPOSE up -d --no-deps

# Health check (30 attempts × 2s = 60s window)
echo "Health check ..."
for i in $(seq 1 30); do
    if curl -s http://localhost:8801/logstore/api/health | jq; then
        echo "Deploy OK — TAG=$TAG live"
        exit 0
    fi
    sleep 2
done

# Rollback
echo "FAILED — rolling back to TAG=$PREVIOUS_TAG"
TAG=$PREVIOUS_TAG $COMPOSE up -d --no-deps
echo "Rolled back to $PREVIOUS_TAG"
exit 1
