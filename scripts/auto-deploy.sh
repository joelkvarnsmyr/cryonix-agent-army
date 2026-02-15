#!/bin/bash
# scripts/auto-deploy.sh — Pull-based auto-deploy
# Checks every minute if origin/main has new commits, deploys if so.
# Install: crontab -e → * * * * * /home/azureuser/cryonix/scripts/auto-deploy.sh

set -euo pipefail

DEPLOY_DIR="/home/azureuser/cryonix"
COMPOSE_FILE="docker-compose.prod.yml"
LOCK_FILE="/tmp/cryonix-deploy.lock"
LOG_FILE="/tmp/auto-deploy.log"

# Prevent concurrent deploys
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE") ))
  if [ "$LOCK_AGE" -gt 900 ]; then
    echo "$(date -u) STALE lock (${LOCK_AGE}s) — removing" >> "$LOG_FILE"
    rm -f "$LOCK_FILE"
  else
    exit 0
  fi
fi

cd "$DEPLOY_DIR"

# Fetch latest from origin
git fetch origin main --quiet 2>/dev/null

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

# Nothing new — exit silently
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# New commits detected — deploy!
echo "$(date -u) NEW COMMITS: $LOCAL → $REMOTE" >> "$LOG_FILE"
touch "$LOCK_FILE"

{
  echo "=== Auto-deploy started ==="
  git log --oneline "$LOCAL".."$REMOTE"

  # Stash any local uncommitted changes (prevents wiping agent work-in-progress)
  if [ -n "$(git status --porcelain)" ]; then
    echo "  Stashing local changes before deploy..."
    git stash --include-untracked
  fi

  # Pull new code
  git reset --hard origin/main

  # Rebuild all containers
  docker compose -f "$COMPOSE_FILE" up -d --build 2>&1

  # Health check
  sleep 10
  HEALTHY=true
  for svc in web engine redis postgres; do
    STATUS=$(docker inspect --format='{{.State.Status}}' "cryonix-${svc}-1" 2>/dev/null || echo "missing")
    echo "  $svc: $STATUS"
    if [ "$STATUS" != "running" ]; then
      HEALTHY=false
    fi
  done

  if [ "$HEALTHY" = true ]; then
    echo "=== Deploy SUCCESS at $(date -u) ==="
  else
    echo "=== Deploy WARNING: some containers not running ==="
    docker compose -f "$COMPOSE_FILE" ps
  fi
} >> "$LOG_FILE" 2>&1

rm -f "$LOCK_FILE"
