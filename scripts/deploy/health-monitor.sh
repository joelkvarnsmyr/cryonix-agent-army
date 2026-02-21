#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../" && pwd)"
LOG_FILE="/tmp/health-monitor.log"
HEALTH_URL="http://localhost:3000/api/health"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"

# Auto-restart state
RESTART_STATE_FILE="/tmp/health-monitor-restarts"
RESTART_COOLDOWN=900  # 15 min between restart attempts
MAX_RESTARTS_PER_HOUR=3

# Load Telegram credentials from .env
TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$SCRIPT_DIR/.env" | cut -d= -f2-)"
TELEGRAM_CHAT_ID="$(grep -E '^TELEGRAM_CHAT_ID=' "$SCRIPT_DIR/.env" | cut -d= -f2-)"

send_telegram() {
  local message="$1"
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d parse_mode="Markdown" \
    -d text="${message}" >/dev/null 2>&1 || true
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
  # Keep only last 100 lines
  tail -n 100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
}

# Count restarts in the last hour and check cooldown
can_restart() {
  local now
  now=$(date +%s)
  local cutoff=$((now - 3600))

  # Create state file if missing
  touch "$RESTART_STATE_FILE"

  # Prune entries older than 1 hour
  awk -v cutoff="$cutoff" '$1 >= cutoff' "$RESTART_STATE_FILE" > "${RESTART_STATE_FILE}.tmp" \
    && mv "${RESTART_STATE_FILE}.tmp" "$RESTART_STATE_FILE"

  # Check max restarts per hour
  local count
  count=$(wc -l < "$RESTART_STATE_FILE")
  if [ "$count" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
    return 1
  fi

  # Check cooldown since last restart
  local last
  last=$(tail -n1 "$RESTART_STATE_FILE" 2>/dev/null | awk '{print $1}')
  if [ -n "$last" ] && [ $((now - last)) -lt "$RESTART_COOLDOWN" ]; then
    return 1
  fi

  return 0
}

record_restart() {
  echo "$(date +%s)" >> "$RESTART_STATE_FILE"
}

do_restart() {
  log "AUTO-RESTART: running docker compose up -d"
  docker compose -f "$COMPOSE_FILE" up -d >> "$LOG_FILE" 2>&1 || {
    log "AUTO-RESTART: docker compose failed"
    return 1
  }
  record_restart
  log "AUTO-RESTART: completed"
  return 0
}

# Curl the health endpoint
RESPONSE=$(curl -s --max-time 5 "$HEALTH_URL" 2>&1) || {
  # Health endpoint unreachable — attempt auto-restart
  if can_restart; then
    log "CRITICAL: Health endpoint unreachable — attempting auto-restart"
    if do_restart; then
      MSG="🔴 *CRITICAL* — Health endpoint unreachable
🔄 *Auto-restart triggered*
\`docker compose up -d\` executed at $(date '+%Y-%m-%d %H:%M:%S')"
    else
      MSG="🔴 *CRITICAL* — Health endpoint unreachable
⚠️ *Auto-restart FAILED*
$(date '+%Y-%m-%d %H:%M:%S')"
    fi
  else
    log "CRITICAL: Health endpoint unreachable — restart skipped (cooldown/max reached)"
    MSG="🔴 *CRITICAL* — Health endpoint unreachable
⏸️ _Auto-restart skipped (cooldown or 3/hr limit reached)_
$(date '+%Y-%m-%d %H:%M:%S')"
  fi
  send_telegram "$MSG"
  exit 1
}

# Parse status
STATUS=$(echo "$RESPONSE" | jq -r '.status // "unknown"')

if [ "$STATUS" = "healthy" ]; then
  log "OK: status=healthy"
  exit 0
fi

# Build alert for degraded/unhealthy
if [ "$STATUS" = "unhealthy" ]; then
  EMOJI="🔴"
  LABEL="UNHEALTHY"
else
  EMOJI="🟡"
  LABEL="DEGRADED"
fi

# Extract failed checks
FAILED_CHECKS=$(echo "$RESPONSE" | jq -r '
  .checks | to_entries[]
  | select(.value.status != "ok")
  | "• \(.key): \(.value.status) (\(.value.latency_ms // "N/A")ms)"
')

# Extract trading info
OPEN_POSITIONS=$(echo "$RESPONSE" | jq -r '.trading.open_positions // "N/A"')
REGIME=$(echo "$RESPONSE" | jq -r '.trading.regime // "N/A"')

# Extract all latencies
LATENCIES=$(echo "$RESPONSE" | jq -r '
  .checks | to_entries[]
  | "\(.key): \(.value.latency_ms // "N/A")ms"
' | paste -sd ", " -)

MSG="${EMOJI} *${LABEL}* — Cryonix Health Alert

*Failed checks:*
${FAILED_CHECKS:-_none parsed_}

*Latencies:* ${LATENCIES}
*Open positions:* ${OPEN_POSITIONS}
*Regime:* ${REGIME}
*Time:* $(date '+%Y-%m-%d %H:%M:%S')"

send_telegram "$MSG"
log "${LABEL}: ${FAILED_CHECKS:-no details}"
