#!/usr/bin/env bash
set -euo pipefail

# Deploy backend to EC2
# Usage: cd backend && bash ./scripts/deploy-ec2.sh
# Env: PM2_APP_PREFIX (default: lumi)

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BACKEND_DIR}"
echo "Deploying backend from ${BACKEND_DIR}"

# billing-service uses Puppeteer — downloading Chrome during npm costs ~400MB+ and often fails with ENOSPC on small EC2.
# Use system Chromium at runtime (see services/billing-service PDF engine).
export PUPPETEER_SKIP_DOWNLOAD=true

# Free disk: old Puppeteer cache + broken partial installs
rm -rf ~/.cache/puppeteer "${HOME}/.cache/puppeteer" 2>/dev/null || true
rm -rf node_modules services/*/node_modules packages/*/node_modules 2>/dev/null || true

# PDF generation needs a real browser binary when PUPPETEER_SKIP_DOWNLOAD is set
ensure_chromium_for_puppeteer() {
  if command -v chromium >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
    return 0
  fi
  echo "Installing Chromium for invoice PDFs (Puppeteer)..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser 2>/dev/null \
      || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium 2>/dev/null \
      || echo "WARNING: Could not apt-install Chromium; install it manually for PDF invoices." >&2
  fi
}
ensure_chromium_for_puppeteer

# Prefer system Chrome for PM2 children (billing-service)
for _c in chromium google-chrome-stable chromium-browser; do
  if command -v "${_c}" >/dev/null 2>&1; then
    export PUPPETEER_EXECUTABLE_PATH="$(command -v "${_c}")"
    echo "PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH}"
    break
  fi
done

# Install deps (ci is strict; fall back if lockfile lags package.json)
npm_install_or_ci() {
  if npm ci; then return 0; fi
  echo "WARNING: npm ci failed; running npm install..." >&2
  npm install
}
npm_install_or_ci

# Distribute .env to all services
if [ -f ".env" ]; then
  for service in services/*; do
    if [ -d "$service" ]; then
      cp .env "$service/.env"
      echo "Copied .env to $service"
    fi
  done
fi

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
