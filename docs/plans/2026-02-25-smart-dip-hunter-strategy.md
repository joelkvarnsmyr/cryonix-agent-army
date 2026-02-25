# Smart Dip Hunter Strategy — Design & Implementation

**Date:** 2026-02-25
**Status:** Implemented & Live
**Author:** Joel + Claude Opus 4.6

## Problem

Full system audit on 2026-02-25 revealed two critical issues:

1. **MarketScout crashed and was dead for 5 days** (Feb 20-25). A transient Binance API error on ADA/USDC caused LangGraph `astream()` to yield `None`, crashing `BaseTank.run_loop()` permanently — no error handling existed.

2. **Poor trading performance**: 29% win rate (6W/15L), total PnL -$1.67. Most pattern combinations had negative EV. Only 4 of 15 pattern combos were profitable.

## Root Cause Analysis

### Why MarketScout Died

```
[MarketData] Error fetching ADA/USDC: binance GET .../klines?symbol=ADAUSDC
[MarketScout] No data received for ADA/USDC
Task exception was never retrieved
  exception=AttributeError("'NoneType' object has no attribute 'get'")
```

`BaseTank.run_loop()` had no try/except around the per-symbol loop. One `None` output from LangGraph killed the entire async coroutine forever. Engine restarts didn't help because ADA/USDC would fail again immediately.

### Why Most Trades Lost Money

Pattern performance from calibration data (all-time):

| Pattern | Trades | Win% | EV | Verdict |
|---------|--------|------|----|---------|
| DIP_BUY + MACD | 2 | 100% | +$0.98 | Winner |
| MACD + VOL_SPIKE | 4 | 50% | +$0.24 | Winner |
| BOLLINGER_SQUEEZE | 6 | 67% | +$0.21 | Winner |
| DIP_BUY + RSI | 2 | 100% | +$0.11 | Winner |
| EMA + MACD (combo) | 6 | 0% | -$0.23 | **Consistent loser** |
| EMA + VOL_SPIKE | 5 | 20% | -$0.24 | **Consistent loser** |
| DEEP_VALUE + RSI | 4 | 0% | -$0.19 | **Falling knife** |
| RSI_OVERSOLD solo | 7 | 29% | -$0.16 | **Noise** |

The system was taking too many trend-following trades (MACD+EMA crosses) that consistently lost money, while value/dip patterns had strong positive EV.

## Strategy Decision: Smart Dip Hunter

### Backtest Validation (30 days, 14 symbols, $40 capital)

Ran full backtests across all 14 USDC whitelist symbols. Filtered results by pattern type:

**DIP_BUY + DEEP_VALUE_CRASH combo trades:**
- INJ: +$1.24, ADA: +$0.77, DOT: +$0.91, LINK: +$0.66
- RENDER: +$0.56, AVAX: +$0.52, ATOM: +$0.46, XRP: +$0.27
- Losers: SOL -$2.27 (falling knife), ARB -$1.54, ETH -$1.02

**MACD+EMA-only trades (would be blocked):**
- Mixed: some won (BTC +$0.25, ADA +$0.33) but historically unreliable
- Live calibration shows 0% win rate on this combo

**Portfolio projection with Dip Focus:**
- 24 trades/month, +$0.64 PnL (+1.6%)
- With GROK AI filtering falling knives: estimated +2-6%/month

### Why Not Scalping

User initially proposed scalping with leverage. Backtests showed:
- Even on 5m timeframe: max 7 trades per symbol in 30 days (not enough for scalping)
- 15m had better Sharpe ratios than 5m
- System's pattern detection is built for swing/dip trades, not micro-scalping
- Current 29% win rate + leverage = rapid account destruction

## Implementation

### 1. Engine Resilience Fix (`packages/engine/src/tanks/base.py`)

```python
# Before: one crash kills entire scanner
async for output in self.runnable.astream(initial_state):
    step_status = output.get("status", "processing")  # crashes on None

# After: per-symbol try/except + None guard
for symbol in self.symbols:
    try:
        async for output in self.runnable.astream(initial_state):
            if output is None:
                continue
            step_status = output.get("status", "processing")
    except Exception as e:
        print(f"[{self.name}] Error processing {symbol}, skipping: {e}")
```

### 2. Dip Focus Mode (`cryonix.toml` + `auto-trade/route.ts`)

New config in `[patterns]`:
```toml
dip_focus_mode = true
value_patterns = ["DIP_BUY", "DEEP_VALUE_CRASH", "BOLLINGER_SQUEEZE"]
```

New filter in risk gate (after weak solo filter, before EV model):
```typescript
const dipFocusMode = TOML?.patterns?.dip_focus_mode ?? false;
if (dipFocusMode) {
    const valuePatterns = TOML?.patterns?.value_patterns ?? [...];
    const hasValuePattern = patterns.some(p => valuePatterns.includes(p));
    if (!hasValuePattern) {
        return { pass: false, reason: `Dip focus: no value pattern` };
    }
}
```

### 3. Faster Cooldown (`cryonix.toml` + `base.py`)

```toml
[engine]
signal_cooldown_seconds = 300  # Was 900 (15 min) → now 5 min
```

Configurable via `get_toml('engine', 'signal_cooldown_seconds', 900)`.

### 4. Position Sizing for 3 Slots

```toml
[limits]
max_open_positions = 3      # Was 2
max_signal_positions = 3    # Was 2

[capital]
max_position_size_pct = 0.35  # Was 0.45 (prevents over-allocation with 3 slots)
```

### 5. Backtester 5m Support (`scripts/strategy-lab/backtest.py`)

Added `5m` to `TF_CONFIG`. Made `fetch_all()` smart — only fetches primary TF + HTF context (1h/4h/1d), not all timeframes.

## Signal Flow (Updated)

```
MarketScoutTank → QuantGuild patterns → RiskGate (confidence >= 70%)
  → Redis trades:pending
  → Auto-Trader reads queue
  → [NEW] Dip Focus Filter: requires DIP_BUY/DEEP_VALUE_CRASH/BOLLINGER_SQUEEZE
  → EV Model Filter (reject negative EV)
  → GROK AI validation (fail-closed)
  → Execute on Binance
```

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Falling knives (dip continues) | GROK AI validation + ATR-based stop-loss |
| Too few trades | 15 symbols × 5min cooldown + 3 position slots |
| Missing profitable MACD+EMA trades | Accepted trade-off; live data shows 0% WR on this combo |
| Config drift | `dip_focus_mode` is a single toggle to revert |

## How to Monitor

- Dashboard: `http://openclaw-vm/analytics` — trade journal + pattern performance
- Telegram: `/positions`, `/pnl`, `/journal`
- Logs: `docker logs cryonix-auto-trader-1 --tail 50`
- Expect: "Dip focus: no value pattern" rejections in auto-trader logs for trend-only signals

## How to Revert

Set `dip_focus_mode = false` in `cryonix.toml` and restart:
```bash
docker compose -f docker-compose.prod.yml restart web auto-trader
```
