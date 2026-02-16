#!/usr/bin/env bash
set -uo pipefail

# ================================================================
#  CRYONIX SYSTEM INTEGRATION TEST
#  60 tests across 20 groups — all READ-ONLY, no mutations
# ================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="http://localhost:3000"
RESULTS_DIR=$(mktemp -d /tmp/cryonix-test-XXXXXX)
TIMEOUT=120
CURL_TIMEOUT=10
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
START_TIME=$(date +%s)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ================================================================
#  Dependency check
# ================================================================
check_deps() {
  local missing=()
  for cmd in curl jq docker node; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}Missing dependencies: ${missing[*]}${RESET}"
    exit 1
  fi
}

# ================================================================
#  Helper functions
# ================================================================

write_result() {
  local group="$1" name="$2" status="$3" detail="${4:-}"
  echo "${group}|${name}|${status}|${detail}" >> "${RESULTS_DIR}/${group}.txt"
}

assert_http() {
  local group="$1" name="$2" url="$3" expected_status="${4:-200}" jq_expr="${5:-}" expected_val="${6:-}"
  local response http_code body

  response=$(curl -s -w "\n%{http_code}" --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null) || {
    write_result "$group" "$name" "FAIL" "curl failed (timeout or connection refused)"
    return 1
  }

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "$expected_status" ]; then
    write_result "$group" "$name" "FAIL" "HTTP $http_code (expected $expected_status)"
    return 1
  fi

  if [ -n "$jq_expr" ] && [ -n "$expected_val" ]; then
    local actual
    actual=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null)
    if [ "$actual" != "$expected_val" ]; then
      write_result "$group" "$name" "FAIL" "Expected \"$expected_val\", got \"$actual\""
      return 1
    fi
  fi

  write_result "$group" "$name" "PASS"
  return 0
}

assert_http_jq_exists() {
  local group="$1" name="$2" url="$3" jq_expr="$4"
  local response http_code body

  response=$(curl -s -w "\n%{http_code}" --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null) || {
    write_result "$group" "$name" "FAIL" "curl failed"
    return 1
  }

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    write_result "$group" "$name" "FAIL" "HTTP $http_code"
    return 1
  fi

  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null)
  if [ -z "$val" ] || [ "$val" = "null" ]; then
    write_result "$group" "$name" "FAIL" "Missing field: $jq_expr"
    return 1
  fi

  write_result "$group" "$name" "PASS"
  return 0
}

assert_http_jq_gt() {
  local group="$1" name="$2" url="$3" jq_expr="$4" min_val="$5"
  local response http_code body

  response=$(curl -s -w "\n%{http_code}" --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null) || {
    write_result "$group" "$name" "FAIL" "curl failed"
    return 1
  }

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    write_result "$group" "$name" "FAIL" "HTTP $http_code"
    return 1
  fi

  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null)
  if [ -z "$val" ] || [ "$val" = "null" ]; then
    write_result "$group" "$name" "FAIL" "Missing field: $jq_expr"
    return 1
  fi

  if ! awk "BEGIN{exit(!($val > $min_val))}"; then
    write_result "$group" "$name" "FAIL" "$jq_expr = $val (expected > $min_val)"
    return 1
  fi

  write_result "$group" "$name" "PASS"
  return 0
}

assert_docker_exec() {
  local group="$1" name="$2" container="$3" cmd="$4" expected="${5:-}"
  local output

  output=$(docker exec "$container" bash -c "$cmd" 2>/dev/null) || {
    write_result "$group" "$name" "FAIL" "docker exec failed on $container"
    return 1
  }

  if [ -n "$expected" ]; then
    if ! echo "$output" | grep -qi "$expected"; then
      write_result "$group" "$name" "FAIL" "Expected \"$expected\" in output"
      return 1
    fi
  fi

  write_result "$group" "$name" "PASS"
  return 0
}

# ================================================================
#  Test Group Functions
# ================================================================

group_01_docker_infrastructure() {
  local g="01-docker-infra"

  # Test: postgres container running
  if docker ps --format '{{.Names}}' | grep -q cryonix-postgres-1; then
    write_result "$g" "postgres_running" "PASS"
  else
    write_result "$g" "postgres_running" "FAIL" "Container not running"
  fi

  # Test: redis container running
  if docker ps --format '{{.Names}}' | grep -q cryonix-redis-1; then
    write_result "$g" "redis_running" "PASS"
  else
    write_result "$g" "redis_running" "FAIL" "Container not running"
  fi

  # Test: engine container running
  if docker ps --format '{{.Names}}' | grep -q cryonix-engine-1; then
    write_result "$g" "engine_running" "PASS"
  else
    write_result "$g" "engine_running" "FAIL" "Container not running"
  fi

  # Test: web container running
  if docker ps --format '{{.Names}}' | grep -q cryonix-web-1; then
    write_result "$g" "web_running" "PASS"
  else
    write_result "$g" "web_running" "FAIL" "Container not running"
  fi

  # Test: total container count >= 8
  local count
  count=$(docker ps --format '{{.Names}}' | grep -c cryonix-)
  if [ "$count" -ge 8 ]; then
    write_result "$g" "container_count_gte_8" "PASS"
  else
    write_result "$g" "container_count_gte_8" "FAIL" "Only $count containers (expected >= 8)"
  fi
}

group_02_health_endpoint() {
  local g="02-health-endpoint"

  assert_http "$g" "health_200" "$BASE_URL/api/health" "200"
  assert_http "$g" "health_status_healthy" "$BASE_URL/api/health" "200" ".status" "healthy"
  assert_http_jq_exists "$g" "health_has_checks" "$BASE_URL/api/health" ".checks"
}

group_03_health_subservices() {
  local g="03-health-subservices"

  assert_http "$g" "redis_check_ok" "$BASE_URL/api/health" "200" ".checks.redis.status" "ok"
  assert_http "$g" "postgres_check_ok" "$BASE_URL/api/health" "200" ".checks.postgres.status" "ok"
  assert_http_jq_exists "$g" "trading_regime" "$BASE_URL/api/health" ".trading.regime"
}

group_04_python_engine() {
  local g="04-python-engine"

  # Engine has no host port mapping in prod — access via docker exec
  assert_docker_exec "$g" "engine_root" "cryonix-engine-1" \
    "curl -s --max-time 5 http://localhost:8000/" ""

  assert_docker_exec "$g" "engine_health" "cryonix-engine-1" \
    "curl -s --max-time 5 http://localhost:8000/health" "healthy"

  assert_docker_exec "$g" "engine_tanks_status" "cryonix-engine-1" \
    "curl -s --max-time 5 http://localhost:8000/tanks/status" ""

  assert_docker_exec "$g" "engine_risk_status" "cryonix-engine-1" \
    "curl -s --max-time 5 http://localhost:8000/risk/status" ""
}

group_05_auto_trade_get() {
  local g="05-auto-trade-get"

  assert_http "$g" "auto_trade_status_active" "$BASE_URL/api/auto-trade" "200" ".status" "active"
  assert_http_jq_gt "$g" "auto_trade_capital" "$BASE_URL/api/auto-trade" ".budget.totalCapital" "0"
  assert_http_jq_exists "$g" "auto_trade_regime" "$BASE_URL/api/auto-trade" ".budget.regime"
}

group_06_signals_api() {
  local g="06-signals-api"

  assert_http "$g" "signals_list" "$BASE_URL/api/signals" "200"
  assert_http "$g" "signals_with_count" "$BASE_URL/api/signals" "200" ".success" "true"
  assert_http "$g" "signals_unexecuted" "$BASE_URL/api/signals?unexecuted=true" "200"
}

group_07_market_data() {
  local g="07-market-data"

  assert_http "$g" "market_ticker" "$BASE_URL/api/market?action=ticker&symbol=BTC/USDT" "200"
  assert_http "$g" "market_tickers" "$BASE_URL/api/market?action=tickers" "200"
  assert_http "$g" "market_ohlcv" "$BASE_URL/api/market?action=ohlcv&symbol=BTC/USDT&timeframe=1h" "200"
  assert_http "$g" "market_orderbook" "$BASE_URL/api/market?action=orderbook&symbol=BTC/USDT" "200"
}

group_08_portfolio_positions() {
  local g="08-portfolio-positions"

  assert_http "$g" "portfolio_balance" "$BASE_URL/api/portfolio" "200"
  assert_http "$g" "positions_open" "$BASE_URL/api/positions" "200"
  assert_http "$g" "positions_summary" "$BASE_URL/api/positions?summary=true" "200"
  assert_http "$g" "positions_history" "$BASE_URL/api/positions?history=true" "200"
}

group_09_chart_data() {
  local g="09-chart-data"

  assert_http "$g" "chart_candles" "$BASE_URL/api/chart-data?type=candles&symbol=BTC/USDT" "200"
  assert_http "$g" "chart_pnl" "$BASE_URL/api/chart-data?type=pnl" "200"
  assert_http "$g" "chart_pattern_perf" "$BASE_URL/api/chart-data?type=patterns" "200"
}

group_10_validation_risk() {
  local g="10-validation-risk"

  assert_http "$g" "risk_config" "$BASE_URL/api/risk" "200"
  assert_http "$g" "validate_signal_config" "$BASE_URL/api/validate-signal" "200"
  assert_http "$g" "risk_check_config" "$BASE_URL/api/risk-check" "200"
}

group_11_redis_state() {
  local g="11-redis-state"

  # PING
  local ping_result
  ping_result=$(docker exec cryonix-redis-1 redis-cli PING 2>/dev/null)
  if [ "$ping_result" = "PONG" ]; then
    write_result "$g" "redis_ping" "PASS"
  else
    write_result "$g" "redis_ping" "FAIL" "Got: $ping_result"
  fi

  # daily:state key exists
  local daily_type
  daily_type=$(docker exec cryonix-redis-1 redis-cli TYPE daily:state 2>/dev/null)
  if [ "$daily_type" != "none" ]; then
    write_result "$g" "redis_daily_state" "PASS"
  else
    write_result "$g" "redis_daily_state" "FAIL" "Key daily:state not found"
  fi

  # positions:open key exists
  local pos_type
  pos_type=$(docker exec cryonix-redis-1 redis-cli TYPE positions:open 2>/dev/null)
  if [ "$pos_type" != "none" ]; then
    write_result "$g" "redis_positions_open" "PASS"
  else
    write_result "$g" "redis_positions_open" "FAIL" "Key positions:open not found"
  fi

  # trades:pending queue
  local pending_len
  pending_len=$(docker exec cryonix-redis-1 redis-cli LLEN trades:pending 2>/dev/null)
  if [ -n "$pending_len" ]; then
    write_result "$g" "redis_trades_pending" "PASS"
  else
    write_result "$g" "redis_trades_pending" "FAIL" "Cannot read trades:pending"
  fi

  # agent status keys exist
  local agent_keys
  agent_keys=$(docker exec cryonix-redis-1 redis-cli KEYS 'agent:*:status' 2>/dev/null | head -1)
  if [ -n "$agent_keys" ]; then
    write_result "$g" "redis_agent_keys" "PASS"
  else
    # Agent keys might not exist if tanks haven't started — SKIP
    write_result "$g" "redis_agent_keys" "SKIP" "No agent:*:status keys found"
  fi
}

group_12_postgres_schema() {
  local g="12-postgres-schema"
  local pg_container="cryonix-postgres-1"

  # Connection
  local pg_result
  pg_result=$(docker exec "$pg_container" psql -U postgres -d cryonix -tAc "SELECT 1" 2>/dev/null)
  if [ "$pg_result" = "1" ]; then
    write_result "$g" "pg_connection" "PASS"
  else
    write_result "$g" "pg_connection" "FAIL" "Cannot connect to Postgres"
    return
  fi

  # Core tables exist
  local tables
  tables=$(docker exec "$pg_container" psql -U postgres -d cryonix -tAc "
    SELECT string_agg(tablename, ',') FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename IN ('trades','signals','positions','position_history','validation_history')
  " 2>/dev/null)
  local table_count
  table_count=$(echo "$tables" | tr ',' '\n' | grep -c .)
  if [ "$table_count" -ge 5 ]; then
    write_result "$g" "pg_core_tables" "PASS"
  else
    write_result "$g" "pg_core_tables" "FAIL" "Found $table_count/5 core tables: $tables"
  fi

  # Signals queryable
  local signal_query
  signal_query=$(docker exec "$pg_container" psql -U postgres -d cryonix -tAc "SELECT count(*) FROM signals LIMIT 1" 2>/dev/null)
  if [ -n "$signal_query" ]; then
    write_result "$g" "pg_signals_query" "PASS"
  else
    write_result "$g" "pg_signals_query" "FAIL" "Cannot query signals table"
  fi
}

group_13_websocket() {
  local g="13-websocket"

  # Test: connect + WELCOME message
  local ws_result
  ws_result=$(cd "$SCRIPT_DIR" && node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:3004');
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d);
        if (m.type === 'WELCOME') { console.log('PASS'); ws.close(); process.exit(0); }
      } catch(e) {}
    });
    ws.on('error', () => { console.log('FAIL'); process.exit(1); });
    setTimeout(() => { console.log('FAIL timeout'); process.exit(1); }, 5000);
  " 2>/dev/null)
  if [ "$ws_result" = "PASS" ]; then
    write_result "$g" "ws_connect_welcome" "PASS"
  else
    write_result "$g" "ws_connect_welcome" "FAIL" "Got: $ws_result"
  fi

  # Test: PING/PONG
  local ws_ping
  ws_ping=$(cd "$SCRIPT_DIR" && node -e "
    const WebSocket = require('ws');
    let done = false;
    const ws = new WebSocket('ws://localhost:3004');
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d);
        if (m.type === 'WELCOME') { ws.send(JSON.stringify({ type: 'PING' })); }
        if (m.type === 'PONG' && !done) { done = true; console.log('PASS'); ws.close(); process.exit(0); }
      } catch(e) {}
    });
    ws.on('error', () => { console.log('FAIL'); process.exit(1); });
    setTimeout(() => { console.log('FAIL timeout'); process.exit(1); }, 5000);
  " 2>/dev/null)
  if [ "$ws_ping" = "PASS" ]; then
    write_result "$g" "ws_ping_pong" "PASS"
  else
    write_result "$g" "ws_ping_pong" "FAIL" "Got: $ws_ping"
  fi

  # Test: SUBSCRIBE to room
  local ws_sub
  ws_sub=$(cd "$SCRIPT_DIR" && node -e "
    const WebSocket = require('ws');
    let done = false;
    const ws = new WebSocket('ws://localhost:3004');
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d);
        if (m.type === 'WELCOME') { ws.send(JSON.stringify({ type: 'SUBSCRIBE', room: 'dashboard' })); }
        if (m.type === 'SUBSCRIBED' && !done) { done = true; console.log('PASS'); ws.close(); process.exit(0); }
      } catch(e) {}
    });
    ws.on('error', () => { console.log('FAIL'); process.exit(1); });
    setTimeout(() => { console.log('FAIL timeout'); process.exit(1); }, 5000);
  " 2>/dev/null)
  if [ "$ws_sub" = "PASS" ]; then
    write_result "$g" "ws_subscribe_room" "PASS"
  else
    write_result "$g" "ws_subscribe_room" "FAIL" "Got: $ws_sub"
  fi
}

group_14_telegram_signals() {
  local g="14-telegram-signals"

  assert_http "$g" "telegram_signals_api" "$BASE_URL/api/telegram-signals" "200"

  # Redis key: signals:telegram:active
  local tg_type
  tg_type=$(docker exec cryonix-redis-1 redis-cli TYPE signals:telegram:active 2>/dev/null)
  if [ "$tg_type" != "none" ]; then
    write_result "$g" "redis_telegram_active" "PASS"
  else
    write_result "$g" "redis_telegram_active" "SKIP" "Key signals:telegram:active not present"
  fi
}

group_15_calibration_evolution() {
  local g="15-calibration-evolution"

  assert_http "$g" "calibration_data" "$BASE_URL/api/calibration" "200"
  assert_http "$g" "evolution_history" "$BASE_URL/api/evolution" "200"
}

group_16_grid_scanner() {
  local g="16-grid-scanner"

  assert_http "$g" "grid_config" "$BASE_URL/api/grid-config" "200"
  assert_http "$g" "scanner_history" "$BASE_URL/api/scanner-history" "200"
}

group_17_sentiment_agents() {
  local g="17-sentiment-agents"

  assert_http "$g" "x_sentiment_cache" "$BASE_URL/api/x-sentiment" "200"

  # tanks/status requires an id param; test that the endpoint responds (400 = endpoint exists)
  local tanks_resp
  tanks_resp=$(curl -s -w "\n%{http_code}" --max-time "$CURL_TIMEOUT" "$BASE_URL/api/tanks/status" 2>/dev/null)
  local tanks_code
  tanks_code=$(echo "$tanks_resp" | tail -1)
  if [ "$tanks_code" = "200" ] || [ "$tanks_code" = "400" ]; then
    write_result "$g" "tanks_status_endpoint" "PASS"
  else
    write_result "$g" "tanks_status_endpoint" "FAIL" "HTTP $tanks_code (expected 200 or 400)"
  fi
}

group_18_process_log_backtest() {
  local g="18-process-log-backtest"

  assert_http "$g" "process_log" "$BASE_URL/api/process-log" "200"
  assert_http "$g" "backtest_list" "$BASE_URL/api/backtest" "200"
}

group_19_binance_direct() {
  local g="19-binance-direct"

  # Public Binance API (no auth needed)
  local ticker_resp
  ticker_resp=$(curl -s --max-time "$CURL_TIMEOUT" "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" 2>/dev/null)
  local ticker_price
  ticker_price=$(echo "$ticker_resp" | jq -r '.price // empty' 2>/dev/null)
  if [ -n "$ticker_price" ]; then
    write_result "$g" "binance_ticker_price" "PASS"
  else
    write_result "$g" "binance_ticker_price" "FAIL" "Cannot fetch BTC price from Binance"
  fi

  local time_resp
  time_resp=$(curl -s --max-time "$CURL_TIMEOUT" "https://api.binance.com/api/v3/time" 2>/dev/null)
  local server_time
  server_time=$(echo "$time_resp" | jq -r '.serverTime // empty' 2>/dev/null)
  if [ -n "$server_time" ]; then
    write_result "$g" "binance_server_time" "PASS"
  else
    write_result "$g" "binance_server_time" "FAIL" "Cannot fetch Binance server time"
  fi
}

group_20_cron_jobs() {
  local g="20-cron-jobs"

  local crontab_content
  crontab_content=$(crontab -l 2>/dev/null)

  if echo "$crontab_content" | grep -q "health-monitor.sh"; then
    write_result "$g" "cron_health_monitor" "PASS"
  else
    write_result "$g" "cron_health_monitor" "FAIL" "health-monitor.sh not in crontab"
  fi

  if echo "$crontab_content" | grep -q "auto-deploy.sh"; then
    write_result "$g" "cron_auto_deploy" "PASS"
  else
    write_result "$g" "cron_auto_deploy" "FAIL" "auto-deploy.sh not in crontab"
  fi
}

# ================================================================
#  Main execution
# ================================================================

main() {
  check_deps

  echo -e "${BOLD}================================================================${RESET}"
  echo -e "${BOLD}  CRYONIX SYSTEM INTEGRATION TEST${RESET}"
  echo -e "${DIM}  $(date -u '+%Y-%m-%d %H:%M:%S UTC')${RESET}"
  echo -e "${BOLD}================================================================${RESET}"
  echo ""

  # Launch all 20 groups in parallel
  group_01_docker_infrastructure &
  group_02_health_endpoint &
  group_03_health_subservices &
  group_04_python_engine &
  group_05_auto_trade_get &
  group_06_signals_api &
  group_07_market_data &
  group_08_portfolio_positions &
  group_09_chart_data &
  group_10_validation_risk &
  group_11_redis_state &
  group_12_postgres_schema &
  group_13_websocket &
  group_14_telegram_signals &
  group_15_calibration_evolution &
  group_16_grid_scanner &
  group_17_sentiment_agents &
  group_18_process_log_backtest &
  group_19_binance_direct &
  group_20_cron_jobs &

  # Wait for all with timeout
  local pids
  pids=$(jobs -p)
  local deadline=$(($(date +%s) + TIMEOUT))

  for pid in $pids; do
    local remaining=$((deadline - $(date +%s)))
    if [ "$remaining" -le 0 ]; then
      echo -e "${YELLOW}Timeout reached, killing remaining tests...${RESET}"
      kill $pids 2>/dev/null || true
      break
    fi
    wait "$pid" 2>/dev/null || true
  done

  # ================================================================
  #  Aggregate results
  # ================================================================

  local group_names=(
    "01-docker-infra:01 Docker Infrastructure"
    "02-health-endpoint:02 Health Endpoint"
    "03-health-subservices:03 Health Sub-services"
    "04-python-engine:04 Python Engine"
    "05-auto-trade-get:05 Auto-Trade GET"
    "06-signals-api:06 Signals API"
    "07-market-data:07 Market Data"
    "08-portfolio-positions:08 Portfolio & Positions"
    "09-chart-data:09 Chart Data"
    "10-validation-risk:10 Validation & Risk"
    "11-redis-state:11 Redis State"
    "12-postgres-schema:12 Postgres Schema"
    "13-websocket:13 WebSocket Server"
    "14-telegram-signals:14 Telegram Signals"
    "15-calibration-evolution:15 Calibration & Evolution"
    "16-grid-scanner:16 Grid & Scanner"
    "17-sentiment-agents:17 Sentiment & Agents"
    "18-process-log-backtest:18 Process Log & Backtest"
    "19-binance-direct:19 Binance Direct"
    "20-cron-jobs:20 Cron Jobs"
  )

  local total_pass=0 total_fail=0 total_skip=0 total_tests=0
  local failures=()

  echo ""
  printf " ${BOLD}%-30s %5s %5s %5s %5s${RESET}\n" "Group" "Tests" "Pass" "Fail" "Skip"
  echo -e " ${DIM}$(printf '─%.0s' {1..55})${RESET}"

  for entry in "${group_names[@]}"; do
    local file_key="${entry%%:*}"
    local label="${entry##*:}"
    local file="${RESULTS_DIR}/${file_key}.txt"

    local g_pass=0 g_fail=0 g_skip=0 g_total=0

    if [ -f "$file" ]; then
      while IFS='|' read -r _group name status detail; do
        g_total=$((g_total + 1))
        case "$status" in
          PASS) g_pass=$((g_pass + 1)) ;;
          FAIL)
            g_fail=$((g_fail + 1))
            failures+=("${name}: ${detail}")
            ;;
          SKIP) g_skip=$((g_skip + 1)) ;;
        esac
      done < "$file"
    fi

    total_pass=$((total_pass + g_pass))
    total_fail=$((total_fail + g_fail))
    total_skip=$((total_skip + g_skip))
    total_tests=$((total_tests + g_total))

    local status_icon
    if [ "$g_fail" -gt 0 ]; then
      status_icon="${RED}✗${RESET}"
    elif [ "$g_skip" -gt 0 ]; then
      status_icon="${YELLOW}~${RESET}"
    else
      status_icon="${GREEN}✓${RESET}"
    fi

    printf " %-30s %5d %5d %5d %5d  %b\n" "$label" "$g_total" "$g_pass" "$g_fail" "$g_skip" "$status_icon"
  done

  echo -e " ${DIM}$(printf '─%.0s' {1..55})${RESET}"

  local total_color="$GREEN"
  if [ "$total_fail" -gt 0 ]; then
    total_color="$RED"
  fi

  printf " ${BOLD}%-30s %5d %5d %5d %5d${RESET}\n" "TOTAL" "$total_tests" "$total_pass" "$total_fail" "$total_skip"

  # Print failures
  if [ ${#failures[@]} -gt 0 ]; then
    echo ""
    echo -e " ${RED}${BOLD}FAILURES:${RESET}"
    for f in "${failures[@]}"; do
      echo -e " ${RED}✗${RESET} $f"
    done
  fi

  local elapsed=$(( $(date +%s) - START_TIME ))
  echo ""
  echo -e "${BOLD}================================================================${RESET}"
  echo -e " ${DIM}Completed in ${elapsed}s | Results: ${RESULTS_DIR}${RESET}"
  echo -e "${BOLD}================================================================${RESET}"

  # Cleanup
  rm -rf "$RESULTS_DIR"

  if [ "$total_fail" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

main "$@"
