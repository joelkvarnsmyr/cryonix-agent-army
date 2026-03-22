# Huntrix Brain — Autonomous Parameter Optimization

## Overview

Huntrix Brain is an autonomous analysis agent that runs in its own Docker container (`huntrix-brain`). It periodically analyzes Huntrix's trading performance and adjusts `huntrix.toml` parameters to improve win rate and P&L. It can also force-exit positions and restart the runner container.

**Pattern:** Follows the established Aktienix Brain pattern — Claude Code CLI (`claude -p`) as the reasoning engine, with structured data collection and validated action execution.

## Architecture

### Data Flow

```
huntrix-brain container (claude -p)
  -> Reads: Redis (huntrix:state, huntrix:risk, recent trades)
  -> Reads: huntrix.toml (current config)
  -> Analyzes: trade results, win rate by exit type, signal source performance
  -> Output: adjusted parameters in huntrix.toml
  -> Actions: force-exit via Redis, docker restart huntrix
  -> Log: Telegram report + Redis huntrix:brain:last_run
```

### Triggers

| Trigger | Condition | Purpose |
|---------|-----------|---------|
| Scheduled | Every 6 hours (00:00, 06:00, 12:00, 18:00 UTC) | Regular performance review |
| Acute | 2+ consecutive losses OR daily loss > 10% | Emergency parameter adjustment |
| Cooldown | Max 1 run per hour | Prevent brain spam during volatile periods |

### Actions the Brain Can Take

1. **Adjust parameters** — Modify `huntrix.toml` values within safety bounds
2. **Force-exit positions** — Write `huntrix:brain:force_exit` to Redis; runner picks up and exits
3. **Restart runner** — `docker restart huntrix` after config changes to reload TOML
4. **Git commit** — Commit config changes with `[Huntrix-Brain]` prefix

## Parameter Safety Bounds

The brain prompt includes hard min/max bounds. Values outside bounds are rejected before applying.

### Adjustable Parameters

| Parameter | Min | Max | Default |
|-----------|-----|-----|---------|
| `exits.stop_loss_pct` | 1.0 | 8.0 | 3.0 |
| `exits.take_profit_pct` | 5.0 | 30.0 | 15.0 |
| `exits.trailing_stop_pct` | 2.0 | 10.0 | 5.0 |
| `exits.trailing_activation_pct` | 1.0 | 5.0 | 2.0 |
| `exits.max_hold_minutes` | 10 | 60 | 30 |
| `exits.dump_velocity_exit_pct_per_min` | 1.0 | 5.0 | 2.0 |
| `detection.min_volume_spike_multiplier` | 2.0 | 10.0 | 3.0 |
| `detection.max_entry_velocity_pct_per_min` | 5.0 | 20.0 | 10.0 |
| `detection.min_entry_velocity_pct_per_min` | 0.5 | 3.0 | 1.0 |
| `detection.max_already_pumped_pct` | 10.0 | 40.0 | 20.0 |
| `scanner.min_shill_accounts` | 3 | 10 | 5 |
| `scanner.min_coordination_score` | 40 | 80 | 60 |
| `capital.max_position_size_usd` | 10 | 50 | 25 |
| `limits.max_trades_per_day` | 2 | 10 | 5 |
| `risk.max_daily_loss_pct` | 5.0 | 25.0 | 15.0 |

### Frozen Parameters (Brain MUST NOT touch)

- `general.*` — mode, capital, currency (operational settings)
- `timing.*` — scan intervals (risk of API rate limits)
- `telegram.*` — alerting config
- `scanner.sources.*` — which scanners are active

## Data Collection

The brain script collects this data before invoking `claude -p`:

1. **Trade history** — Last 50 closed positions from Redis (`huntrix:state` -> `recent_trades`): symbol, entry/exit price, P&L%, exit_reason, signal type/source, hold time
2. **Current state** — Open positions, virtual balance, daily P&L, consecutive losses
3. **Risk state** — From `huntrix:risk`: totalTrades, totalWins, cooldown status
4. **Current config** — Full `huntrix.toml` contents
5. **Previous brain runs** — Redis `huntrix:brain:last_run` (what was changed last, avoid ping-pong)

## Analysis Prompt

The brain is instructed to analyze:

- **Win rate per exit type** — Which exits trigger most? SL too tight (many small losses -> raise SL)? TP too tight (missing more profit -> raise TP)?
- **Win rate per signal source** — Does Grok X-scan perform better than Telegram clusters? Adjust coordination scores accordingly.
- **Hold time distribution** — Do trades hit max_hold_minutes often? Maybe raise it. Quick exits? Maybe lower it.
- **Velocity & volume thresholds** — Are we filtering out too many good signals (too strict)? Or letting in too much noise (too loose)?

Output format: JSON with `actions[]` — each action has `type` (adjust_param | force_exit | restart_runner), parameter path, old value, new value, reasoning.

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `scripts/services/huntrix-brain.ts` | Brain entrypoint — data collection, trigger logic, `claude -p` invocation, action execution, Telegram report |
| `packages/agents/src/huntrix/brain-actions.ts` | Validate + apply brain actions (bounds check, TOML write, force-exit signal, restart) |

### Modified Files

| File | Change |
|------|--------|
| `Dockerfile.huntrix` | Add git + claude-code CLI for brain container |
| `docker-compose.prod.yml` | New `huntrix-brain` service with Claude mount + Docker socket |
| `huntrix.toml` | Add `[brain]` section (cooldown, trigger thresholds, scheduled hours) |
| `packages/agents/src/huntrix/types.ts` | Add `BrainAction` interface |
| `packages/agents/src/huntrix/config.ts` | Add `brain` config defaults |
| `packages/agents/src/huntrix/huntrix-agent.ts` | Read `huntrix:brain:force_exit` in tick loop |

## Docker Setup

### New Service: `huntrix-brain`

```yaml
huntrix-brain:
  build:
    context: .
    dockerfile: Dockerfile.huntrix
  container_name: huntrix-brain
  restart: unless-stopped
  volumes:
    - ~/.claude:/root/.claude:ro
    - /var/run/docker.sock:/var/run/docker.sock
    - ./huntrix.toml:/app/huntrix.toml
  environment:
    - KV_URL=redis://redis:6379
    - TELEGRAM_INTERACTIVE_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN:-}
    - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
  depends_on:
    - redis
  networks:
    - cryonix-net
```

### Dockerfile Changes

Add to `Dockerfile.huntrix`:
- `git` (for commits)
- `claude-code` CLI via npm (for `claude -p`)
- Docker CLI (for `docker restart`)

### Config Addition (`huntrix.toml`)

```toml
[brain]
enabled = true
cooldown_minutes = 60
scheduled_hours = [0, 6, 12, 18]
acute_consecutive_losses = 2
acute_daily_loss_pct = 10.0
```

## Redis Keys

| Key | Purpose | TTL |
|-----|---------|-----|
| `huntrix:brain:last_run` | Last brain run timestamp + summary + changes | 48h |
| `huntrix:brain:cooldown` | Cooldown flag (prevents re-run) | 1h |
| `huntrix:brain:force_exit` | Force-exit signal (JSON: `{symbol, reason}`) | 5min |

## Telegram Reports

After each brain run, send a Telegram message:

```
HUNTRIX BRAIN ANALYSIS

Trades analyzed: 23 (WR: 52%)
Exit breakdown: SL 8, TP 6, trailing 5, dump 2, max_hold 2

Actions taken:
- exits.stop_loss_pct: 3.0 -> 3.5 (too many tight SL exits)
- exits.max_hold_minutes: 30 -> 35 (several trades hitting max hold)
- Restarted huntrix runner

Next run: ~6h (scheduled)
```
