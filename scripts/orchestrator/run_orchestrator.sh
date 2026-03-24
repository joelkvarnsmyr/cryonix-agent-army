#!/usr/bin/env bash
set -euo pipefail

# Navigate to project root
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Directories
REPORT_BASE="reports/master-orchestrator"
COUNTER_FILE="${REPORT_BASE}/.cycle_counter"
LOG_DIR="${REPORT_BASE}/logs"
mkdir -p "$REPORT_BASE" "$LOG_DIR"

# Increment cycle counter
CYCLE=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
CYCLE=$((CYCLE + 1))
echo "$CYCLE" > "$COUNTER_FILE"

TIMESTAMP=$(date -u +"%Y-%m-%d_%H%M")
CYCLE_DIR="${REPORT_BASE}/${TIMESTAMP}"
LOG_FILE="${LOG_DIR}/cycle_${CYCLE}_${TIMESTAMP}.log"

mkdir -p "$CYCLE_DIR"

echo "========================================" | tee -a "$LOG_FILE"
echo "MASTER ORCHESTRATOR — Cykel ${CYCLE}" | tee -a "$LOG_FILE"
echo "Start: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"

# Check env vars
if [ -z "${TELEGRAM_ORCHESTRATOR_BOT_TOKEN:-}" ]; then
  echo "WARNING: TELEGRAM_ORCHESTRATOR_BOT_TOKEN not set — Telegram disabled" | tee -a "$LOG_FILE"
fi

# Run the master orchestrator via Claude Code CLI
claude -p \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --output-format text \
  --system-prompt-file MASTER_ORCHESTRATOR.md \
  "Kör cykel ${CYCLE}. Rapport-mapp: ${CYCLE_DIR}. Audit-script: scripts/orchestrator/run_agent_audit.sh" \
  >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

echo "========================================" | tee -a "$LOG_FILE"
echo "Avslutad: $(date -u '+%Y-%m-%d %H:%M:%S UTC') — Exit: ${EXIT_CODE}" | tee -a "$LOG_FILE"

# Alert on failure
if [ $EXIT_CODE -ne 0 ] && [ -n "${TELEGRAM_ORCHESTRATOR_BOT_TOKEN:-}" ]; then
  source scripts/orchestrator/telegram.sh
  tg_send "🚨 Master Orchestrator cykel ${CYCLE} MISSLYCKADES (exit ${EXIT_CODE}). Se logg: ${LOG_FILE}"
fi

exit $EXIT_CODE
