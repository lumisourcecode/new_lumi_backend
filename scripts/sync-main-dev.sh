#!/usr/bin/env bash
# Sync main and dev branches (for LumiRide_Backend repo).
# Run from backend repo root: bash scripts/sync-main-dev.sh

set -e
cd "$(dirname "$0")/.."

echo "=== Syncing main and dev (backend) ==="
git fetch origin 2>/dev/null || true
git checkout dev 2>/dev/null || git checkout -b dev
git checkout main
git merge dev -m "Sync main with dev" 2>/dev/null || true
git checkout dev

echo ""
echo "=== Push to GitHub ==="
echo "  git push origin main && git push origin dev"
echo ""
