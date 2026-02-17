# Aktienix: Integrated Stock Trading via Alpaca Markets

**Date:** 2026-02-17
**Status:** Approved design, pending implementation
**Author:** Joel + Claude

## Problem Statement

Cryonix is a crypto-only trading system. Adding US stock trading via Alpaca Markets
enables portfolio diversification across asset classes, and — critically — cross-market
intelligence where each market's data improves the other's trading decisions.

## Key Insight: Cross-Market Correlation

BTC and S&P 500 show meaningful correlation (~0.4-0.7) during macro events. On Feb 5
2026, BTC fell ~15% while S&P dropped ~2% — a synchronized selloff. Cryonix currently
has zero awareness of stock market movements and would have happily bought crypto
during that crash.

By monitoring S&P futures/SPY alongside crypto, the system gains a **macro risk filter**
that prevents buying into correlated selloffs. This is the primary value-add beyond
simple code reuse.

## Architecture: Isolated Engines, Shared Infrastructure

```
┌──────────────────────────────────────────────────────────┐
│  CRYONIX VM (same Azure VM, same docker-compose)         │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ engine       │  │ stocks-engine│  │ macro-engine   │ │
│  │ (Python)     │  │ (Python)     │  │ (Python)       │ │
│  │              │  │              │  │                │ │
│  │ MarketScout  │  │ StockScout   │  │ MacroCorr.Tank │ │
│  │ CMCScout     │  │ (NYSE hrs)   │  │ (SPY/VIX,15m) │ │
│  │ NewsScout    │  │              │  │                │ │
│  │              │  │              │  │                │ │
│  │ → Redis:     │  │ → Redis:     │  │ → Redis:       │ │
│  │   trades:    │  │   trades:    │  │   macro:spy:*  │ │
│  │   pending    │  │   stocks:    │  │   macro:vix:*  │ │
│  │              │  │   pending    │  │                │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘ │
│         │                 │                   │          │
│  ┌──────┴─────────────────┴───────────────────┴────────┐ │
│  │              Redis + Postgres (shared)               │ │
│  └──────┬─────────────────┬────────────────────────────┘ │
│         │                 │                              │
│  ┌──────┴───────┐  ┌─────┴──────────┐                   │
│  │ web (Next.js)│  │ auto-trader    │                   │
│  │              │  │                │                   │
│  │ /api/auto-   │  │                │                   │
│  │   trade      │  │                │                   │
│  │              │  │                │                   │
│  │ Reads BOTH:  │  │                │                   │
│  │ trades:      │  │                │                   │
│  │   pending    │  │                │                   │
│  │ trades:      │  │                │                   │
│  │   stocks:    │  │                │                   │
│  │   pending    │  │                │                   │
│  │              │  │                │                   │
│  │ Macro filter │  │                │                   │
│  │ reads:       │  │                │                   │
│  │ macro:spy:*  │  │                │                   │
│  │ macro:vix:*  │  │                │                   │
│  └──────────────┘  └────────────────┘                   │
│                                                           │
│  + ws-server, telegram-bot, caddy (unchanged)            │
└──────────────────────────────────────────────────────────┘
```

### Three Isolated Python Containers

| Container | Responsibility | Schedule | Crash Impact |
|-----------|---------------|----------|--------------|
| `engine` | Crypto scanning (existing) | 24/7, 10s | Crypto only |
| `stocks-engine` | Stock scanning via Alpaca | NYSE hours, 60s | Stocks only |
| `macro-engine` | SPY/VIX → Redis (cross-market risk) | 24/5, 15min | Macro data only |

**Crash isolation:** If `stocks-engine` dies, Docker restarts it. Crypto engine is
unaffected. Redis queues are independent. The only shared resources (Postgres/Redis)
are infrastructure, not process-coupled.

**RAM budget** (VM has 4GB):
- Current: ~2.5GB (all existing containers)
- Addition: stocks-engine (~150MB) + macro-engine (~80MB) = ~230MB
- Feasible. If needed, upgrade VM to B2s_v2 (8GB).

## Data Flow: Stock Trading Pipeline

```
StockScoutTank (Python, stocks-engine container)
  → Check NYSE.is_open() via exchange_calendars
  → If closed: sleep until open (no scanning)
  → If open: every 60s:
     → Fetch 15m OHLCV via alpaca-py (15 US large-caps)
     → QuantGuild pattern detection (identical TA, tuned thresholds)
     → RiskGate (confidence >= 70%, stricter for stocks)
     → Redis trades:stocks:pending

MacroCorrelationTank (Python, macro-engine container)
  → Every 15 min:
     → Fetch SPY last 1h change (Yahoo Finance / Alpaca free)
     → Fetch VIX level (if available)
     → Calculate: spy_1h_change, vix_level
     → Write to Redis: macro:spy:change_1h, macro:vix:level

Auto-Trade Route (Next.js, web container)
  → Read trades:stocks:pending (separate from crypto)
  → Read macro:spy:* as pre-filter:
     → SPY dip >1% last 1h → raise crypto confidence threshold +20%
     → SPY dip >1% → pause stock buys for 2h
     → VIX > 30 → pause ALL new buys
  → AlpacaAdapter: Alpaca paper/live API
  → Bracket order (entry + SL + TP) — native Alpaca support
  → Store position with asset_class='equity'
```

### Key Differences from Crypto Flow

- **60s scan** instead of 10s (stocks move slower)
- **Market hours gate** — no scanning outside NYSE hours
- **Bracket orders** — Alpaca supports atomic SL+TP orders (better than Binance)
- **Macro cross-filter** — SPY data affects BOTH markets' decisions
- **Overnight gap risk** — positions can gap through stop-loss at market open

## Database Schema Changes

Minimal — one column on 4 tables:

```sql
ALTER TABLE signals          ADD COLUMN asset_class VARCHAR(10) NOT NULL DEFAULT 'crypto';
ALTER TABLE positions        ADD COLUMN asset_class VARCHAR(10) NOT NULL DEFAULT 'crypto';
ALTER TABLE trades           ADD COLUMN asset_class VARCHAR(10) NOT NULL DEFAULT 'crypto';
ALTER TABLE position_history ADD COLUMN asset_class VARCHAR(10) NOT NULL DEFAULT 'crypto';

CREATE INDEX idx_signals_asset   ON signals(asset_class);
CREATE INDEX idx_positions_asset ON positions(asset_class);
```

Existing crypto data gets `DEFAULT 'crypto'` automatically. New stock signals written
with `'equity'`. No new tables needed.

## Configuration: cryonix.toml Additions

```toml
# ╔═══════════════════════════════════════════════════════════╗
# ║  STOCK TRADING (Alpaca Markets)                          ║
# ╚═══════════════════════════════════════════════════════════╝

[stocks]
enabled = false                # Master switch
broker = "alpaca"
paper_trading = true           # Always paper until switched to live
scan_interval_seconds = 60
min_confidence = 0.70          # Stricter than crypto (0.60)

symbols = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
    "META", "TSLA", "AMD", "AVGO", "CRM",
    "NFLX", "COST", "JPM", "V", "UNH"
]

[stocks.capital]
allocated_sek = 100000         # Total stock budget in SEK
max_position_size_pct = 0.10   # Max 10% per position
reserve_pct = 0.20             # 20% cash reserve
min_order_value_usd = 5.0

[stocks.limits]
max_open_positions = 8
max_trades_per_day = 6         # Conservative (PDT rules)

[stocks.exits]
trailing_stop_pct = 2.0        # Tighter than crypto
trailing_activation_pct = 1.5
sl_atr_multiplier = 2.5
tp_atr_multiplier = 4.0
stagnation_timeout_hours = 24  # Stocks move slower

# ╔═══════════════════════════════════════════════════════════╗
# ║  MACRO CORRELATION FILTER                                ║
# ╚═══════════════════════════════════════════════════════════╝

[macro]
enabled = false
poll_interval_seconds = 900    # Every 15 min

spy_dip_threshold_pct = 1.0    # >1% dip → activate filter
spy_dip_crypto_penalty = 0.20  # Raise crypto confidence req by 20%
spy_dip_stocks_pause_hours = 2 # Pause stock buys for 2h

vix_high_threshold = 30        # VIX > 30 = high market stress
vix_pause_all_buys = true      # Pause ALL buys when VIX > 30
```

## Docker Additions

New services in `docker-compose.prod.yml`:

```yaml
stocks-engine:
  build:
    context: ./packages/stocks-engine
    dockerfile: Dockerfile
  restart: always
  volumes:
    - ./cryonix.toml:/app/cryonix.toml:ro
  environment:
    - PYTHONUNBUFFERED=1
    - KV_URL=redis://redis:6379
    - NEXTJS_API_URL=http://web:3000
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/cryonix
    - ALPACA_API_KEY=${ALPACA_API_KEY}
    - ALPACA_API_SECRET=${ALPACA_API_SECRET}
    - ALPACA_PAPER=true
  networks:
    - cryonix-net
  depends_on:
    redis: { condition: service_healthy }

macro-engine:
  build:
    context: ./packages/macro-engine
    dockerfile: Dockerfile
  restart: always
  volumes:
    - ./cryonix.toml:/app/cryonix.toml:ro
  environment:
    - PYTHONUNBUFFERED=1
    - KV_URL=redis://redis:6379
  networks:
    - cryonix-net
  depends_on:
    redis: { condition: service_healthy }
```

## Code Reuse Strategy

| Component | Strategy |
|-----------|----------|
| `QuantGuild` | **Import directly** — pip package or shared volume. Zero changes. |
| `RiskGate` + `RiskManager` | **Import directly**. Inject `fetch_capital()` as dependency. |
| `BaseTank` | **Import** — `StockScoutTank(BaseTank)` overrides `scan_market()` |
| `AlpacaMarketDataFetcher` | **New**. Same interface as `MarketDataFetcher` (OHLCV format). |
| `AlpacaAdapter` (auto-trade) | **New** in TypeScript. Parallel to existing Binance code. |
| `MacroCorrelationTank` | **New**. Lightweight Python process, Yahoo Finance / Alpaca → Redis. |
| Dashboard | **Existing** + asset_class tab/filter in UI components. |

## Alpaca Markets: Broker Analysis

### Swedish Access (Validated)
- **No minimum capital requirement** — accounts can be opened and funded with any amount.
- **Funding for Swedish users**: CurrencyCloud integration provides local bank transfer
  (Swedish bankgiro/IBAN). 1.5% transaction fee, capped at $40.
- **Paper trading**: Works globally, email signup only, no restrictions.
- **Live trading**: Available from Sweden. No $30k barrier (earlier reports were incorrect).
- **Commission-free**: $0 commission on US stocks and ETFs.

### Free Tier Data (IEX Feed)
- **IEX real-time data** — free, no capital requirement (unlike IBKR's $500 minimum).
- **IEX covers ~2-3% of US volume** — not full NBBO, but sufficient for swing trading.
- **30 WebSocket symbols max** (sufficient for 15 stocks).
- **200 requests/min** rate limit. For a 60s scan of 15 symbols, this is adequate.
- **SIP feed** (full market) available for $99/month — not needed initially.

### Order Types
- Market, Limit, Stop, Stop-Limit, Trailing Stop all supported.
- **Bracket orders** (entry + SL + TP as one atomic order) — excellent fit.
- Trailing stops cannot be nested in bracket orders — manage separately.

### Fractional Shares
- Minimum order: $1.00 notional.
- Can buy $7 of NVDA — ideal for small positions and portfolio diversification.

### Regulatory Constraints

**PDT (Pattern Day Trader) Rules:**
- Accounts under $25,000 are limited to 3 day-trades per 5 business days.
- Our bot must be swing-oriented (hold positions overnight) or strictly limit day trades.
- Config enforces this: `stocks.limits.max_day_trades_per_week = 3`.

**K4 Tax Reporting (Swedish):**
- Alpaca does not report to Skatteverket. Manual K4 filing required.
- Each trade must be declared: acquisition cost (genomsnittsmetoden), USD→SEK conversion
  at transaction-day exchange rate.
- The bot must log all data needed for K4 export: entry date, exit date, SEK cost basis,
  exchange rate, profit/loss in SEK.
- At small scale (~500 SEK) the administrative burden outweighs the tax amount.
- **Future migration to IBKR ISK** recommended when capital exceeds ~20-30k SEK to
  eliminate K4 burden and gain schablonbeskattning benefits.

### IBKR Migration Path
When capital exceeds ~$2,000-3,000 USD:
- Migrate to Interactive Brokers ISK for tax optimization (~1% annual vs 30% on gains).
- The `IExchangeAdapter` abstraction in the design enables broker migration without
  rewriting business logic.
- IBKR requires $500 minimum for API market data — easily met at that capital level.
- IBKR ISK is NOT subject to US PDT rules (Swedish/EU jurisdiction).

## Implementation Phases

| Phase | What | Size |
|-------|------|------|
| **0** | Create Alpaca paper account, get API keys | 10 min |
| **1** | `packages/stocks-engine/` — StockScoutTank + AlpacaMarketDataFetcher | Medium |
| **2** | DB migration: `asset_class` column on 4 tables | Small |
| **3** | `cryonix.toml` stocks + macro sections + TOML loader update | Small |
| **4** | `auto-trade/route.ts` — AlpacaAdapter + stocks:pending consumer | Large |
| **5** | `packages/macro-engine/` — MacroCorrelationTank + SPY/VIX filter | Medium |
| **6** | Dashboard asset-class tab/filter | Small |
| **7** | Paper trade 30 days, validate signal quality | — |
| **8** | Live trading with real capital (Alpaca, from Sweden, no barriers) | — |
| **9** | When capital > 20k SEK: evaluate IBKR ISK migration for tax benefits | — |

## Risk Considerations

- **Capital isolation is absolute**: Crypto and stock pools never cross-fund.
- **Process isolation via Docker**: A crash in stocks-engine cannot affect crypto.
- **Macro filter is fail-safe**: If macro-engine dies, trading continues without macro data (configurable: fail-open or fail-closed).
- **Paper first**: All stock trading starts in paper mode. No live money until validated over 30+ days.
- **PDT rules**: Accounts under $25k limited to 3 day-trades per 5 business days. Bot designed as swing trader.
- **Overnight gap risk**: Stocks can gap through stop-loss at market open. Unlike 24/7 crypto where stops execute immediately.
- **K4 tax burden**: Bot must log full trade history with SEK conversion for annual K4 filing. Consider IBKR ISK migration when capital grows.
- **IEX data quality**: Free IEX feed is not NBBO. Use limit orders (not market) to mitigate price risk.
