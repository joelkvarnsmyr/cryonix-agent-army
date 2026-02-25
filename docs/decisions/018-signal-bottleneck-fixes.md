# ADR-018: Signal Execution Bottleneck Fixes
**Date:** 2026-02-17 | **Status:** Active

**Origin:** `docs/plans/2026-02-17-signal-bottleneck-fix-design.md`

### Context (Why)

206 high-confidence BUY signals (up to 95%) were generated for coins that moved +5-8% (ATOM, JTO, JUP, TAO), but only 1 trade was executed. The system was generating good signals but failing to act on them.

Root causes identified:
1. **Position slots blocked**: 3 max slots occupied by stagnant positions (MANTA at +/-0% for 17 hours), preventing new trades.
2. **Instance lock stale after deploys**: Auto-trader blocked for minutes/hours after each container restart because the instance ID included the PID, which changed on restart while the old lock persisted in Redis.
3. **Too few daily trades**: `max_trades_per_day=6` was too restrictive for 700+ signals/day.
4. **Capital underutilized**: $41 capital, only $18 deployed (43%), rest idle.

A 48-hour backtest comparison showed the current settings produced -$0.73 over 7 days, while 5 slots + 8h stagnation exit would have yielded +$1.48 over 48h (catching ATOM +4.6%, JTO +3%, JUP +2.7%).

### Decision (What)

Three independent quick-win fixes, each deployable separately:

**Fix 1 -- Instance Lock Self-Healing**: Simplify `INSTANCE_ID` from `hostname-pid` to just `hostname`. Since Docker assigns new hostnames on restart and only one web container runs, the new container always acquires the lock once TTL expires. Reduce TTL from 90s to 60s for faster recovery after deploys.

**Fix 2 -- Stagnation Exit (8h timeout)**: New exit trigger in `monitorPositions()`: if a position hasn't moved more than 1% in 8 hours, sell it and free the slot. `age > stagnation_timeout AND abs(pnlPct) < 1.0 -> SELL`. Configurable via `exits.stagnation_timeout_hours = 8`.

**Fix 3 -- Increase Position Limits**: Expand capacity based on capital math ($41 / $8.50 per position = 4.9 slots):

| Setting | Old | New |
|---------|-----|-----|
| max_open_positions | 3 | 5 |
| max_signal_positions | 2 | 4 |
| max_trades_per_day | 6 | 10 |

### Consequences (How)

- **Positive**: Unblocked trade execution -- stagnant positions no longer permanently occupy slots. The system can now act on high-confidence signals that previously went unexecuted.
- **Positive**: Deploys no longer cause multi-minute trading blackouts.
- **Trade-off**: More open positions means more capital exposure. Mitigated by the existing daily loss limit (5%) which acts as a safety net.
- **Trade-off**: Stagnation exit at 8h may sell before a breakout. This is conservative -- most breakouts happen within 4h of pattern detection. Configurable if experience shows 8h is wrong.
- **No changes to signal generation or AI validation**: Only the execution layer was modified, preserving all signal quality filters.
