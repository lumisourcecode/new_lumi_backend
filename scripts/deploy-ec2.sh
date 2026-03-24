#!/usr/bin/env bash
set -euo pipefail

# Deploy backend to EC2
# Usage: cd backend && bash ./scripts/deploy-ec2.sh
# Env: PM2_APP_PREFIX (default: lumi)

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BACKEND_DIR}"
echo "Deploying backend from ${BACKEND_DIR}"

# One-shot cleanup for tiny EC2 volumes before apt/npm writes.
lumi_cleanup_disk() {
  echo "Disk before cleanup:"
  df -h .
  sudo journalctl --vacuum-time=2d >/dev/null 2>&1 || true
  sudo apt-get clean >/dev/null 2>&1 || true
  sudo rm -f /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/* >/dev/null 2>&1 || true
  sudo rm -f /var/lib/snapd/snaps/*.partial >/dev/null 2>&1 || true
  sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/* >/dev/null 2>&1 || true
  sudo dpkg --configure -a >/dev/null 2>&1 || true
  sudo docker system prune -af >/dev/null 2>&1 || true
  rm -rf ~/.npm/_cacache ~/.cache ~/.cache/puppeteer "${HOME}/.cache/puppeteer" >/dev/null 2>&1 || true
  echo "Disk after cleanup:"
  df -h .
}
lumi_cleanup_disk

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
  echo "WARNING: No system Chromium/Chrome found. Skipping install during deploy to avoid ENOSPC on small disks." >&2
  echo "WARNING: Invoice PDF generation may fail until Chromium is installed manually or disk is increased." >&2
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

# billing-service start script runs node dist/index.js — ensure it is compiled (do not hide errors)
if ! npm run build -w @lumi/billing-service; then
  echo "Workspace billing build failed; retrying from service directory..." >&2
  (cd services/billing-service && npm run build) || {
    echo "ERROR: billing-service build failed — PM2 will crash-loop on lumi-ride-dev-backend-billing. Fix TypeScript/build errors and redeploy." >&2
    exit 1
  }
fi
test -f services/billing-service/dist/index.js || {
  echo "ERROR: services/billing-service/dist/index.js missing after build." >&2
  exit 1
}

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
