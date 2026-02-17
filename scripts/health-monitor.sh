#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/tmp/health-monitor.log"
HEALTH_URL="http://localhost:3000/api/health"

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

# Curl the health endpoint
RESPONSE=$(curl -s --max-time 5 "$HEALTH_URL" 2>&1) || {
  MSG="🔴 *CRITICAL* — Health endpoint unreachable
_Container may be down_
\`curl $HEALTH_URL\` failed at $(date '+%Y-%m-%d %H:%M:%S')"
  send_telegram "$MSG"
  log "CRITICAL: Health endpoint unreachable"
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
