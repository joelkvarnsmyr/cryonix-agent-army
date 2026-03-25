# scripts/evolution/

Autonomous code mutation engine that uses the Claude Code CLI to analyze trading performance and make surgical improvements to the strategy codebase. Runs on a cron schedule every 2 hours.

## Files

| File | Description |
|------|-------------|
| `copilot-evolution.mjs` | Main evolution engine. Connects to Postgres and Redis, analyzes the last 24h of trade performance (per-pattern P&L, exit analysis, trade frequency, GainerScanner diagnostics, structural issues), and invokes the Claude Code CLI to mutate strategy code. Includes backup/restore, verification, diff-size guard (max 100 lines), git commit, and Docker redeployment. Up to 3 retry attempts per run. |
| `run_evolution.sh` | Cron wrapper script. Loads `.env`, invokes `copilot-evolution.mjs`, and appends output to `evolution.log`. |
| `verify_deep_value.py` | Post-mutation verification script. Tests the `QuantGuild._detect_deep_value()` detector against synthetic crash data (10% drop with 4x volume) and normal market data. Ensures no false positives or broken detection. |
| `verify_grid.py` | Post-mutation verification script. Tests `GridGuild.check_grid_triggers()` with mock Redis: verifies grid level triggers, price-too-high rejection, and stop-loss cancellation below the lower bound. |
| `prompts/evolution_prompt.txt` | Prompt template providing constraints and instructions for the Claude Code CLI session. Injected into the full prompt alongside live performance data and source code. |

## Claude Code CLI Invocation

The engine invokes Claude Code with restricted tool access:

```bash
claude -p "<prompt>" \
  --model claude-opus-4-6 \
  --allowedTools 'Edit,Read,Glob,Grep,Bash(python3 scripts/evolution/verify_deep_value.py),Bash(python3 scripts/evolution/verify_grid.py),Bash(git diff --stat)' \
  --max-turns 25
```

Key restrictions:
- Only `Edit`, `Read`, `Glob`, `Grep` tools and three specific Bash commands are allowed.
- Maximum 25 turns per session.
- 10-minute timeout.
- Diff-size guard rejects mutations changing more than 100 lines.

## Verification Suite

After Claude applies mutations, the following verification commands run sequentially:

1. `python3 scripts/evolution/verify_deep_value.py`
2. `python3 scripts/evolution/verify_grid.py`
3. `pnpm type-check`
4. `pnpm test`

If any verification fails, changes are rolled back from the pre-mutation backup.

## Usage

```bash
# Run evolution manually
node scripts/evolution/copilot-evolution.mjs

# Via wrapper script
bash scripts/evolution/run_evolution.sh

# Install cron (every 2 hours)
crontab -e
# 0 */2 * * * /home/azureuser/cryonix/scripts/evolution/run_evolution.sh
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POSTGRES_URL` / `POSTGRES_PASSWORD` | Postgres connection for trade performance data. |
| `KV_URL` | Redis connection for calibration, sentiment, and scanner data. |
| `EVOLUTION_MODEL` | Claude model to use (default: `claude-opus-4-6`). |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for evolution progress notifications. |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications. |

## Critical Files Mutated

The evolution engine is restricted to modifying these files:

- `packages/engine/src/guilds/quant.py`
- `packages/engine/src/core/risk_gate.py`
- `packages/engine/src/core/risk_manager.py`
- `apps/web/src/app/api/auto-trade/route.ts`
