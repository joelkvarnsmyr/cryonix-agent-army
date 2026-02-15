#!/bin/bash
# Run calibration + X sentiment scan
# Triggered by cron every 6 hours and at startup

cd "$(dirname "$0")/.." || exit 1

BASE_URL="${API_BASE_URL:-https://cryonix.kvarnsmyr.se}"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Running calibration..."
curl -s -X POST "$BASE_URL/api/calibration" | head -c 500
echo ""

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Running X sentiment scan..."
curl -s -X POST "$BASE_URL/api/x-sentiment" | head -c 500
echo ""

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Done."
