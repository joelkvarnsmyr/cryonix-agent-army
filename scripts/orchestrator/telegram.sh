#!/usr/bin/env bash
# Telegram helper for Master Orchestrator
# Usage: source scripts/orchestrator/telegram.sh

tg_send() {
  local message="$1"
  local parse_mode="${2:-Markdown}"
  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_ORCHESTRATOR_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ORCHESTRATOR_CHAT_ID}" \
    -d "parse_mode=${parse_mode}" \
    --data-urlencode "text=${message}" \
    > /dev/null 2>&1
}

tg_poll_for_reply() {
  local keyword="$1"        # e.g. "VETO" or "JA"
  local timeout_sec="${2:-900}"  # default 15 min
  local end_time=$(($(date +%s) + timeout_sec))

  # Get current update_id to only check new messages
  local offset
  offset=$(curl -s "https://api.telegram.org/bot${TELEGRAM_ORCHESTRATOR_BOT_TOKEN}/getUpdates?offset=-1&limit=1" \
    | grep -o '"update_id":[0-9]*' | head -1 | cut -d: -f2)
  offset=$((offset + 1))

  while [ "$(date +%s)" -lt "$end_time" ]; do
    local response
    response=$(curl -s "https://api.telegram.org/bot${TELEGRAM_ORCHESTRATOR_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30")

    # Extract only "text" field values from the correct chat, match keyword
    local texts
    texts=$(echo "$response" | grep -o '"text":"[^"]*"' | cut -d'"' -f4)
    if echo "$texts" | grep -qiw "$keyword"; then
      echo "FOUND"
      return 0
    fi

    sleep 10
  done

  echo "TIMEOUT"
  return 1
}
