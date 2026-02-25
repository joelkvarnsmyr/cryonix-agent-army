# ADR-003: Spot-Only Mode
**Date:** 2026-02-14 | **Status:** Active

## Context (Why)
With 29% win rate and $17 capital, leverage would mean rapid account destruction. Backtesting confirmed: even 3x leverage on current signals would wipe the account within weeks.

## Decision (What)
System operates in spot-only mode:
- Auto-trader rejects all SELL signals (only BUY)
- No margin, no leverage, no short positions
- Enforced in both Python engine (`config.py`) and TypeScript (`CONFIG`)

## Consequences (How)
- Maximum loss per trade is limited to position size (no liquidation risk)
- Cannot profit from bearish signals (accepted trade-off at current skill level)
- Simplifies position management (no margin calls, no funding rates)
- Can be revisited when win rate exceeds 50% consistently
