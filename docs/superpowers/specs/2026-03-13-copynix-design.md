# Copynix — Design Specification
*2026-03-13*

## Overview

Copynix is an autonomous copy-trading agent for Solana. It discovers the most profitable on-chain traders, monitors their wallets in real-time, and replicates their trades with intelligent position sizing and risk management.

**Phase 1:** Paper trading — virtual $500 USDC, copy 3-5 curated wallets, consensus-based execution.
**Phase 2:** Live trading — real SOL wallet, Jupiter swaps, Helius webhooks for sub-second latency.

---

## Goals

- Copy the best Solana traders autonomously (smart money following)
- Consensus approach: require 2+ tracked wallets buying the same token before copying
- Paper trade first — flip one config flag to go live
- Reuse proven Solanix/Aktienix abstractions (BaseAgent, RiskManager, StatePublisher)
- Independent capital pool from Solanix and Cryonix

---

## Architecture

### File Structure

```
packages/agents/src/copynix/
  copynix-agent.ts              # Orchestrator, extends BaseAgent
  types.ts                      # CopyPosition, TrackedWallet, CopySignal, etc.
  config.ts                     # TOML loader with safe defaults
  wallet-monitor.ts             # Real-time wallet transaction monitoring (Helius webhooks)
  trader-discovery.ts           # Find & rank top traders (Birdeye, Dune, GMGN)
  consensus-engine.ts           # Aggregate wallet signals, require N+ agreement
  copy-executor.ts              # Execute copy trades (paper + live via Jupiter)
  risk-gate.ts                  # Copy-specific risk checks (rug detection, liquidity, age)
  wallet-scorer.ts              # Score & rank tracked wallets by performance
scripts/services/
  copynix-runner.ts             # Entrypoint for Docker / screen session
copynix.toml                    # Configuration (repo root)
```

### What is reused from Solanix/Aktienix

| Component | Reused | Notes |
|-----------|--------|-------|
| `BaseAgent` | Yes | Lifecycle, logging, message queue |
| `StatePublisher` | Yes | Publishes to Redis `copynix:*` keys |
| `RiskManager` | Yes | Circuit breakers, daily loss limits |
| `ExitMonitor` | Adapted | TP/SL from Solanix, plus "leader sold" exit trigger |
| `PositionSizer` | Yes | Dollar-based fractional sizing |
| `SolanaClient` | Partial | Paper trading engine reused, live = Jupiter swap API |

---

## Data Sources

### Tier 1: Wallet Monitoring (Real-time)

**Helius Webhooks** — Primary monitoring layer
- Monitor up to 100k accounts per webhook
- 70+ transaction types detected
- Free tier: 1M credits, 10 RPS (sufficient for 3-5 wallets)
- Webhook retry: 3 attempts, 1-min intervals
- Latency: ~50-100ms after blockchain confirmation

**Fallback: Birdeye WebSocket**
- `SUBSCRIBE_WALLET_TXS` for real-time trade detection
- Requires Starter plan ($99/mo) minimum

### Tier 2: Trader Discovery (Periodic)

**Birdeye Wallet PnL API** — Performance analytics
- Historical P&L, realized/unrealized gains
- Up to 100 tokens per wallet breakdown
- Recent swaps (90 days)

**Dune Analytics** — Top trader dashboards
- "Solana Top Traders" ranked by profitability
- "Daily Top 100 by Wins"
- Custom SQL queries for advanced filtering

**GMGN** — Smart money tracker
- Pre-filtered profitable traders
- KOL tracking
- Requires volume-gated API access

### Tier 3: Execution

**Jupiter Swap API** — DEX aggregator (live mode)
- Metis routing algorithm (optimal price)
- Ultra API: sub-2s latency
- Free tier adequate for copy trading volume

**Paper Trading Engine** — Virtual execution (Phase 1)
- Reuse Solanix `SolanaClient` paper trading
- Track virtual positions with real market prices from DexScreener

---

## Core Algorithms

### 1. Trader Discovery & Scoring (`trader-discovery.ts`)

Run weekly (or on-demand). Finds top Solana traders and scores them.

**Qualification criteria:**
- Minimum 50 trades in last 30 days
- Win rate >= 65%
- Sharpe ratio > 2.0
- No rug pull involvement (check via token age + liquidity patterns)
- Active in last 7 days

**Scoring model (0-100):**
- ROI (30 days): 0-30 pts
- Win rate: 0-25 pts
- Consistency (Sharpe): 0-20 pts
- Trade frequency: 0-15 pts (sweet spot: 2-10 trades/day)
- Diversity penalty: -10 pts if >80% in one token

**Output:** Ranked list of wallet addresses with scores, stored in Redis `copynix:tracked_wallets`.

### 2. Consensus Engine (`consensus-engine.ts`)

Aggregates signals from monitored wallets. A copy signal fires when:

**Consensus rules:**
- **Strong signal (auto-copy):** 3+ tracked wallets buy the same token within a 15-minute window
- **Medium signal (copy with reduced size):** 2 wallets buy same token within 10 minutes
- **Single whale (conditional):** 1 top-5 scored wallet buys, AND token passes safety checks

**Anti-rug safety checks:**
- Token age > 24 hours (skip brand-new launches)
- Liquidity > $50k USD
- Holder count > 50
- LP burnt or locked >= 50%
- No mint authority (immutable supply)

**Cooldown:** Same token can only be copied once per 4 hours.

### 3. Copy Executor (`copy-executor.ts`)

Executes the actual copy trade.

**Sizing logic:**
- Base: $50 max per trade (paper trading)
- Strong consensus (3+): 100% of base size
- Medium consensus (2): 60% of base size
- Single whale: 40% of base size
- Never exceed 20% of portfolio per position

**Exit strategy:**
- Take profit: 25% (crypto moves fast)
- Stop loss: 15%
- Trailing stop: 8% (activation at +10%)
- **Leader exit:** If the original copied trader sells, we sell too (within 60s)
- Stagnation: 48 hours with < 2% move → close

### 4. Wallet Monitor (`wallet-monitor.ts`)

Real-time transaction listener.

**Helius webhook handler:**
```
POST /webhook/copynix → Parse transaction → Identify swap (buy/sell)
  → Match to tracked wallet → Emit to consensus engine
```

**For Phase 1 (paper trading), polling fallback:**
- Poll Birdeye recent swaps every 30s for each tracked wallet
- Less latency-sensitive since we're paper trading anyway

---

## Configuration (`copynix.toml`)

```toml
[broker]
paper_trading = true

[wallets]
# Tracked wallet addresses (discovered by trader-discovery or manual)
tracked = []
max_tracked = 5
discovery_interval_hours = 168  # Weekly

[consensus]
min_wallets_strong = 3
min_wallets_medium = 2
time_window_minutes = 15
cooldown_hours = 4

[capital]
max_position_size_usd = 50
max_capital_per_trade_pct = 0.20
min_order_value = 5.0

[limits]
max_open_positions = 5
max_trades_per_day = 10

[risk]
min_confidence = 0.50
max_daily_loss_pct = 0.10
max_weekly_loss_pct = 0.20
max_consecutive_losses = 4

[safety]
min_token_age_hours = 24
min_liquidity_usd = 50000
min_holders = 50
min_lp_burnt_pct = 50
require_immutable_supply = true

[exits]
take_profit_pct = 25.0
stop_loss_pct = 15.0
trailing_stop_pct = 8.0
trailing_activation_pct = 10.0
leader_exit_enabled = true
leader_exit_timeout_s = 60
stagnation_timeout_hours = 48
stagnation_min_pnl_pct = 2.0

[timing]
poll_interval_ms = 30000
wallet_scan_interval_ms = 30000
discovery_interval_ms = 604800000  # 7 days
```

---

## Redis Keys

| Key | Description | TTL |
|-----|-------------|-----|
| `copynix:state` | Full agent state (positions, wallets, portfolio) | — |
| `copynix:tracked_wallets` | Scored wallet list from discovery | 7d |
| `copynix:wallet:{addr}:trades` | Recent trades for tracked wallet | 24h |
| `copynix:consensus:{token}` | Consensus accumulator for a token | 15min |
| `copynix:cooldown:{token}` | Copy cooldown per token | 4h |
| `copynix:risk` | Risk manager state | — |

---

## Differences from Solanix

| Aspect | Solanix | Copynix |
|--------|---------|---------|
| Signal source | TA + DexScreener momentum | Wallet monitoring + consensus |
| Entry logic | Score-based (h1/h6/volume) | Consensus-based (N wallets agree) |
| Exit logic | TP/SL/trailing/stagnation | Same + "leader sold" trigger |
| Discovery | Static watchlist + curator | Dynamic trader discovery |
| Latency need | Minutes (scan every 5min) | Seconds (webhook/poll 30s) |
| Risk model | Macro filter + rotation | Anti-rug checks + consensus confidence |

---

## Phase 1 MVP (Paper Trading)

1. **Config + Types** — `copynix.toml`, `config.ts`, `types.ts`
2. **Manual wallet list** — Start with 3-5 known good wallets (hardcoded)
3. **Polling monitor** — Birdeye/DexScreener polling every 30s (no webhook infra needed)
4. **Consensus engine** — Time-window aggregation, 2+ wallet threshold
5. **Paper executor** — Virtual positions, real prices from DexScreener
6. **Risk gate** — Anti-rug checks (token age, liquidity, holders)
7. **Exit monitor** — Reuse Solanix exit monitor + leader-exit extension
8. **State publisher** — Redis `copynix:*` keys
9. **Runner** — `scripts/services/copynix-runner.ts`

---

## Phase 2 (Live Trading)

1. **Helius webhooks** — Real-time wallet monitoring (replace polling)
2. **Jupiter execution** — Real swaps via Jupiter Swap API
3. **Trader discovery** — Automated weekly scoring via Birdeye + Dune
4. **Telegram integration** — Copy trade notifications
5. **Dashboard page** — `/copynix` in Next.js app

---

## Cost Estimate

| Service | Tier | Cost |
|---------|------|------|
| Helius | Free | $0/mo (Phase 1 polling, Phase 2 webhooks) |
| Birdeye | Starter | $99/mo (wallet PnL + swaps API) |
| Jupiter | Free | $0/mo |
| GMGN | Applied | $0/mo (volume-gated) |
| **Total** | | **$0-99/mo** |

Phase 1 (paper trading) can run entirely free using DexScreener + Helius free tier.
