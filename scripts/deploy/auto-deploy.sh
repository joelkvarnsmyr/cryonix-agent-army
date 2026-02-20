#!/bin/bash
# scripts/auto-deploy.sh — Safe pull-based auto-deploy
# Runs every minute via cron. Skips if someone is actively working on the VM.
# Install: crontab -e → * * * * * /home/azureuser/cryonix/scripts/auto-deploy.sh

set -euo pipefail

DEPLOY_DIR="/home/azureuser/cryonix"
COMPOSE_FILE="docker-compose.prod.yml"
DEPLOY_LOCK="/tmp/cryonix-deploy.lock"
WORK_LOCK="/tmp/cryonix-work.lock"
LOG_FILE="/tmp/auto-deploy.log"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; }

send_telegram() {
  local token chat_id
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2-)" || return 0
  chat_id="$(grep -E '^TELEGRAM_CHAT_ID=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2-)" || return 0
  [ -z "$token" ] || [ -z "$chat_id" ] && return 0
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d chat_id="${chat_id}" \
    -d parse_mode="Markdown" \
    -d text="$1" >/dev/null 2>&1 || true
}

# --- Layer 1: Respect active work sessions ---
if [ -f "$WORK_LOCK" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$WORK_LOCK") ))
  if [ "$LOCK_AGE" -gt 7200 ]; then
    log "STALE work lock (${LOCK_AGE}s) — removing"
    rm -f "$WORK_LOCK"
  else
    # Active session — skip silently
    exit 0
  fi
fi

# --- Prevent concurrent deploys ---
if [ -f "$DEPLOY_LOCK" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$DEPLOY_LOCK") ))
  if [ "$LOCK_AGE" -gt 900 ]; then
    log "STALE deploy lock (${LOCK_AGE}s) — removing"
    rm -f "$DEPLOY_LOCK"
  else
    exit 0
  fi
fi

cd "$DEPLOY_DIR"

# Fetch latest from origin
git fetch origin main --quiet 2>/dev/null || { log "WARN: git fetch failed"; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

# Nothing new — exit silently
[ "$LOCAL" = "$REMOTE" ] && exit 0

# New commits detected — deploy!
log "NEW COMMITS: ${LOCAL:0:7} → ${REMOTE:0:7}"
touch "$DEPLOY_LOCK"

cleanup() { rm -f "$DEPLOY_LOCK"; }
trap cleanup EXIT

{
  echo "=== Auto-deploy started ==="
  git log --oneline "$LOCAL".."$REMOTE"

  # Stash any local uncommitted changes
  if [ -n "$(git status --porcelain)" ]; then
    echo "  Stashing local changes..."
    git stash --include-untracked
  fi

  # --- Layer 2: Safe pull (no force) ---
  if ! git pull --ff-only origin main 2>&1; then
    MSG="*Auto-Deploy BLOCKED*
Cannot fast-forward. Manual intervention needed.
Local: \`${LOCAL:0:7}\`
Remote: \`${REMOTE:0:7}\`"
    send_telegram "$MSG"
    log "BLOCKED: cannot fast-forward, manual intervention needed"
    echo "=== Deploy BLOCKED at $(date -u) ==="
    exit 1
  fi

  # Restore baseline freeze if lock file exists (survives git pulls)
  if [ -f "$DEPLOY_DIR/.baseline-frozen" ]; then
    sed -i 's/^frozen = false/frozen = true/' cryonix.toml
    echo "  Restored baseline freeze flag in cryonix.toml"
  fi

  # Rebuild containers
  docker compose -f "$COMPOSE_FILE" up -d --build 2>&1

  # --- Layer 3: Health check + automatic rollback ---
  echo "  Waiting 30s for containers to stabilize..."
  sleep 30

  HEALTHY=true
  for svc in web engine redis postgres; do
    STATUS=$(docker inspect --format='{{.State.Status}}' "cryonix-${svc}-1" 2>/dev/null || echo "missing")
    echo "  $svc: $STATUS"
    [ "$STATUS" != "running" ] && HEALTHY=false
  done

  if [ "$HEALTHY" = true ]; then
    log "SUCCESS: deployed ${REMOTE:0:7}"
    echo "=== Deploy SUCCESS at $(date -u) ==="
  else
    log "ROLLBACK: health check failed, reverting to ${LOCAL:0:7}"
    echo "=== ROLLING BACK ==="
    git reset --hard "$LOCAL"
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1
    sleep 15

    MSG="*Auto-Deploy ROLLED BACK*
Health check failed after deploying \`${REMOTE:0:7}\`.
Reverted to \`${LOCAL:0:7}\`.
Check logs: \`tail -50 /tmp/auto-deploy.log\`"
    send_telegram "$MSG"
    echo "=== Rollback complete at $(date -u) ==="
  fi
} >> "$LOG_FILE" 2>&1
