# Solanix Signal Quality Overhaul

## Problem
Solanix has 34.5% WR (8W/17L) — worst of all agents. Root cause: momentum-chasing entries that catch pump tails, not starts.

## Root Causes
1. **h6 weight (30%)** catches end of pumps — by the time 6h trend confirms, smart money exits
2. **min_confidence 0.40** accepts weak signals barely above noise
3. **15-min TA scan** too slow for Solana volatility
4. **4% stop-loss** too tight — normal Solana volatility whipsaws it
5. **No anti-FOMO filter** — enters tokens already up 10%+ in 1h
6. **No permanent symbol blocks** — re-enters losing tokens after 4h cooldown

## Strategy: Hybrid B+C

### Signal Weight Rebalance (dexscreener-signal-generator.ts)
| Component | Before | After | Rationale |
|-----------|--------|-------|-----------|
| h1 price change | 0.25 | **0.40** | Catch entries, not tails |
| h6 price change | 0.30 | **0.15** | Reduce tail-chasing |
| Volume surge | 0.20 | 0.20 | Keep |
| Buy pressure | 0.10 | **0.15** | Better crowd-reading |
| Trend alignment | 0.15 | **0.10** | Less weight on lagging indicator |

### Anti-FOMO Filter (NEW)
- If h1 > +10%: **reject** (pump tail, too late)
- If h6 > +15%: **reject** (extended run, reversal imminent)

### Dip-Reversal Bonus (ENHANCED)
- If h6 <= -5% AND h1 > +1%: score **0.25** (was 0.15)
- If h6 <= -8% AND h1 > +2%: score **0.35** (new tier — deep dip reversal)

### Config Changes (solanix.toml)
- `min_confidence`: 0.40 → **0.55**
- `min_signal_score`: 0.40 → **0.50**
- `stop_loss_pct`: 4.0 → **6.0** (wider for Solana volatility)
- `signal_scan_interval_ms`: 900000 → **300000** (15min → 5min)
- `dexscreener_scan_interval_ms`: 300000 → **180000** (5min → 3min)
- `dexscreener_min_liquidity_usd`: 50000 → **100000**

### Bayesian Permanent Block (solanix-agent.ts)
- If symbol WR < 20% after 5+ trades: block for 24h (was 4h cooldown)
- Prevents throwing money at consistently losing tokens

### Buy Pressure Gate Fix (dexscreener-signal-generator.ts)
- Lower txn threshold: 20 → **10** (catch low-volume manipulation earlier)
- Raise buy ratio requirement: 0.45 → **0.50** (need genuine buying)

## Files Changed
1. `packages/agents/src/solanix/signals/dexscreener-signal-generator.ts` — weights, anti-FOMO, dip bonus, buy gate
2. `solanix.toml` — confidence, SL, scan intervals, liquidity
3. `packages/agents/src/solanix/solanix-agent.ts` — permanent block logic

## Expected Impact
- Fewer entries (higher bar) → higher quality entries
- Anti-FOMO prevents worst losses (entering at peaks)
- Dip-reversal bonus captures mean reversion (proven in Cryonix)
- Wider SL avoids whipsaw exits on normal volatility
- Faster scans catch moves closer to start
- Target: WR 45-55% (up from 34.5%)
