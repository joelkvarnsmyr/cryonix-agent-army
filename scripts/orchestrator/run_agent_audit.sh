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
