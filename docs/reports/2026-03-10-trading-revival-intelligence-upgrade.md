# Trading Revival & Intelligence Upgrade Report
**Date:** 2026-03-10 | **Author:** Copilot CLI (Opus 4.6)

## Summary
After a 10-day trading drought (Feb 26 – Mar 8), the system was fully diagnosed, unblocked, and upgraded with AI-powered market intelligence tools. The trading pipeline is now active and has been enhanced with two new autonomous systems.

## Problem
The system stopped trading entirely on Feb 26. Investigation revealed a **5-layer filter chain** blocking 100% of signals:
1. `min_confidence` too high (0.70) — most signals scored 0.55-0.68
2. `consensus_min_patterns` = 2 — required multiple patterns to agree
3. `volume_spike_threshold` = 999.0 — effectively disabled volume detection
4. Regime gates blocking mean-reversion patterns in trending/volatile markets
5. HTF hard veto killing all dip signals (by design, dips go against short-term trend)

Additionally, 6 orphaned trades with status `FILLED` were blocking position accounting.

## Actions Taken

### Phase 1: Unblock Signal Pipeline
| Parameter | Before | After | Reasoning |
|-----------|--------|-------|-----------|
| `min_confidence` | 0.70 | 0.55 | Allow through signals with moderate confidence |
| `consensus_min_patterns` | 2 | 1 | Single strong pattern is sufficient |
| `volume_spike_threshold` | 999.0 | 1.8 | Re-enable volume spike detection |
| `sl_atr_multiplier` | 3.5 | 5.0 | Wider stops for 15m TF volatility |
| `tp_atr_multiplier` | 6.0 | 12.0 | Let winners run further |
| `trailing_stop_pct` | 3.0 | 6.0 | Don't get shaken out on pullbacks |
| `stagnation_timeout_hours` | 8 | 16 | Give positions more time |
| `loss_cooldown_seconds` | 7200 | 1800 | Re-enter faster after losses |

**Code fixes in `quant.py`:**
- Volatile regime gate: now allows mean-reversion + DIP_BUY patterns
- Trending regime gate: now allows mean-reversion via `filtered.append(p)`
- HTF hard veto: exempts signals with `has_mean_reversion = True`

**Result:** First trade in 10 days executed within 2 hours (BTC/USDC BUY).

### Phase 2: Portfolio Assessment
After 15 hours: 6 trades, 3W/2L, +$1.10 realized PnL, 3 open positions.

Built `grok_analyze.py` — a Grok-powered analysis tool using xAI's `x_search` and `web_search` server-side tools. Used it to assess portfolio:
- **DOT**: HOLD — ETF catalyst + emissions cut (confirmed on X)
- **SUI**: HOLD — L1 rotation narrative active
- **ARB**: EXIT — Dead weight, no momentum or narrative

Manually closed ARB at +5.8% ($0.60 profit), freeing a slot.

### Phase 3: Intelligence Upgrade
1. **Grok Signal Hunter** (`grok_signal_hunter.py`): Autonomous signal discovery via X + web search. Runs every 30 min on cron, injects qualifying signals into `trades:pending`.

2. **Smart Rotation Engine** (in `route.ts`): When all position slots are full, scores positions vs incoming signals. Automatically closes weak positions to make room for stronger opportunities. Configurable via `[rotation]` section in `cryonix.toml`.

### Phase 4: Cleanup
- Cleaned 11 orphaned `FILLED` trades → `CANCELLED`
- BNB dust ($0.06) identified as unavoidable fee residue

## Current State (as of 2026-03-10)

### Open Positions
| Symbol | Entry | Pattern | Confidence | PnL |
|--------|-------|---------|------------|-----|
| SUI/USDC | $0.971 | VOLUME_SPIKE_UP | 89.2% | ~0% |
| DOT/USDC | $1.501 | BOLLINGER_SQUEEZE | 81.3% | +1.5% |
| SOL/USDC | $87.17 | VOLUME_SPIKE_UP | 96.0% | -0.3% |

### System Health
- 9/9 Docker containers running
- Auto-trader cycling every 30s
- Signal hunter cron active (every 30min)
- Smart rotation enabled (min_advantage=15pts, min_hold=30min)

### Performance Since Restart
- Trades: 9 executed
- Realized PnL: ~+$1.70
- Win rate: improving (3W/2L on closed trades)

## New Files
| File | Purpose |
|------|---------|
| `scripts/strategy-lab/grok_analyze.py` | Interactive Grok analysis CLI (6 modes + custom questions) |
| `scripts/strategy-lab/grok_signal_hunter.py` | Autonomous signal injection (cron every 30min) |
| `docs/decisions/027-grok-analysis-and-rotation.md` | ADR for this upgrade |

## Recommendations
1. Monitor rotation decisions in logs (`[ROTATION]` prefix) for the first 24h
2. Consider increasing `max_open_positions` from 3 to 5 once capital grows
3. Run `grok_analyze.py --mode portfolio` daily for human oversight
4. Track signal hunter hit rate — adjust `--top` parameter if quality drops
