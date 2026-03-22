#!/bin/bash
# scripts/deploy/safe-deploy.sh — Mutex-protected deploy for multi-agent environments
#
# Usage:
#   ./scripts/deploy/safe-deploy.sh [service...]
#   ./scripts/deploy/safe-deploy.sh huntrix          # Build only huntrix
#   ./scripts/deploy/safe-deploy.sh huntrix psinix   # Build huntrix + psinix
#   ./scripts/deploy/safe-deploy.sh                  # Code push only, no build
#
# How it works:
#   1. Takes a flock on VM (~/.deploy.lock) — only one deploy at a time
#   2. Pushes code via git archive
#   3. Builds requested services sequentially
#   4. Other agents calling safe-deploy.sh will WAIT (up to 10min) for the lock
#
# Install on VM (one-time):
#   ssh azureuser@openclaw-vm "sudo apt-get install -y util-linux"  # for flock

set -euo pipefail

VM_USER="azureuser"
VM_HOST="openclaw-vm"
REMOTE_DIR="~/cryonix"
LOCK_FILE="/tmp/cryonix-deploy.lock"
LOCK_TIMEOUT=600  # 10 minutes max wait

SERVICES=("$@")

echo "[deploy] Acquiring deploy lock on $VM_HOST..."

# Push code (outside lock — tar extract is atomic enough)
cd "$(git rev-parse --show-toplevel)"
git archive --format=tar HEAD | ssh "$VM_USER@$VM_HOST" "cd $REMOTE_DIR && tar xf -"

if [ ${#SERVICES[@]} -eq 0 ]; then
    echo "[deploy] Code pushed. No services to build."
    exit 0
fi

# Build with flock on VM — ensures only one build at a time
SERVICE_LIST="${SERVICES[*]}"
ssh "$VM_USER@$VM_HOST" bash -s <<REMOTE_SCRIPT
set -euo pipefail
exec 200>$LOCK_FILE
if ! flock -w $LOCK_TIMEOUT 200; then
    echo "[deploy] ERROR: Could not acquire lock after ${LOCK_TIMEOUT}s — another deploy is stuck?"
    exit 1
fi
echo "[deploy] Lock acquired. Building: $SERVICE_LIST"
cd $REMOTE_DIR
docker compose -f docker-compose.prod.yml up -d --build $SERVICE_LIST
echo "[deploy] Build complete. Releasing lock."
REMOTE_SCRIPT

echo "[deploy] Done: $SERVICE_LIST"
