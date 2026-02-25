# ADR-010: Full System Audit — 4-Phase Fix
**Date:** 2026-02-25 | **Status:** Active

## Context (Why)
MarketScout had been dead for 5 days (crashed on ADA/USDC API error, no error handling in `BaseTank.run_loop()`). Multiple race conditions in position locking. No database indexes on time-series tables. Various resilience gaps across all services.

## Decision (What)
Systematic 4-phase audit with 21+ fixes:
1. **Phase 1 -- Stability** (8 fixes): DB indexes, position lock TTL, instance lock, weekly PnL reset
2. **Phase 2 -- Signal Precision** (8 fixes): Dip focus mode, weak solo filter, confidence clamping, dead pattern disable
3. **Phase 3 -- Resilience** (5 fixes): Exponential backoff on auto-trader/telegram/scraper, budget re-verification, Grok retry
4. **Phase 4 -- Config**: Position lock TTL 5->30s, 3 position slots, signal cooldown 15->5min

## Consequences (How)
- 9 database indexes created on production
- All services have error recovery with exponential backoff
- Capital allocator double-checks budget before execution (prevents over-allocation race condition)
- Engine survives per-symbol errors without crashing entire scanner
