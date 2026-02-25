# ADR-004: Capital Allocator — Split Pool Strategy
**Date:** 2026-02-14 | **Status:** Active

## Context (Why)
With ~$17 total capital, position sizing is critical. Running both signal-based trades and grid trading from the same pool risks over-allocation. Need clear budget boundaries.

## Decision (What)
Split capital into three pools via `cryonix.toml`:
- **Signal pool** (SIGNAL_POOL_PCT): For QuantGuild pattern-based trades
- **Grid pool** (GRID_POOL_PCT): For LLM-driven grid trading
- **Reserve** (RESERVE_PCT): Untouchable safety buffer
- Max position size: 35% of pool (prevents single-trade blowup with 3 slots)

## Consequences (How)
- Market regime (trending/ranging/volatile) adjusts pool utilization
- Budget re-verified immediately before execution (Phase 3 race condition fix)
- 3 concurrent position slots maximum
- Prevents scenario where one strategy starves the other
