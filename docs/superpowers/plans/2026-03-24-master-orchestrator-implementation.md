# Master Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the infrastructure to run MASTER_ORCHESTRATOR.md as an autonomous 4-hourly Claude Code CLI process on Windows, with parallel agent audits, Telegram reporting, and Windows Task Scheduler automation.

**Architecture:** A bash entry-point script (`run_orchestrator.sh`) invoked by a `.bat` wrapper via Windows Task Scheduler every 4 hours. The script calls `claude -p` with the master prompt. A separate `run_agent_audit.sh` handles parallel sub-agent dispatch. A watchdog script monitors liveness.

**Tech Stack:** Bash, Windows Task Scheduler, Claude Code CLI (`claude -p`), Telegram Bot API, SSH

**Spec:** `docs/superpowers/specs/2026-03-24-master-orchestrator-design.md`
**Prompt:** `MASTER_ORCHESTRATOR.md` (already written and reviewed)

---

## File Structure

```
scripts/orchestrator/
├── run_orchestrator.sh        # Main entry point — invokes claude -p with master prompt
├── run_orchestrator.bat       # Windows wrapper for Task Scheduler
├── run_agent_audit.sh         # Parallel agent audit dispatcher (Fas 3)
├── telegram.sh                # Telegram helper (send message, poll for reply)
├── watchdog.sh                # Liveness monitor — alerts if orchestrator hasn't run
├── watchdog.bat               # Windows wrapper for watchdog
├── setup_task_scheduler.bat   # One-time: creates 3 Task Scheduler jobs (4h + 30min + logon)
└── env.example                # Template for required env vars

reports/master-orchestrator/
├── .cycle_counter             # Persistent cycle number
└── pending_red_actions.json   # RED tier actions awaiting approval
```

**Prerequisites:**
- Claude Code CLI (`claude`) on PATH (`npm i -g @anthropic-ai/claude-code`)
- SSH key to VM passphrase-less or ssh-agent loaded (for unattended execution)
- Git Bash installed (`C:\Program Files\Git\bin\bash.exe`)

---

### Task 1: Create directory structure and env template

**Files:**
- Create: `scripts/orchestrator/env.example`
- Create: `reports/master-orchestrator/.gitkeep`
- Create: `reports/master-orchestrator/pending_red_actions.json`
- Create: `reports/master-orchestrator/.cycle_counter`

- [ ] **Step 1: Create directories**

```bash
mkdir -p scripts/orchestrator
mkdir -p reports/master-orchestrator
```

- [ ] **Step 2: Create env.example**

```bash
cat > scripts/orchestrator/env.example << 'EOF'
# Required environment variables for Master Orchestrator
# Copy to your shell profile or set in Windows environment

TELEGRAM_ORCHESTRATOR_BOT_TOKEN=your_bot_token_here
TELEGRAM_ORCHESTRATOR_CHAT_ID=your_chat_id_here
EOF
```

- [ ] **Step 3: Create initial state files**

```bash
echo "0" > reports/master-orchestrator/.cycle_counter
echo "[]" > reports/master-orchestrator/pending_red_actions.json
touch reports/master-orchestrator/.gitkeep
```

- [ ] **Step 4: Add reports dir to .gitignore (keep structure, ignore output)**

Append to `.gitignore`:
```
reports/master-orchestrator/*/
!reports/master-orchestrator/.gitkeep
!reports/master-orchestrator/.cycle_counter
!reports/master-orchestrator/pending_red_actions.json
```

- [ ] **Step 5: Commit**

```bash
git add scripts/orchestrator/env.example reports/master-orchestrator/ .gitignore
git commit -m "feat(orchestrator): scaffold directory structure and env template"
```

---

### Task 2: Create Telegram helper script

**Files:**
- Create: `scripts/orchestrator/telegram.sh`

This is a reusable utility sourced by other scripts. Provides `tg_send` and `tg_poll_for_reply`.

- [ ] **Step 1: Write telegram.sh**

```bash
cat > scripts/orchestrator/telegram.sh << 'TGEOF'
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

    if echo "$response" | grep -qi "$keyword"; then
      echo "FOUND"
      return 0
    fi

    sleep 10
  done

  echo "TIMEOUT"
  return 1
}
TGEOF
chmod +x scripts/orchestrator/telegram.sh
```

- [ ] **Step 2: Test that the file is syntactically valid**

```bash
bash -n scripts/orchestrator/telegram.sh
```
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add scripts/orchestrator/telegram.sh
git commit -m "feat(orchestrator): add Telegram send/poll helper"
```

---

### Task 3: Create parallel agent audit script

**Files:**
- Create: `scripts/orchestrator/run_agent_audit.sh`

This script is called by the master orchestrator (via `claude -p` Bash tool) during Fas 3. It takes a report directory and collected data file, then runs 5 sequential batches of 2 parallel `claude -p` audits.

- [ ] **Step 1: Write run_agent_audit.sh**

```bash
cat > scripts/orchestrator/run_agent_audit.sh << 'AUDITEOF'
#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${1:?Usage: run_agent_audit.sh <report_dir> <data_file>}"
DATA_FILE="${2:?Usage: run_agent_audit.sh <report_dir> <data_file>}"

if [ ! -f "$DATA_FILE" ]; then
  echo "ERROR: Data file not found: $DATA_FILE"
  exit 1
fi

mkdir -p "$REPORT_DIR"

# Agent definitions: name|description
AGENTS=(
  "core|Krypto Spot via Binance. Config: cryonix.toml."
  "aktienix|US-aktier via Alpaca. Config: aktienix.toml."
  "solanix|Solana DEX via Jupiter/Helius. Config: solanix.toml."
  "copynix|Solana copy-trading. Config: copynix.toml."
  "huntrix|Krypto pump-and-dump detection. Config: huntrix.toml."
  "polynix|Polymarket binary options. Config: polynix.toml."
  "psinix|Kuramoto phase convergence. Config: psinix.toml."
  "apex|Meta-confluence orchestrator. Config: apex.toml."
  "predatorhunter|Front-running detection. Config: predatorhunter.toml."
  "alphanix|Multi-asset krypto+aktier. Config: alphanix.toml."
)

# Batches: indices into AGENTS array (2 per batch, sequential batches)
BATCHES=("0 1" "2 3" "4 5" "6 7" "8 9")

DATA=$(cat "$DATA_FILE")

run_audit() {
  local name="$1"
  local desc="$2"
  local outfile="${REPORT_DIR}/${name}_audit.md"

  claude -p \
    --dangerously-skip-permissions \
    --max-turns 15 \
    --output-format text \
    "Du är auditor för agent '${name}' i Cryonix Agent Army. ${desc}

Besvara EXAKT:
1. KPI:er: Win rate, PnL, Profit Factor, avg holding, fee-ratio
2. FÖRLUSTER: Rotorsak per förlorande trade (pattern, timing, regime, SL)
3. VINSTER: Vad funkar? Bästa patterns, tider, symboler
4. REKOMMENDATIONER (max 5, prioritera profit-impact):
   - TOML-ändringar med exakta värden
   - Kapitalomfördelning
   - Filter att lägga till/ta bort

Om ingen data finns för denna agent, rapportera 'Ingen data — 0 trades senaste 48h.'

DATA:
${DATA}" > "$outfile" 2>&1

  echo "  Done: ${name}"
}

echo "Starting agent audit — ${#AGENTS[@]} agents in ${#BATCHES[@]} batches"

BATCH_NUM=0
for batch in "${BATCHES[@]}"; do
  BATCH_NUM=$((BATCH_NUM + 1))
  echo "Batch ${BATCH_NUM}/${#BATCHES[@]}..."

  PIDS=()
  for idx in $batch; do
    IFS='|' read -r name desc <<< "${AGENTS[$idx]}"
    run_audit "$name" "$desc" &
    PIDS+=($!)
  done

  # Wait for batch to complete
  for pid in "${PIDS[@]}"; do
    wait "$pid" || true
  done
done

echo "All audits complete. Reports in: ${REPORT_DIR}"
AUDITEOF
chmod +x scripts/orchestrator/run_agent_audit.sh
```

- [ ] **Step 2: Verify syntax**

```bash
bash -n scripts/orchestrator/run_agent_audit.sh
```
Expected: no output

- [ ] **Step 3: Commit**

```bash
git add scripts/orchestrator/run_agent_audit.sh
git commit -m "feat(orchestrator): add parallel agent audit script (5 batches x 2 agents)"
```

---

### Task 4: Create main orchestrator entry script

**Files:**
- Create: `scripts/orchestrator/run_orchestrator.sh`

This is the main entry point. It increments the cycle counter, checks catch-up, and invokes `claude -p` with the MASTER_ORCHESTRATOR.md system prompt.

- [ ] **Step 1: Write run_orchestrator.sh**

```bash
cat > scripts/orchestrator/run_orchestrator.sh << 'ORCHEOF'
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
ORCHEOF
chmod +x scripts/orchestrator/run_orchestrator.sh
```

- [ ] **Step 2: Verify syntax**

```bash
bash -n scripts/orchestrator/run_orchestrator.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/orchestrator/run_orchestrator.sh
git commit -m "feat(orchestrator): add main entry script with cycle counter and logging"
```

---

### Task 5: Create Windows batch wrapper

**Files:**
- Create: `scripts/orchestrator/run_orchestrator.bat`

Windows Task Scheduler needs a `.bat` file. This wrapper calls Git Bash to run the shell script.

- [ ] **Step 1: Write run_orchestrator.bat**

```bat
@echo off
REM Master Orchestrator — Windows Task Scheduler wrapper
REM Runs the orchestrator via Git Bash

set PROJECT_ROOT=C:\Projects\Code\Crypto\cryonix-agent-army

REM Use Git Bash to execute the shell script
"C:\Program Files\Git\bin\bash.exe" -l -c "cd /c/Projects/Code/Crypto/cryonix-agent-army && bash scripts/orchestrator/run_orchestrator.sh"
```

- [ ] **Step 2: Commit**

```bash
git add scripts/orchestrator/run_orchestrator.bat
git commit -m "feat(orchestrator): add Windows Task Scheduler .bat wrapper"
```

---

### Task 6: Create watchdog script + bat wrapper

**Files:**
- Create: `scripts/orchestrator/watchdog.sh`
- Create: `scripts/orchestrator/watchdog.bat`

Checks if the orchestrator has run within the expected window. Run separately via Task Scheduler every 30 min.

- [ ] **Step 1: Write watchdog.sh**

```bash
cat > scripts/orchestrator/watchdog.sh << 'WDEOF'
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

# Check age of latest directory
LATEST_EPOCH=$(stat -c %Y "$LATEST" 2>/dev/null || stat -f %m "$LATEST")
AGE_MIN=$(( ($(date +%s) - LATEST_EPOCH) / 60 ))

if [ "$AGE_MIN" -gt "$MAX_AGE_MINUTES" ]; then
  tg_send "🚨 WATCHDOG: Master Orchestrator har inte kört på ${AGE_MIN} min (max: ${MAX_AGE_MINUTES} min). Senaste: $(basename "$LATEST")"
fi
WDEOF
chmod +x scripts/orchestrator/watchdog.sh
```

- [ ] **Step 2: Verify syntax**

```bash
bash -n scripts/orchestrator/watchdog.sh
```

- [ ] **Step 3: Write watchdog.bat wrapper**

```bat
@echo off
REM Watchdog — Windows Task Scheduler wrapper
"C:\Program Files\Git\bin\bash.exe" -l -c "cd /c/Projects/Code/Crypto/cryonix-agent-army && bash scripts/orchestrator/watchdog.sh"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/orchestrator/watchdog.sh scripts/orchestrator/watchdog.bat
git commit -m "feat(orchestrator): add watchdog liveness monitor with .bat wrapper"
```

---

### Task 7: Create Task Scheduler setup script

**Files:**
- Create: `scripts/orchestrator/setup_task_scheduler.bat`

One-time setup script that creates two Windows Task Scheduler tasks:
1. Master Orchestrator — every 4 hours
2. Watchdog — every 30 minutes

- [ ] **Step 1: Write setup_task_scheduler.bat**

```bat
@echo off
REM Setup Windows Task Scheduler for Master Orchestrator
REM Run as Administrator

set PROJECT_ROOT=C:\Projects\Code\Crypto\cryonix-agent-army

echo Creating Master Orchestrator task (every 4 hours)...
schtasks /Create /TN "CryonixMasterOrchestrator" /TR "%PROJECT_ROOT%\scripts\orchestrator\run_orchestrator.bat" /SC HOURLY /MO 4 /ST 00:00 /F /RL HIGHEST

echo Creating Watchdog task (every 30 minutes)...
schtasks /Create /TN "CryonixOrchestratorWatchdog" /TR "%PROJECT_ROOT%\scripts\orchestrator\watchdog.bat" /SC MINUTE /MO 30 /F /RL HIGHEST

echo Creating catch-up task (run at logon after PC restart)...
schtasks /Create /TN "CryonixOrchestratorCatchup" /TR "%PROJECT_ROOT%\scripts\orchestrator\run_orchestrator.bat" /SC ONLOGON /F /RL HIGHEST /DELAY 0002:00

echo.
echo Done! Verify with:
echo   schtasks /Query /TN "CryonixMasterOrchestrator"
echo   schtasks /Query /TN "CryonixOrchestratorWatchdog"
echo.
echo IMPORTANT: Set these environment variables before first run:
echo   TELEGRAM_ORCHESTRATOR_BOT_TOKEN
echo   TELEGRAM_ORCHESTRATOR_CHAT_ID
echo.
echo To set them system-wide:
echo   setx TELEGRAM_ORCHESTRATOR_BOT_TOKEN "your_token"
echo   setx TELEGRAM_ORCHESTRATOR_CHAT_ID "your_chat_id"
pause
```

- [ ] **Step 2: Commit**

```bash
git add scripts/orchestrator/setup_task_scheduler.bat
git commit -m "feat(orchestrator): add Task Scheduler setup script (4h cycle + 30min watchdog)"
```

---

### Task 8: Get Telegram chat ID and set environment variables

**Files:** None (environment setup)

The bot token exists but we need the chat_id. This is a manual step.

- [ ] **Step 1: Send a message to @cryptoOrchestrator_bot on Telegram**

Open Telegram, find @cryptoOrchestrator_bot, send any message (e.g. "hello").

- [ ] **Step 2: Get chat_id from Telegram API**

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_ORCHESTRATOR_BOT_TOKEN}/getUpdates" | python3 -m json.tool
```

Look for `"chat":{"id":XXXXXXX}` — that's the chat_id.

- [ ] **Step 3: Set environment variables (system-wide)**

Run in an elevated Command Prompt:
```bat
setx TELEGRAM_ORCHESTRATOR_BOT_TOKEN "YOUR_BOT_TOKEN_HERE" /M
setx TELEGRAM_ORCHESTRATOR_CHAT_ID "YOUR_CHAT_ID_HERE" /M
```

**NOTE:** `setx /M` requires a new shell session or reboot for Task Scheduler to pick up the values. After setting, close and reopen any terminals before proceeding to Task 9.

- [ ] **Step 4: Test Telegram send**

```bash
source scripts/orchestrator/telegram.sh
tg_send "🧪 Master Orchestrator test — om du ser detta fungerar boten!"
```

- [ ] **Step 5: Verify message arrived in Telegram**

---

### Task 9: Dry-run the orchestrator

**Files:** None (validation)

- [ ] **Step 1: Run orchestrator manually (single cycle)**

```bash
cd C:/Projects/Code/Crypto/cryonix-agent-army
bash scripts/orchestrator/run_orchestrator.sh
```

- [ ] **Step 2: Check output**

```bash
# Check cycle counter incremented
cat reports/master-orchestrator/.cycle_counter

# Check report directory was created
ls reports/master-orchestrator/

# Check log
ls reports/master-orchestrator/logs/
```

- [ ] **Step 3: Review the cycle report**

Read the generated `summary.md` in the cycle directory. Verify:
- Health check data present
- Agent audits generated (10 files)
- Meta-analysis present
- Telegram message received

- [ ] **Step 4: Fix any issues found, re-run if needed**

---

### Task 10: Activate Task Scheduler

**Files:** None (system setup)

- [ ] **Step 1: Run setup script as Administrator**

Right-click `scripts/orchestrator/setup_task_scheduler.bat` → Run as administrator.

- [ ] **Step 2: Verify tasks created**

```bat
schtasks /Query /TN "CryonixMasterOrchestrator"
schtasks /Query /TN "CryonixOrchestratorWatchdog"
```

- [ ] **Step 3: Trigger first scheduled run manually**

```bat
schtasks /Run /TN "CryonixMasterOrchestrator"
```

- [ ] **Step 4: Verify it ran (check reports dir and Telegram)**

- [ ] **Step 5: Commit all remaining files**

```bash
git add -A scripts/orchestrator/ reports/master-orchestrator/
git commit -m "feat(orchestrator): complete Master Orchestrator infrastructure — ready for autonomous operation"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Directory structure + env template | `scripts/orchestrator/env.example`, `reports/master-orchestrator/*` |
| 2 | Telegram helper | `scripts/orchestrator/telegram.sh` |
| 3 | Parallel agent audit | `scripts/orchestrator/run_agent_audit.sh` |
| 4 | Main orchestrator script | `scripts/orchestrator/run_orchestrator.sh` |
| 5 | Windows .bat wrapper | `scripts/orchestrator/run_orchestrator.bat` |
| 6 | Watchdog | `scripts/orchestrator/watchdog.sh` |
| 7 | Task Scheduler setup | `scripts/orchestrator/setup_task_scheduler.bat` |
| 8 | Telegram bot setup (manual) | Environment variables |
| 9 | Dry-run validation | — |
| 10 | Activate Task Scheduler | — |
