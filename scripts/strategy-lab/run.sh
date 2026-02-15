#!/bin/bash
# Strategy Lab: Run calibration + morning report
# Intended to run daily at 06:00 UTC (after overnight trading)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs/strategy-lab"
DATE=$(date -u +%Y-%m-%d)

mkdir -p "$LOG_DIR"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Strategy Lab starting..."

# Step 1: Run calibration (updates Redis)
echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Running calibration..."
python3 "$DIR/calibrate.py" --days 30 --min-trades 2 2>&1 | tee "$LOG_DIR/calibration-$DATE.log"

# Step 2: Run morning report
echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Generating morning report..."
python3 "$DIR/morning_report.py" --hours 24 --save "$LOG_DIR/report-$DATE.txt" 2>&1 | tee -a "$LOG_DIR/report-$DATE.log"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Strategy Lab complete."
echo "Report: $LOG_DIR/report-$DATE.txt"
