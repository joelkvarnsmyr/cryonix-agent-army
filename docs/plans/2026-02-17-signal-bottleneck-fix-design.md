# Design: Signal Execution Bottleneck Fix

**Date:** 2026-02-17
**Status:** Approved — ready for implementation

## Problem

206 high-confidence BUY signals (up to 95%) generated for coins that moved +5-8% (ATOM, JTO, JUP, TAO) but only 1 trade executed. Root causes:

1. **Position slots blocked:** 3 max slots occupied by stagnant positions (MANTA ±0% for 17h)
2. **Instance lock stale after deploys:** Auto-trader blocked for minutes/hours after each container restart
3. **Too few daily trades:** max_trades_per_day=6 too restrictive for 700+ signals/day
4. **Capital underutilized:** $41 capital, only $18 deployed (43%), rest idle

### Backtest Results (48h)

| Scenario | P&L | Notes |
|----------|-----|-------|
| Current settings | -$0.73 (7d) | 3 slots, no stagnation exit |
| 5 slots + 8h stagnation exit | +$1.48 (48h) | Would have caught ATOM +4.6%, JTO +3%, JUP +2.7% |

## Solution: Approach A — Quick Wins

Three independent fixes, each deployable separately.

### Fix 1: Instance Lock Self-Healing

**File:** `apps/web/src/app/api/auto-trade/route.ts`

Simplify INSTANCE_ID from `hostname-pid` to just `hostname`. Since Docker assigns new hostnames on restart and we only run one web container, this ensures the new container can always acquire the lock once TTL expires.

Reduce TTL from 90s to 60s for faster recovery after deploys.

**Config:** `timing.instance_lock_ttl_seconds = 60`

### Fix 2: Stagnation Exit (8h timeout)

**File:** `apps/web/src/app/api/auto-trade/route.ts` — `monitorPositions()`

New exit trigger: if a position hasn't moved >1% in 8 hours, sell it and free the slot.

```
age > stagnation_timeout AND abs(pnlPct) < 1.0 → SELL
```

**Config:** New `exits.stagnation_timeout_hours = 8`

### Fix 3: Increase Position Limits

**File:** `cryonix.toml`

| Setting | Old | New | Rationale |
|---------|-----|-----|-----------|
| max_open_positions | 3 | 5 | $41 capital / $8.50 per position = 4.9 |
| max_signal_positions | 2 | 4 | Allow 4 signal + 1 grid |
| max_trades_per_day | 6 | 10 | More room with faster turnover |
| instance_lock_ttl_seconds | 90 | 60 | Faster recovery after deploys |

## Files Changed

| File | Changes |
|------|---------|
| `cryonix.toml` | max_open_positions=5, max_signal_positions=4, max_trades_per_day=10, instance_lock_ttl=60, new stagnation_timeout_hours=8 |
| `apps/web/src/app/api/auto-trade/route.ts` | Simplify INSTANCE_ID, add stagnation exit in monitorPositions() |
| `apps/web/src/lib/config.ts` | Add stagnation_timeout_hours to CryonixConfig interface |

## Risk Mitigation

- **More positions = more exposure:** Daily loss limit (5%) still applies as safety net
- **Stagnation exit before breakout:** 8h is conservative; most breakouts happen within 4h of pattern detection
- **No changes to signal generation or AI validation:** Only the execution layer changes
- **Each fix is independent:** Can deploy and rollback separately

## Deployment

```bash
docker compose -f docker-compose.prod.yml build web
docker compose -f docker-compose.prod.yml up -d web auto-trader
```

## Verification

1. Check logs: `docker logs cryonix-web-1 --tail 50`
2. Verify new position limit: `/audit` should show `N/5`
3. Monitor for stagnation exits in trade alerts
4. Verify instance lock clears within 60s after deploy
