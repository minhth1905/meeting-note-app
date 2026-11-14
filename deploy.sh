#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Pulling latest code"
git pull --ff-only origin main

echo "==> Building and restarting services"
docker compose up -d --build --remove-orphans

echo "==> Service status"
docker compose ps

echo "==> Deployment complete"
