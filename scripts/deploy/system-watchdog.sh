#!/usr/bin/env bash
# ============================================================================
# System Watchdog — monitors ALL trading subsystems every 15 min
# Checks: container health, trading activity, P&L, stuck positions, disk space
# Alerts via Telegram on issues, auto-restarts crashed containers
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../" && pwd)"
LOG_FILE="/tmp/system-watchdog.log"
STATE_FILE="/tmp/watchdog-state.json"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"

# Load Telegram credentials
TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2-)"
TELEGRAM_CHAT_ID="$(grep -E '^TELEGRAM_CHAT_ID=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2-)"

send_telegram() {
  [ -z "$TELEGRAM_BOT_TOKEN" ] && return
  [ -z "$TELEGRAM_CHAT_ID" ] && return
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d parse_mode="HTML" \
    -d text="$1" >/dev/null 2>&1 || true
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
  tail -n 200 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
}

ALERTS=""
add_alert() { ALERTS="${ALERTS}\n$1"; }

# ── 1. Container Health ──────────────────────────────────────────────────────

CRITICAL_CONTAINERS="cryonix-web-1 cryonix-redis-1 cryonix-postgres-1 cryonix-auto-trader-1 aktienix cryonix-engine-1"
OPTIONAL_CONTAINERS="aktienix-brain cryonix-copynix-1 cryonix-polymarket-scanner-1 solanix polynix"

for c in $CRITICAL_CONTAINERS; do
  status=$(docker inspect --format='{{.State.Status}}' "$c" 2>/dev/null || echo "missing")
  if [ "$status" != "running" ]; then
    add_alert "🔴 <b>$c</b> is $status"
    # Auto-restart critical containers
    log "RESTART: $c was $status, restarting..."
    docker compose -f "$COMPOSE_FILE" up -d "$c" >> "$LOG_FILE" 2>&1 || true
  fi
done

OPTIONAL_DOWN=""
for c in $OPTIONAL_CONTAINERS; do
  status=$(docker inspect --format='{{.State.Status}}' "$c" 2>/dev/null || echo "missing")
  if [ "$status" != "running" ]; then
    OPTIONAL_DOWN="${OPTIONAL_DOWN} $c"
  fi
done
[ -n "$OPTIONAL_DOWN" ] && add_alert "🟡 Optional down:$OPTIONAL_DOWN"

# ── 2. Cryonix Health API ────────────────────────────────────────────────────

HEALTH=$(curl -s --max-time 5 http://localhost:3000/api/health 2>/dev/null || echo '{}')
HEALTH_STATUS=$(echo "$HEALTH" | jq -r '.status // "unknown"')
HEALTHY_COUNT=$(echo "$HEALTH" | jq -r '.summary.healthy // 0')
TOTAL_COUNT=$(echo "$HEALTH" | jq -r '.summary.total // 0')
CRYONIX_POSITIONS=$(echo "$HEALTH" | jq -r '.trading.open_positions // 0')
CRYONIX_CAPITAL=$(echo "$HEALTH" | jq -r '.trading.capital // 0')
CRYONIX_PNL=$(echo "$HEALTH" | jq -r '.trading.daily_pnl // 0')
REGIME=$(echo "$HEALTH" | jq -r '.trading.regime // "unknown"')

if [ "$HEALTH_STATUS" != "healthy" ] && [ "$HEALTH_STATUS" != "unknown" ]; then
  FAILED=$(echo "$HEALTH" | jq -r '.checks | to_entries[] | select(.value.status != "ok") | .key' 2>/dev/null | tr '\n' ', ')
  add_alert "🟡 Cryonix health: $HEALTH_STATUS (failed: ${FAILED:-?})"
fi

# ── 3. Aktienix Status ───────────────────────────────────────────────────────

AKT_STATUS=$(curl -s --max-time 5 http://localhost:3000/api/aktienix/status 2>/dev/null || echo '{}')
AKT_RUNNING=$(echo "$AKT_STATUS" | jq -r '.agent.running // false')
AKT_PORTFOLIO=$(echo "$AKT_STATUS" | jq -r '.account.portfolioValue // 0')
AKT_MARKET_OPEN=$(echo "$AKT_STATUS" | jq -r '.market.isOpen // false')
AKT_PHASE=$(echo "$AKT_STATUS" | jq -r '.market.phase // "unknown"')

# Alert if aktienix not running during market hours
if [ "$AKT_MARKET_OPEN" = "true" ] && [ "$AKT_RUNNING" != "true" ]; then
  add_alert "🔴 <b>Aktienix not running during market hours!</b>"
fi

# Alert on significant portfolio drop (>3% from $100k start)
AKT_DRAWDOWN=$(echo "$AKT_PORTFOLIO" | awk '{printf "%.2f", (100000 - $1) / 100000 * 100}')
if [ "$(echo "$AKT_PORTFOLIO > 0 && $AKT_PORTFOLIO < 97000" | bc -l 2>/dev/null)" = "1" ]; then
  add_alert "🔴 Aktienix portfolio drawdown: -${AKT_DRAWDOWN}% (\$$(printf '%.0f' "$AKT_PORTFOLIO"))"
fi

# ── 4. Disk Space ────────────────────────────────────────────────────────────

DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,""); print $5}')
if [ "$DISK_PCT" -ge 90 ]; then
  add_alert "🔴 Disk ${DISK_PCT}% full — prune needed"
  docker builder prune -af > /dev/null 2>&1 || true
  docker image prune -af > /dev/null 2>&1 || true
  log "Auto-pruned Docker to free disk space"
elif [ "$DISK_PCT" -ge 80 ]; then
  add_alert "🟡 Disk ${DISK_PCT}% full"
fi

# ── 5. Redis connectivity ────────────────────────────────────────────────────

REDIS_PING=$(docker exec cryonix-redis-1 redis-cli PING 2>/dev/null || echo "FAIL")
if [ "$REDIS_PING" != "PONG" ]; then
  add_alert "🔴 Redis not responding"
fi

# ── 6. Recent trade activity (Cryonix) ────────────────────────────────────────

CRYONIX_TRADES_24H=$(docker exec cryonix-postgres-1 psql -U postgres -d cryonix -tAc \
  "SELECT COUNT(*) FROM trades WHERE timestamp > NOW() - INTERVAL '24 hours';" 2>/dev/null || echo "?")

# ── 7. Recent trade activity (Aktienix) ───────────────────────────────────────

AKT_TRADES_24H=$(docker exec cryonix-postgres-1 psql -U postgres -d cryonix -tAc \
  "SELECT COUNT(*) FROM aktienix_trades WHERE timestamp > NOW() - INTERVAL '24 hours';" 2>/dev/null || echo "?")

# ── 8. Bayesian priors count ──────────────────────────────────────────────────

BAYES_COUNT=$(docker exec cryonix-redis-1 redis-cli KEYS 'bayes:*' 2>/dev/null | wc -l || echo "0")

# ── Output ────────────────────────────────────────────────────────────────────

if [ -n "$ALERTS" ]; then
  MSG="⚠️ <b>System Watchdog Alert</b>
$(echo -e "$ALERTS")

<b>Status:</b>
Cryonix: ${HEALTHY_COUNT}/${TOTAL_COUNT} healthy | ${CRYONIX_POSITIONS} pos | \$$(printf '%.2f' "$CRYONIX_CAPITAL") | ${REGIME}
Aktienix: \$$(printf '%.0f' "$AKT_PORTFOLIO") | ${AKT_PHASE}
Trades 24h: Cryonix ${CRYONIX_TRADES_24H} | Aktienix ${AKT_TRADES_24H}
Disk: ${DISK_PCT}% | Bayes priors: ${BAYES_COUNT}
$(date '+%Y-%m-%d %H:%M:%S UTC')"

  send_telegram "$MSG"
  log "ALERT: $(echo -e "$ALERTS" | tr '\n' ' ')"
else
  log "OK: Cryonix ${HEALTHY_COUNT}/${TOTAL_COUNT} \$$(printf '%.2f' "$CRYONIX_CAPITAL") | Aktienix \$$(printf '%.0f' "$AKT_PORTFOLIO") ${AKT_PHASE} | Disk ${DISK_PCT}% | Bayes ${BAYES_COUNT}"
fi
