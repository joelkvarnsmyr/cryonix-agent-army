# AktienixBrain Design Spec

**Date:** 2026-03-10
**Status:** Approved (v2 — Claude Code CLI approach)

## Goal

Add an autonomous portfolio intelligence layer to Aktienix — a standalone service (`AktienixBrain`) that collects trading data, then delegates all analysis and action to **Claude Code CLI** (`claude -p`). Claude reads the codebase directly, edits `aktienix.toml`, closes positions via helper scripts, and commits changes — exactly like the existing `copilot-evolution.mjs` system.

## Architecture

AktienixBrain runs as a separate Docker service (`aktienix-brain`) alongside the trading agent. It is a TypeScript/Node script (`scripts/services/aktienix-brain.ts`) using `setInterval` for scheduling.

**Key design principle:** Brain itself is dumb — it collects data and builds a prompt. Claude Code CLI is the intelligence layer that reads files, makes decisions, edits configs, and runs scripts autonomously.

**No Anthropic SDK required.** Claude Code CLI is already installed on the VM (`claude` binary on PATH). Brain calls it as a subprocess, same as `copilot-evolution.mjs`.

## Trigger Logic

Two trigger types, checked every 60 seconds:

| Trigger | Condition |
|---------|-----------|
| Scheduled | 16:30 ET (market close) + 09:00 ET (market open) daily |
| Acute | `consecutiveLosses >= 2` OR `dailyPnlDollar < -(portfolioValue * 0.03)` |

**Cooldown:** Maximum one Brain run per hour. Last run timestamp stored in Redis `aktienix:brain:last_run`.

**Acute trigger computation:** Both values read from Redis `aktienix:risk`. The threshold for daily loss is computed as `portfolioValue * 0.03` where `portfolioValue` comes from Redis `aktienix:account`. These are separate Redis keys — both must be fetched before evaluating the acute condition.

## Data Collection

Brain reads the following before building the Claude prompt:

**From Redis (all keys have 5-minute TTL — may be null if agent is idle at market close):**
- `aktienix:account` — portfolioValue, buyingPower, settledCash, isPatternDayTrader
- `aktienix:positions` — all open positions (symbol, qty, avgEntryPrice, unrealizedPl, marketValue)
- `aktienix:risk` — canTrade, dailyPnlDollar, weeklyPnlDollar, consecutiveLosses, tradesToday, dayTradesThisWeek
- `aktienix:brain:last_run` — previous Brain summary (JSON, see structure below)

**Stale Redis handling:** If `aktienix:account` is null (trading agent idle, keys expired), Brain proceeds with Postgres data only. In the prompt, account/position/risk sections are replaced with `"[not available — agent idle]"`. Claude will still analyse trade performance and adjust config, but skips position-specific actions (cannot close positions without current position data). This is the expected behaviour for scheduled market-close runs when the agent has been idle.

**From Postgres (`aktienix_trades`, last 7 days) — filter `side = 'SELL' AND realized_pnl IS NOT NULL`:**
- Per-symbol: trade count, win rate, average realized P&L
- Overall: total closed trades, overall win rate, total P&L 7d

**From disk:**
- `aktienix.toml` — current config (read by Brain for context; Claude will re-read it directly via Read tool)

## Claude Code CLI Invocation

Brain writes the prompt to a temp file and pipes it to Claude Code CLI — identical to `copilot-evolution.mjs`:

```typescript
const prompt = buildBrainPrompt(collectedData);
const promptPath = join(tmpdir(), `brain-${runId}.md`);
await writeFile(promptPath, prompt);

const result = await execCommand(
    `cat ${promptPath} | CLAUDECODE= claude -p ` +
    `--model claude-opus-4-6 ` +
    `--allowedTools 'Edit,Read,Glob,Grep,` +
    `Bash(npx tsx scripts/aktienix/close-position.ts),` +
    `Bash(docker restart aktienix),` +
    `Bash(git add aktienix.toml),Bash(git commit)' ` +
    `--max-budget-usd 3`,
    { timeout: 300_000, cwd: PROJECT_ROOT }
);
```

**Allowed tools for Claude:**
- `Edit` / `Read` / `Glob` / `Grep` — read and edit `aktienix.toml`, read code
- `Bash(npx tsx scripts/aktienix/close-position.ts <SYMBOL>)` — close a specific position
- `Bash(docker restart aktienix)` — reload the trading agent after config changes (picks up new toml immediately, no hot-reload complexity)
- `Bash(git add aktienix.toml)` + `Bash(git commit)` — commit config changes only (not `git add -A` — avoids staging unrelated files)

**Hot-reload via restart:** Claude edits `aktienix.toml`, then runs `docker restart aktienix`. The Docker volume mount makes the edited file immediately visible to the new process. This is simpler and more reliable than a cache-invalidation approach.

**Container name:** The `aktienix` service must have `container_name: aktienix` set in `docker-compose.prod.yml` so `docker restart aktienix` resolves correctly. Without it, Docker Compose auto-names the container `cryonix-aktienix-1` and the restart command fails. Adding `container_name: aktienix` to the service definition is required as part of this implementation.

## Prompt Structure

Brain's prompt tells Claude exactly what it can and cannot do:

```markdown
# AktienixBrain — Portfolio Analysis Run

You are AktienixBrain, an autonomous portfolio analyst for Aktienix (US stock trading).
Today is {date}. Run ID: {runId}.

## Current State

### Account
{accountState JSON}

### Open Positions
{positions JSON}

### Risk State
{riskState JSON}

### Trade Performance (7 days, closed trades only)
{tradeStats JSON — per symbol + overall}

### Previous Brain Run
{previousSummary or "First run"}

## Your Job

Analyse trading performance and take autonomous corrective actions.

### Config File
Read `aktienix.toml` — that is the live config. Edit it directly if changes are needed.

### What You CAN Change in aktienix.toml:

| Parameter | Allowed range |
|-----------|--------------|
| `risk.min_confidence` | 0.30 – 0.75 |
| `limits.max_open_positions` | 1 – 8 |
| `capital.max_capital_per_trade_pct` | 0.05 – 0.25 |
| `exits.stop_loss_pct` | current ±20% |
| `exits.take_profit_pct` | current ±20% |
| symbols in `[watchlist]` section | add up to 10, remove if no open position |

### What You CAN Do:

- Edit `aktienix.toml` to adjust the parameters above
- Run `npx tsx scripts/aktienix/close-position.ts SYMBOL` to close a specific position
  - Only close if: unrealizedPl% < –5% OR position held > 5 days
- Run `docker restart aktienix` AFTER editing aktienix.toml (so changes take effect)
- Run `git add aktienix.toml && git commit -m "brain({runId}): <brief description>"` to commit config changes

### What You CANNOT Do:

- Open new positions
- Change `intelligence.*` settings
- Change `broker.*` settings
- Exceed the parameter bounds above

## Output

After completing your analysis and actions, print a brief summary:

```
BRAIN_SUMMARY_START
Trigger: [scheduled/acute]
Actions: [list of what you did]
Analysis: [2-3 sentences]
BRAIN_SUMMARY_END
```
```

## Helper Script: close-position.ts

A new script `scripts/aktienix/close-position.ts` must be created as part of this implementation. It:

1. Reads Alpaca credentials from environment
2. Connects to Alpaca (paper or live based on `ALPACA_PAPER_API_KEY` presence)
3. Submits SELL MARKET order for the given symbol + full qty from current position
4. Polls order status until filled (max 30s)
5. Logs the trade to `aktienix_trades` in Postgres with `exit_reason = 'brain_intervention'`
6. Exits 0 on success, 1 on failure

## Post-Run: Parse and Report

After Claude finishes, Brain:
1. Extracts the `BRAIN_SUMMARY_START...BRAIN_SUMMARY_END` block from Claude's output
2. Checks `git diff --stat` to list changed files
3. Stores summary in Redis `aktienix:brain:last_run` (JSON, 48h TTL) with this structure:
   ```json
   {
     "runId": "brain_1741650000000",
     "trigger": "scheduled",
     "timestamp": "2026-03-10T21:30:00Z",
     "analysis": "2-3 sentence summary from Claude",
     "actions": ["min_confidence: 0.38 → 0.45", "Closed MRNA: -$234"]
   }
   ```
   In subsequent prompts, `previousSummary` is rendered as: `"[{timestamp}] {analysis} Actions: {actions.join(', ')}"`
4. Sends Telegram report

**Telegram format:**
```
🧠 AktienixBrain — [Scheduled / Acute] Report

📊 Portfolio: $X (+$Y today)
⚠️  Trigger: [reason]

[analysis from Brain summary]

Actions: [list from Brain summary]
Files changed: aktienix.toml

Next scheduled: [datetime ET]
```

## Docker Deployment

New service in `docker-compose.prod.yml`:

```yaml
aktienix-brain:
  build: { context: ., dockerfile: Dockerfile.scripts }
  restart: unless-stopped
  command: ["npx", "tsx", "scripts/services/aktienix-brain.ts"]
  volumes:
    - ./aktienix.toml:/app/aktienix.toml  # read-write (Brain edits config)
    - /var/run/docker.sock:/var/run/docker.sock  # for docker restart aktienix
  environment:
    - NODE_ENV=production
    - KV_URL=redis://redis:6379
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD:-password}@postgres:5432/cryonix
    - TELEGRAM_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN}
    - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
    - ALPACA_PAPER_API_KEY=${ALPACA_PAPER_API_KEY}
    - ALPACA_PAPER_API_SECRET=${ALPACA_PAPER_API_SECRET}
    - ALPACA_API_KEY=${ALPACA_API_KEY:-}
    - ALPACA_API_SECRET=${ALPACA_API_SECRET:-}
    - PROJECT_ROOT=/app
  networks:
    - cryonix-net
  depends_on:
    redis:
      condition: service_healthy
    postgres:
      condition: service_healthy
```

**Notes:**
- `aktienix.toml` mounted read-write. Trading agent mounts it `:ro` — intentional.
- Docker socket mounted so Brain can restart the trading agent after config changes.
- No `ANTHROPIC_API_KEY` needed — `claude` CLI uses its own auth (already configured on VM).

## Error Handling

| Failure | Response |
|---------|----------|
| Claude CLI exits non-zero | Log error, skip Telegram actions list, send alert |
| Claude makes no file changes | Log warning ("no actions taken"), still send report |
| `close-position.ts` exits 1 | Log error, note in Telegram report, do not crash Brain |
| Redis read fails | Abort run entirely, do not call Claude with incomplete data |
| Postgres read fails | Proceed with "no trade data available" in prompt |
| Git commit fails | Log warning, continue (config change still took effect) |

## New Required Env Var

`ANTHROPIC_API_KEY` is **not** needed — Claude Code CLI handles auth separately.
`TELEGRAM_BOT_TOKEN` must be added to `.env` on the VM if not already present (it is — same token as `TELEGRAM_INTERACTIVE_BOT_TOKEN`).

## Out of Scope

- Brain does not open new positions (only closes)
- Brain does not modify IBKR settings (Alpaca only)
- Brain does not modify `intelligence.*` config keys
- Brain does not interact with the trading agent process directly (only via Docker restart + Redis)
