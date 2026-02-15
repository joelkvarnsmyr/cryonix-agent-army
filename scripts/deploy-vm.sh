#!/bin/bash
# scripts/deploy-vm.sh — Runs ON the VM to pull latest code and rebuild containers
# Called by GitHub Actions on push to main

set -euo pipefail

DEPLOY_DIR="/home/azureuser/cryonix"
COMPOSE_FILE="docker-compose.prod.yml"
LOG_FILE="/tmp/deploy-$(date +%Y%m%d-%H%M%S).log"

echo "=== Deploy started at $(date -u) ===" | tee "$LOG_FILE"

cd "$DEPLOY_DIR"

# Pull latest code
echo "[1/4] Pulling latest from origin/main..." | tee -a "$LOG_FILE"
git fetch origin main 2>&1 | tee -a "$LOG_FILE"
git reset --hard origin/main 2>&1 | tee -a "$LOG_FILE"

# Show what changed
echo "[2/4] Changes:" | tee -a "$LOG_FILE"
git log --oneline -5 2>&1 | tee -a "$LOG_FILE"

# Rebuild and restart containers
echo "[3/4] Rebuilding Docker containers..." | tee -a "$LOG_FILE"
docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE"

# Wait for containers to stabilize
sleep 10

# Health check
echo "[4/4] Health check..." | tee -a "$LOG_FILE"
HEALTHY=true
for svc in web engine redis postgres; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "cryonix-${svc}-1" 2>/dev/null || echo "missing")
  echo "  $svc: $STATUS" | tee -a "$LOG_FILE"
  if [ "$STATUS" != "running" ]; then
    HEALTHY=false
  fi
done

if [ "$HEALTHY" = true ]; then
  echo "=== Deploy SUCCESS at $(date -u) ===" | tee -a "$LOG_FILE"
  exit 0
else
  echo "=== Deploy WARNING: some containers not running ===" | tee -a "$LOG_FILE"
  docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"
  exit 1
fi
