# ADR-023: Symbol Whitelist Expansion from 2 to 15
**Date:** 2026-02-22 | **Status:** Active

**Origin:** `docs/plans/2026-02-22-symbol-strategy-design.md`

### Context (Why)

The system traded only 2 symbols (INJ, ATOM), selected from backtest results that suffered survivorship bias -- testing symbols already traded and concluding they work. The DIP_BUY and DEEP_VALUE_CRASH strategies are not symbol-specific; a 5% drawdown with recovery is a valid signal regardless of which asset produces it.

With 2 symbols, the system generated 3-5 trades per 60 days while the $40 account sat idle ~90% of the time. Meanwhile, MarketScout scanned 45 symbols every 10 seconds but the whitelist blocked 43 of them -- wasted compute and wasted opportunity.

### Decision (What)

Expand from 2 to 15 quality USDC symbols selected by structural recovery criteria: real ecosystem/developer activity, institutional interest, top ~100 market cap for price floor, sufficient liquidity, and no meme coins.

The 15 symbols: BTC, ETH, SOL, XRP, AVAX, LINK, ADA, DOT, NEAR, SUI, ATOM, INJ, ARB, UNI, RENDER.

Selection rationale by category:
- **Blue chips** (BTC, ETH): ETF-backed, institutional ownership, ultimate safety with reliable dip recovery.
- **High-growth L1s** (SOL, SUI, NEAR, AVAX): High volatility ideal for dip-buying, strong developer ecosystems.
- **Infrastructure** (LINK, DOT, XRP, ADA): Oracle monopoly (LINK), interoperability (DOT), institutional adoption (XRP), large retail community with consistent bounce-back (ADA).
- **DeFi/L2** (ARB, UNI, INJ): Leading L2 (ARB), real revenue DeFi (UNI), high-volatility DeFi-focused (INJ).
- **Narrative with usage** (RENDER): AI compute with actual GPU rendering demand, not pure speculation.

Explicitly excluded: All meme coins (DOGE, SHIB, PEPE, BONK, FLOKI, WIF, 1000SATS, ANIME) because dips are sentiment-driven with no fundamental recovery logic. Speculative/niche tokens (AIXBT, ARKM, MANTA, STRK, JTO, etc.) due to single-protocol risk or declining relevance.

Implementation: Update `cryonix.toml` symbol_whitelist + modify `market_scout.py` to read symbols from TOML instead of a hardcoded 45-symbol list (with fallback to the full list if whitelist is empty). GainerScanner and CMC Scout keep their own broader lists for market context.

All existing safety layers remain unchanged: consensus gate, regime gating, HTF veto, recovery candle requirement, AI validation, CMC rank/FDV filters, spread/slippage limits, stop loss, trailing stop, daily loss limit, min order value, half-Kelly sizing.

### Consequences (How)

- **Positive**: Estimated 15-25 trades per 60 days (vs 3-5 before). Idle time reduced from ~90% to ~60-70%. Diversification across 5+ sectors eliminates the INJ+ATOM correlation risk.
- **Positive**: No per-trade risk change -- all quality gates remain active. More opportunities to trade, not more risk per trade.
- **Trade-off**: More symbols means more noise for the scanner to process, though the 15-symbol whitelist is actually less compute than the previous 45-symbol scan.
- **Trade-off**: Some included symbols (SUI, NEAR, ARB) have shorter track records. Their structural recovery assumption is less battle-tested than BTC/ETH.
- **Trade-off**: MarketScout now reads symbols from TOML, coupling scanner behavior to config. A bad TOML edit could blank the whitelist (mitigated by fallback to hardcoded 45-symbol list).
