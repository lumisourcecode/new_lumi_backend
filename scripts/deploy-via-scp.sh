#!/usr/bin/env bash
# Deploy backend to EC2 via SCP (no GitHub Actions)
# Usage: bash scripts/deploy-via-scp.sh
# Set: EC2_HOST, EC2_USER, EC2_KEY (path to PEM), EC2_APP_DIR (default: /var/www/lumi-ride-backend)

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BACKEND_DIR}"

EC2_HOST="${EC2_HOST:?Set EC2_HOST}"
EC2_USER="${EC2_USER:-ubuntu}"
EC2_KEY="${EC2_KEY:-$HOME/.ssh/id_rsa}"
EC2_APP_DIR="${EC2_APP_DIR:-/var/www/lumi-ride-backend}"

echo "Deploying to ${EC2_USER}@${EC2_HOST}:${EC2_APP_DIR}"

# Sync backend (rsync over SSH, excludes node_modules)
rsync -avz --delete \
  -e "ssh -i ${EC2_KEY} -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.log' \
  "${BACKEND_DIR}/" \
  "${EC2_USER}@${EC2_HOST}:${EC2_APP_DIR}/"

# Run deploy on EC2
ssh -i "${EC2_KEY}" -o StrictHostKeyChecking=accept-new "${EC2_USER}@${EC2_HOST}" "
  cd ${EC2_APP_DIR}
  bash scripts/deploy-ec2.sh
"

echo "Deploy complete."
