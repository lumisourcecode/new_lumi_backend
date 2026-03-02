#!/usr/bin/env bash
set -euo pipefail

# Deploy backend to EC2
# Usage: cd backend && bash ./scripts/deploy-ec2.sh
# Env: PM2_APP_PREFIX (default: lumi)

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BACKEND_DIR}"
echo "Deploying backend from ${BACKEND_DIR}"

# Install deps
npm ci

# Start Postgres & Redis via Docker (if available)
if command -v docker >/dev/null 2>&1; then
  sudo docker compose up -d 2>/dev/null || sudo docker-compose up -d 2>/dev/null || docker compose up -d 2>/dev/null || true
fi

# Init DB (skip if Postgres not ready)
npm run db:init 2>/dev/null || echo "DB init skipped (ensure Postgres is running)"

# Start/restart via PM2
if pm2 describe "lumi-ride-dev-backend-gateway" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

pm2 save
echo "Backend deployed. Gateway on port 4000."
