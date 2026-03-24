#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${PROJECT_ROOT}/scripts/orchestrator/telegram.sh"

REPORT_BASE="${PROJECT_ROOT}/reports/master-orchestrator"
MAX_AGE_MINUTES=270  # 4.5 hours (4h cycle + 30min grace)

# Find most recent cycle directory
LATEST=$(ls -1td "${REPORT_BASE}"/2*/ 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  tg_send "🚨 WATCHDOG: Ingen orchestrator-körning hittad. Har den aldrig körts?"
  exit 1
fi

# Check age of latest directory (stat -c for GNU/Git Bash, stat -f fallback for BSD)
LATEST_EPOCH=$(stat -c %Y "$LATEST" 2>/dev/null || stat -f %m "$LATEST")
AGE_MIN=$(( ($(date +%s) - LATEST_EPOCH) / 60 ))

if [ "$AGE_MIN" -gt "$MAX_AGE_MINUTES" ]; then
  tg_send "🚨 WATCHDOG: Master Orchestrator har inte kört på ${AGE_MIN} min (max: ${MAX_AGE_MINUTES} min). Senaste: $(basename "$LATEST")"
fi
