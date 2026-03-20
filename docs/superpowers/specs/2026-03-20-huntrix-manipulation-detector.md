# Huntrix — Manipulation Detection & Ride Trader

## Overview

Huntrix is the 9th trading instance in the Cryonix agent army. It detects cryptocurrency manipulation campaigns (pump & dumps, coordinated shills, whale games) and profits by entering during the early pump phase with ultra-tight risk controls.

**Key distinction:** Huntrix does NOT participate in manipulation — it detects someone else's campaign and surfs the price wave. Similar to front-running a known catalyst.

**Paper trading only** until strategy proves itself. No real money at risk initially.

---

## Architecture

```
X/Twitter (Grok live search) ──→ ┌────────────────────┐
                                  │  Manipulation       │
Telegram (existing scraper) ───→  │  Detection Scanner  │──→ Pump Signal
                                  │  (Grok AI analysis) │
CMC trending (existing data) ──→ └────────────────────┘
        │
        v
   Entry Validator (volume + price velocity confirmation)
        │
        v
   Binance BUY (tight SL, trailing stop, dump detection)
        │
        v
   Exit: trailing + dump velocity detection + max hold 30min
```

### Detection Sources

1. **X/Twitter via Grok** — Live search for coordinated shill campaigns, hashtag explosions, pump group announcements, whale alerts (@lookonchain, @WhaleAlert)
2. **Telegram** — Reads existing `telegram:signal:*` Redis keys, detects clustering (multiple channels promoting same token within minutes)
3. **CMC Trending** — Volume anomaly detection using existing `cmc:mcap:*` Redis keys (no CoinGecko API needed)

### Trading Flow

1. Scanner detects manipulation pattern → generates `ManipulationSignal`
2. Entry Validator confirms: volume spike (3x avg), price velocity (1-10%/min), phase detection (EARLY_PUMP only), market cap filter (top 500), spread check (<0.5%)
3. Paper BUY executed at current price
4. Dump Detector monitors every 5s: velocity tracking, volume reversal, shill activity decline
5. Exit on: dump velocity (>2%/min decline), volume reversal (3 checks), shill drop (>50%), trailing stop, or 30min max hold

---

## Exchange & Capital

- **Exchange:** Binance (spot) — same infrastructure as Cryonix main
- **Capital:** $100 USDC paper trading virtual budget
- **Max position size:** $25 per trade
- **Max concurrent:** 2 positions
- **Max daily trades:** 5

### Why Binance Spot (Not Solana DEX)

Solana meme-coin pumps are the most common P&D vector, but they collapse within 60 seconds — faster than exit logic can react. Binance-listed tokens have a liquidity floor, better spread, and more predictable pump cycles (5-20 min). Once the strategy proves profitable on Binance, a Solana mode can be added later via Solanix integration.

---

## Manipulation Classification

Grok AI classifies detected manipulation into four categories:

| Type | Description | Typical Duration | Risk Level |
|------|-------------|-----------------|------------|
| **Pump & Dump** | Coordinated buy + hype, then insider dump | 5-20 min | High |
| **Coordinated Shill** | Multiple accounts/channels pushing same token | 30-120 min | Medium |
| **Whale Accumulation** | Large wallet buying pattern, not manipulation per se | Hours-days | Low |
| **Fake News Pump** | Fabricated news driving price action | 15-60 min | High |

Only **Pump & Dump** and **Coordinated Shill** types are tradeable. Whale Accumulation is logged but not traded (too slow). Fake News Pump is too risky (instant reversal on debunk).

---

## Detection Engine

### X/Twitter Scanner (`scanXForManipulation`)

Uses xAI's chat completions API with the `search` tool enabled (same pattern as existing `x_sentiment.py`). Grok performs live X/Twitter search internally and returns structured analysis. Asks specifically for:
- Coordinated shill campaigns (many accounts tweeting same token rapidly)
- Sudden hashtag explosions for low-cap tokens
- Pump group announcements detected on public channels
- Whale wallet movement alerts (from @lookonchain, @WhaleAlert)

**Prompt structure:**
```
Analyze the last 15 minutes of X/Twitter activity for cryptocurrency manipulation signals.
Look for:
1. Multiple accounts (>5) tweeting about the same low/mid-cap token within 10 minutes
2. Hashtag velocity spikes for specific token tickers
3. Coordinated language patterns (copy-paste tweets, similar phrasing)
4. Pump group announcements or "next 100x" style promotions
5. Whale alert accounts reporting large buys

For each detected campaign, provide:
- Token symbol(s)
- Number of unique accounts involved
- Estimated coordination score (0-100)
- Campaign type: pump_and_dump | coordinated_shill | whale_accumulation | fake_news
- Key evidence (sample tweets/accounts)

Return JSON array. Empty array if no manipulation detected.
```

### Telegram Scanner (`scanTelegramForPumps`)

Reads existing `telegram:signal:*` Redis keys. Detects clustering:
- Multiple channels promoting the same token within 5 minutes
- Cross-channel signal correlation (same symbol, same direction, tight time window)
- Volume of signals per token (>3 channels = suspicious)

### Trending Scanner (`scanTrendingTokens`)

Uses existing CMC data from Redis (no additional API calls):
- `cmc:mcap:{SYMBOL}` — Check for volume anomalies vs 24h average
- Cross-reference detected social campaigns with CMC-listed tokens
- Only considers tokens tradeable on Binance SPOT/USDC pairs

**Symbol resolution:** Huntrix does NOT maintain a watchlist. Detection is signal-driven — the X/Telegram scanners identify token symbols, then the entry validator checks if the symbol is tradeable on Binance. Non-Binance tokens are logged but not traded.

---

## Entry Validation

All conditions must pass before entry:

| Check | Threshold | Source |
|-------|-----------|--------|
| Volume confirmation | Current > 3x 24h average | CCXT ticker |
| Price velocity | Rising 1-10%/min (too fast = peaking) | CCXT ticker (2 samples, 30s apart) |
| Pump phase | EARLY_PUMP or early MID_PUMP only | Phase classifier |
| Market cap filter | Top 500 CMC rank | `cmc:mcap:{SYMBOL}` Redis |
| Already pumped guard | Reject if already +20% from baseline | CCXT 1h candle open vs current |
| Spread check | Bid-ask < 0.5% | CCXT order book |
| No recent exit | Not exited same token in last 30min | Position history |

### Pump Phase Classification

```
Phase detection based on price movement from pre-pump baseline:

EARLY_PUMP:  +0% to +10% from baseline  → ENTER (best R:R)
MID_PUMP:    +10% to +30% from baseline → ENTER only if velocity stable
PEAK:        +30%+ or velocity declining → DO NOT ENTER
DUMP:        Price declining from peak   → DO NOT ENTER
```

Pre-pump baseline: lowest price in last 1 hour before volume spike detected.

---

## Dump Detection & Exit Logic

Position monitoring runs every 5 seconds when in a position:

### Exit Triggers (any one triggers immediate exit)

| Trigger | Condition | Action |
|---------|-----------|--------|
| **Dump velocity** | Price drops >2% in 1 minute | Instant market sell |
| **Volume reversal** | Sell-side trades > buy-side trades for 3 consecutive checks (via CCXT `fetchTrades()` recent trades, classified by taker side) | Market sell |
| **Shill activity drop** | X/Telegram mentions decline >50% from peak (re-scanned every 60s during position hold via lightweight Grok call) | Tighten trailing to 2% |
| **Trailing stop** | Price drops trailing_pct (5%) from high watermark | Market sell |
| **Stop loss** | Price drops sl_pct (3%) from entry | Market sell |
| **Take profit** | Price rises tp_pct (15%) from entry | Market sell |
| **Max hold time** | 30 minutes elapsed since entry | Market sell |

### Velocity Tracking

```
Track price every 5 seconds
velocity_1min = (price_now - price_60s_ago) / price_60s_ago * 100

if velocity_1min < -2.0:
    → DUMP detected, immediate exit
```

---

## Risk Controls

### Position Level
- Max position: $25 (25% of capital)
- Stop loss: 3% (max loss per trade: $0.75)
- Take profit: 15%
- Trailing stop: 5% from high watermark, activates at +2% profit
- Max hold: 30 minutes

**Note:** Trailing activation at +2% with 5% trail width means the trailing stop floor starts at -3% (entry - 3%), same as the SL. The trailing stop only provides additional protection once price exceeds +5% (where trail floor = breakeven). This is intentional — SL guards early, trailing guards after meaningful profit.

### Portfolio Level
- Max daily loss: 15% ($15)
- Max consecutive losses: 3 → pause 1 hour
- Max concurrent positions: 2
- Max trades per day: 5
- Paper trading only (no real money risk)

### Circuit Breakers
- 3 consecutive losses → 1 hour cooldown
- Daily loss > 15% → stop trading for 24 hours
- Win rate < 30% after 20 trades → alert + manual review required

---

## File Structure

```
packages/agents/src/huntrix/
  config.ts                 # TOML loader + interface + defaults
  types.ts                  # ManipulationSignal, PumpPhase, HunterPosition types
  manipulation-scanner.ts   # Core detection: X scanner, Telegram scanner, trending scanner
  entry-validator.ts        # Volume, velocity, phase, market cap, spread checks
  dump-detector.ts          # 5s tick monitoring, velocity tracking, exit triggers
  huntrix-agent.ts          # Main agent: scan loop, entry, position management
  index.ts                  # Barrel export

scripts/services/
  huntrix-runner.ts         # Docker entrypoint (solanix-runner.ts pattern)

apps/web/src/app/
  huntrix/page.tsx          # Dashboard page
  api/huntrix/status/route.ts  # Status API endpoint

apps/web/src/hooks/
  useHuntrix.ts             # React polling hook

huntrix.toml               # Configuration file
Dockerfile.huntrix          # Docker image (Dockerfile.solanix pattern)
```

---

## huntrix.toml Structure

```toml
[general]
name = "Huntrix"
description = "Manipulation Detection & Ride Trader"
mode = "paper"
capital = 100.0
currency = "USDC"

[scanner]
grok_model = "grok-3-mini"
manipulation_keywords = ["pump", "100x", "moon", "gem", "alpha call", "next big", "load up", "accumulate"]
min_shill_accounts = 5
min_coordination_score = 60
min_channels_for_cluster = 3
cluster_window_minutes = 5

[detection]
min_volume_spike_multiplier = 3.0
max_entry_velocity_pct_per_min = 10.0
min_entry_velocity_pct_per_min = 1.0
max_already_pumped_pct = 20.0
max_spread_pct = 0.5
phase_window_minutes = 60

[capital]
max_position_size_usd = 25.0
virtual_balance = 100.0

[limits]
max_open_positions = 2
max_trades_per_day = 5

[risk]
max_daily_loss_pct = 15.0
max_consecutive_losses = 3
consecutive_loss_cooldown_minutes = 60
review_threshold_trades = 20
review_min_win_rate = 30.0

[exits]
stop_loss_pct = 3.0
take_profit_pct = 15.0
trailing_stop_pct = 5.0
trailing_activation_pct = 2.0
max_hold_minutes = 30
dump_velocity_exit_pct_per_min = 2.0
volume_reversal_checks = 3
shill_drop_tighten_pct = 50.0
shill_tightened_trailing_pct = 2.0

[timing]
scan_interval_ms = 120000
price_check_ms = 5000
velocity_window_seconds = 60
shill_recheck_ms = 60000

[telegram]
enabled = true
alert_on_detection = true
alert_on_entry = true
alert_on_exit = true
alert_on_circuit_breaker = true
```

---

## Redis Key Patterns

| Key | Type | TTL | Description |
|-----|------|-----|-------------|
| `huntrix:state` | String (JSON) | None | Full agent state: status, positions, detections, performance |
| `huntrix:detections` | String (JSON) | 1h | Recent manipulation detections (rolling window) |
| `huntrix:risk` | String (JSON) | None | Risk state: daily loss, consecutive losses, cooldown |
| `huntrix:positions` | String (JSON) | None | Current open positions with dump detection metadata |
| `huntrix:exits:recent` | Sorted Set | 30min (self-cleaning) | Recent exits by symbol+timestamp, used for "no recent exit" guard |

---

## Docker Compose Service

```yaml
  huntrix:
    build:
      context: .
      dockerfile: Dockerfile.huntrix
    container_name: huntrix
    restart: unless-stopped
    volumes:
      - ./huntrix.toml:/app/huntrix.toml:ro
    environment:
      - NODE_ENV=production
      - KV_URL=redis://redis:6379
      - BINANCE_API_KEY=${BINANCE_API_KEY:-}
      - BINANCE_API_SECRET=${BINANCE_API_SECRET:-}
      - XAI_API_KEY=${XAI_API_KEY:-}
      - TELEGRAM_INTERACTIVE_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN:-}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
      - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD:-password}@postgres:5432/cryonix
    depends_on:
      - redis
      - postgres
    networks:
      - cryonix
```

---

## Persistence Layer

Paper trades and detections are persisted to Postgres using existing tables:

- **`trades` table** — Paper trade entries with `source = 'huntrix'`, `config_version` tag
- **`position_history` table** — Closed paper positions with P&L
- **`signals` table** — Manipulation detections logged as signals with `pattern_type = 'manipulation_pump_dump'` or `'manipulation_shill'`

No new Postgres tables needed — reuse existing schema. The `trades.metadata` JSONB field stores Huntrix-specific data (manipulation type, coordination score, pump phase at entry, dump velocity at exit).

---

## Dashboard — `/huntrix`

### Components

1. **Detection Feed** — Live feed of detected manipulation campaigns with type, token, coordination score, source evidence
2. **Active Positions** — Table with: symbol, entry price, current price, P&L%, pump phase at entry, velocity, time remaining, dump risk indicator
3. **Scanner Status** — Cards showing: last X scan time, last Telegram scan, last trending check, detection count today
4. **Performance Summary** — Win rate, avg profit per ride, avg hold time, total P&L, best/worst trade
5. **Circuit Breaker Status** — Consecutive losses, daily loss, cooldown timer

---

## Ethical Considerations

- Huntrix does NOT create or participate in manipulation campaigns
- It detects existing campaigns by others and trades alongside
- Legal risk is minimal — no market manipulation, just informed trading
- Financial risk is real: pumps can dump faster than exit logic reacts
- Paper trading mode eliminates financial risk during validation
- Circuit breakers limit downside even in live mode

---

## Success Criteria

After 50 paper trades:
- Win rate > 50% (profitable exits)
- Average winner > average loser (R:R > 1.5:1)
- Max single loss < $2.50 (10% of position)
- No position held to max hold timeout more than 20% of trades
- Detection accuracy: >60% of flagged tokens actually pump within 30 minutes

---

## Dependencies

- **Grok API** (xAI) — Chat completions with `search` tool for live X/Twitter analysis. ~720 calls/day at 2-min scan interval (lightweight mini model). Existing `XAI_API_KEY` env var.
- **CCXT** (Binance) — Price data, volume, order book for validation + paper fills
- **Redis** — State management, existing telegram:signal:* keys
- **CMC data** — Existing `cmc:mcap:*` Redis keys for market cap filter
- **Telegram Bot API** — Alert notifications
