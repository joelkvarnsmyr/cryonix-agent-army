# AktienixBrain Design Spec

**Date:** 2026-03-10
**Status:** Approved

## Goal

Add an autonomous portfolio intelligence layer to Aktienix — a standalone service (`AktienixBrain`) that analyses trading performance via Claude Opus, then autonomously adjusts strategy parameters, modifies the watchlist, and closes underperforming positions.

## Architecture

AktienixBrain runs as a separate Docker service (`aktienix-brain`) alongside the trading agent. It is a TypeScript script (`scripts/services/aktienix-brain.ts`) using `setInterval` for scheduling. It does NOT run inside the trading agent process — isolation keeps Brain failures from affecting live trading.

**Model:** `claude-opus-4-6` via `@anthropic-ai/sdk`

## Trigger Logic

Two trigger types, checked every 60 seconds:

| Trigger | Condition |
|---------|-----------|
| Scheduled | 09:00 ET (market open) + 16:30 ET (market close) daily |
| Acute | consecutiveLosses >= 2 OR dailyPnlDollar < –3% of portfolio value |

**Cooldown:** Maximum one Brain run per hour regardless of trigger type. Last run timestamp stored in Redis `aktienix:brain:last_run`.

## Data Collection

Brain reads the following before calling Claude:

**From Redis:**
- `aktienix:account` — portfolioValue, buyingPower, settledCash, isPatternDayTrader
- `aktienix:positions` — all open positions (symbol, qty, avgEntryPrice, unrealizedPl, marketValue)
- `aktienix:risk` — canTrade, dailyPnlDollar, weeklyPnlDollar, consecutiveLosses, tradesToday, dayTradesThisWeek
- `aktienix:signals` — last 24h signals (symbol, action, confidence, reasoning, timestamp)
- `aktienix:brain:last_run` — previous Brain summary (for continuity)

**From Postgres (`aktienix_trades`, last 7 days):**
- Per-symbol: trade count, win rate, average realized P&L, average confidence
- Overall: total trades, overall win rate, total P&L 7d

**From disk:**
- `aktienix.toml` — current config values (broker, capital, risk, exits, watchlist, timing, intelligence)

## Claude Opus Analysis

Brain sends a structured prompt with all collected data and requests a JSON response:

```
System: You are AktienixBrain, an autonomous portfolio analyst for US equity swing trading.
        You have full authority to adjust strategy parameters within the defined safety bounds.

User: [JSON blob of all collected data]
      Analyse performance, identify patterns, and return a JSON action plan.

Response format:
{
  "analysis": "concise narrative analysis (2-4 paragraphs)",
  "actions": [
    { "type": "adjust_param", "param": "risk.min_confidence", "old": 0.38, "new": 0.45, "reason": "..." },
    { "type": "add_symbol", "symbol": "NVDA", "reason": "..." },
    { "type": "remove_symbol", "symbol": "CRSP", "reason": "..." },
    { "type": "close_position", "symbol": "MRNA", "reason": "..." }
  ]
}
```

## Actions and Safety Bounds

Brain validates every action against hard bounds before applying:

| Action type | Parameter | Allowed range / condition |
|-------------|-----------|--------------------------|
| `adjust_param` | `risk.min_confidence` | 0.30 – 0.75 |
| `adjust_param` | `limits.max_position_slots` | 1 – 8 |
| `adjust_param` | `capital.max_position_pct` | 0.05 – 0.25 |
| `adjust_param` | `exits.stop_loss_pct` | ±20% of current value |
| `adjust_param` | `exits.take_profit_pct` | ±20% of current value |
| `add_symbol` | watchlist | max 10 additions per run |
| `remove_symbol` | watchlist | only if no open position in that symbol |
| `close_position` | any open position | only if unrealizedPl% < –5% OR position age > 5 days |

Any action violating its bounds is logged and skipped — never silently mutated to fit.

## Applying Actions

### Parameter adjustments
Brain reads `aktienix.toml` as text, applies changes via the `@iarna/toml` parser (already a dependency), and writes the file back. AktienixAgent calls `loadAktienixConfig()` at the top of every trading loop iteration, so new values take effect on the next poll without restart.

### Watchlist changes
Add/remove symbols from `[[watchlist.symbols]]` in `aktienix.toml`. Same file write as above.

### Position closing
Brain instantiates an `AlpacaClient` (paper or live, same credentials from env) and submits a SELL MARKET order. The fill is logged to `aktienix_trades` with `exit_reason = 'brain_intervention'`.

## Telegram Report

Sent after every Brain run regardless of whether actions were taken:

```
🧠 AktienixBrain — [Scheduled / Acute] Report

📊 Portfolio: $X (+$Y today, +Z%)
🏆 Win rate 7d: W% (N/M trades)
⚠️  Trigger: [Scheduled market close | Acute: 2 consecutive losses]

[analysis narrative from Claude]

Actions taken:
✅ min_confidence: 0.38 → 0.45
✅ Removed from watchlist: CRSP, BMRN
✅ Closed MRNA: –$234 (held 6 days)
— No position changes required

Next scheduled run: [datetime ET]
```

If no actions are taken, report shows `— No changes made` with analysis only.

## Docker Deployment

New service in `docker-compose.prod.yml`:

```yaml
aktienix-brain:
  build: { context: ., dockerfile: Dockerfile.scripts }
  restart: unless-stopped
  command: ["npx", "tsx", "scripts/services/aktienix-brain.ts"]
  volumes:
    - ./aktienix.toml:/app/aktienix.toml  # read-write (Brain modifies config)
  environment:
    - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    - ALPACA_PAPER_API_KEY=${ALPACA_PAPER_API_KEY}
    - ALPACA_PAPER_API_SECRET=${ALPACA_PAPER_API_SECRET}
    - ALPACA_API_KEY=${ALPACA_API_KEY:-}
    - ALPACA_API_SECRET=${ALPACA_API_SECRET:-}
    - KV_URL=redis://redis:6379
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD:-password}@postgres:5432/cryonix
    - TELEGRAM_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN}
    - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
    - XAI_API_KEY=${XAI_API_KEY:-}
  networks:
    - cryonix-net
  depends_on:
    redis:
      condition: service_healthy
    postgres:
      condition: service_healthy
```

**Note:** `aktienix.toml` is mounted read-write for Brain. The trading agent mounts it `:ro` — this is intentional. Only Brain writes to the config file.

## Error Handling

- Claude API failure → log error, skip all actions, send minimal Telegram alert, retry at next scheduled run
- Alpaca close-position failure → log error, keep position, note in Telegram report
- TOML write failure → log error, do not partially apply changes, alert via Telegram
- Redis read failure → abort run entirely, do not call Claude with incomplete data

## Out of Scope

- Brain does not open new positions (only closes)
- Brain does not adjust per-symbol stop-loss overrides (only global exits config)
- Brain does not interact with IBKR (Alpaca only for now)
- Brain does not modify `intelligence.*` config keys (Grok scan settings)
