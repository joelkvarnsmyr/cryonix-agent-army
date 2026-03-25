# Symbol Strategy — Design

**Date:** 2026-02-22
**Status:** Approved

## Problem

The system trades 2 symbols (INJ, ATOM) selected by backtest results. This is survivorship bias — we tested symbols we already traded and concluded they work. The strategy (DIP_BUY + DEEP_VALUE_CRASH) is not symbol-specific. A 5% drawdown with recovery is a valid signal regardless of symbol. With 2 symbols we get 3-5 trades per 60 days. The $40 account sits idle 90% of the time.

Meanwhile, MarketScout scans 45 symbols every 10 seconds but the whitelist blocks 43 of them. Wasted compute, wasted opportunity.

## Goal

Expand from 2 to 15 quality symbols. More dip opportunities, better diversification, faster account growth — without adding risk.

## Symbol Selection Criteria

A symbol qualifies if it has **structural reasons to recover from dips**:
- Real ecosystem / developer activity / institutional interest
- Sufficient market cap (top ~100) for price floor
- Sufficient liquidity for clean execution
- Not purely sentiment-driven (no meme coins)

## The 15 Symbols

| # | Symbol | Rationale |
|---|--------|-----------|
| 1 | BTC/USDC | Ultimate safety. ETF-backed. Rare but reliable dip recovery. |
| 2 | ETH/USDC | DeFi foundation, institutional ownership, ETF flows. |
| 3 | SOL/USDC | Fastest growing L1, high volatility — ideal for dip-buying. |
| 4 | XRP/USDC | Extremely liquid, institutional adoption, tight spreads. |
| 5 | AVAX/USDC | Established L1, subnets adoption, good volatility profile. |
| 6 | LINK/USDC | Oracle monopoly in DeFi. No real competitor. |
| 7 | ADA/USDC | Large retail community, consistent bounce-back behavior. |
| 8 | DOT/USDC | Interoperability, parachain ecosystem, liquid. |
| 9 | NEAR/USDC | AI + scalability narrative, solid tech foundation. |
| 10 | SUI/USDC | Fast-growing Move chain, VC-backed, volatile enough. |
| 11 | ATOM/USDC | Cosmos hub, IBC ecosystem. Proven in backtest. |
| 12 | INJ/USDC | DeFi-focused, high volatility. Proven in backtest. |
| 13 | ARB/USDC | Leading L2, benefits from Ethereum growth. |
| 14 | UNI/USDC | DeFi blue chip, Uniswap has real revenue. |
| 15 | RENDER/USDC | AI compute narrative with actual usage (GPU rendering). |

### Excluded categories

**Meme coins** (DOGE, SHIB, PEPE, BONK, FLOKI, WIF, 1000SATS, ANIME): No fundamental recovery logic. Dips driven by sentiment, not market correction. Technical patterns can't predict social media momentum.

**Speculative/niche** (AIXBT, ARKM, MANTA, STRK, JTO, PYTH, WLD, ICP, FIL, DYDX, LDO, CRV, STX, IMX, ALGO): Too new, too niche (single-protocol risk), or declining relevance.

## Implementation

### 1. Update `cryonix.toml` — symbol_whitelist

Replace 2 symbols with 15.

### 2. Update `market_scout.py` — read symbols from TOML

Replace hardcoded 45-symbol list with TOML whitelist. If whitelist is empty, fall back to current 45 symbols (safety).

GainerScanner and CMC Scout keep their own broader lists — they provide market context (regime detection, Fear & Greed) and need wider visibility.

### 3. Rebuild engine container

Deploy updated engine with new symbol list.

### No other changes

All existing safety layers remain:
- Consensus gate (2+ patterns required)
- Regime gating (blocks patterns that don't fit market regime)
- HTF veto (1h + 4h must confirm)
- Recovery candle requirement (DEEP_VALUE_CRASH)
- AI validation (Grok reviews every signal)
- CMC rank ≤ 500, FDV/MC ≤ 4.0
- Spread ≤ 0.3%, slippage ≤ 0.5%
- Stop loss, trailing stop, daily loss limit 5%
- Min order value $7.50, position sizing via half-Kelly

## Expected Impact

| Metric | Before (2 symbols) | After (15 symbols) |
|--------|--------------------|--------------------|
| Trades per 60d | 3-5 | ~15-25 (est.) |
| Time without position | ~90% | ~60-70% |
| Diversification | None (INJ+ATOM correlated) | Spread across 5+ sectors |
| Risk per trade | Unchanged | Unchanged (all gates intact) |

## File Summary

| File | Action |
|------|--------|
| `cryonix.toml` | Update symbol_whitelist (2 → 15) |
| `packages/engine/src/tanks/market_scout.py` | Read symbols from TOML instead of hardcoded list |
| Engine container | Rebuild + restart |
