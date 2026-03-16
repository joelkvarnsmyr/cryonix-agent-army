# Vedic Venus Rx SHORT — Futures Integration Plan

## Research Summary
- **Signal**: Venus Retrograde (~40 days, every 18 months)
- **Strategy**: SHORT at Day+7 into Rx, trailing stop (+5%/-3%)
- **Performance**: Sharpe 4.49, 96.4% WR, +6.5% avg/trade, +181.6% total (28 trades)
- **Best symbols**: ETH (+7.84%), BTC (+7.53%), BNB (+6.97%)
- **Avg hold**: 15 days
- **Risk**: Max adverse excursion 44.9% (one XRP trade in 2018)

## Architecture

### Option A: Binance Futures (Recommended)
- USDT-M futures (perpetual contracts)
- 1x leverage (no leverage — pure directional short)
- Separate API key pair for futures account
- Fund with $200-500 USDT

### Option B: Binance Margin (Alternative)
- Cross margin on spot account
- Borrow + sell, buy back later
- More complex, higher fees

### Implementation Plan

#### 1. Binance Futures Account Setup
- Enable futures on existing Binance account
- Create separate futures API key (restrict to futures only)
- Transfer $300 USDT to futures wallet
- Env vars: `BINANCE_FUTURES_API_KEY`, `BINANCE_FUTURES_API_SECRET`

#### 2. Futures Execution Module
```python
# packages/engine/src/futures/executor.py
class FuturesExecutor:
    """Execute SHORT orders on Binance USDT-M futures."""

    def open_short(symbol, size_usdt, sl_pct, tp_pct):
        # 1. Place SELL order (open short)
        # 2. Set stop-loss (BUY STOP)
        # 3. Set take-profit (BUY LIMIT)

    def close_short(symbol):
        # 1. Place BUY order (close short)
        # 2. Cancel SL/TP orders

    def get_positions():
        # Read open futures positions

    def get_funding_rate(symbol):
        # Check funding rate (cost of holding)
```

#### 3. Venus Rx SHORT Trader Service
```python
# scripts/services/vedic-short-trader.py
class VedicShortTrader:
    """Dedicated Venus Rx SHORT trader on Binance Futures."""

    # State machine: WAITING → VENUS_RX_DETECTED → COUNTDOWN (7d) → SHORT_ACTIVE → CLOSED
    # Entry: Day+7 into Venus Rx
    # Exit: Trailing stop (+5%/-3%) or Venus goes direct
    # Safety: 1x leverage, max 3 positions, $100 per position
```

#### 4. Docker Service
```yaml
# docker-compose.prod.yml
vedic-short:
  build:
    context: .
    dockerfile: Dockerfile.vedic-short
  restart: always
  environment:
    - KV_URL=redis://redis:6379
    - BINANCE_FUTURES_API_KEY=${BINANCE_FUTURES_API_KEY}
    - BINANCE_FUTURES_API_SECRET=${BINANCE_FUTURES_API_SECRET}
```

#### 5. Dashboard Integration
- Add futures wallet to /vedic dashboard
- Show short positions with real-time P&L
- Funding rate display
- Venus Rx countdown timer

### Risk Management
- **No leverage** (1x only) — max loss = position size
- **Max 3 concurrent shorts** ($100 each = $300 total exposure)
- **Trailing stop at +5%/-3%** — locks in profit
- **Mercury Rx filter** — skip if Mercury also Rx
- **Manual override** — Telegram command to close all shorts
- **Funding rate budget** — ~0.03%/day × 15 days = ~0.45% cost per trade

### Timeline
1. [BLOCKED] User enables Binance futures + creates API key
2. [READY] Implement FuturesExecutor module
3. [READY] Implement vedic-short-trader.py
4. [READY] Add to dashboard

### Next Venus Rx Period
- Estimated: ~October 2026 (Venus Rx in Scorpio)
- Preparation deadline: September 2026
