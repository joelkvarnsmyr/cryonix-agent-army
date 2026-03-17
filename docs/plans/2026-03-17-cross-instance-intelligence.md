# Cross-Instance Intelligence Stack

**Date:** 2026-03-17
**Status:** Deployed to production

## Overview

Cryonix auto-trade pipeline now blends intelligence from all 5 agent instances in the army. Each instance contributes unique data that the others can't see, creating an information edge through cross-system correlation.

## Intelligence Stack (7 layers)

```
Signal (QuantGuild TA patterns)
  │
  ├── 1. GROK AI Validation (second opinion + X search)
  ├── 2. X Sentiment (social media buzz score ±5-8%)
  ├── 3. Polymarket (crypto/fed/oil/geopolitik prediction markets ±4%)
  ├── 4. Vedic Astrology (Mercury Rx, Pushya/Mula, per-symbol transits ±3-6%)
  ├── 5. Smart Money — Copynix whale wallets (±5%)         [NEW 2026-03-17]
  ├── 6. Macro Events — Aktienix geopolitik tracking (±3%)  [NEW 2026-03-17]
  ├── 7. Solanix DEX — SOL position P&L as sentiment (±3%)  [NEW 2026-03-17]
  │
  └── Bayesian Self-Learning (updates posteriors per trade, ±15% cap)
      │
      └── Execute on Binance
```

## Data Flow

### Smart Money (Copynix → Cryonix)

```
40 Solana whale wallets
  → Helius API (transaction polling, 15min cycles)
  → DexScreener (symbol resolution + price enrichment)
  → Redis: smartmoney:{SYMBOL} (5min TTL)
  → Cryonix reads: ≥2 wallets buying same asset, score ≥50 → +5% confidence
                    ≥2 wallets selling, score ≤-50 → -5% penalty
```

**Key fix:** Copynix previously logged all tokens as "UNKNOWN" because Helius API returns `symbol: null` for many tokens. Fixed by resolving symbols via DexScreener `baseToken.symbol` in `enrichTradePrices()`.

### Macro Events (Aktienix → Cryonix)

```
Aktienix Brain (Claude Code CLI analysis)
  → CNBC/MarketWatch news analysis
  → Redis: aktienix:macro:event_states (hash of active events)
  → Cryonix reads: event phase "developing"/"escalating" → -3% confidence
```

**Example:** Oil supply shock from Iran/Strait of Hormuz conflict detected by Aktienix Brain, applied as risk-off penalty to all crypto trades.

### Solanix DEX (Solanix → Cryonix)

```
Solanix DEX trading agent
  → Active positions with real-time P&L
  → Redis: solanix:positions (JSON array)
  → Cryonix reads: SOL position >+2% → +3% for SOL trades
                    SOL position <-3% → -3% penalty for SOL trades
```

**Rationale:** DEX traders are faster than CEX. If Solanix's SOL position is profiting, it's a leading indicator that SOL momentum is positive.

## Redis Keys

| Key | Source | Type | TTL | Consumed by |
|-----|--------|------|-----|-------------|
| `smartmoney:{SYMBOL}` | Copynix | string (JSON) | 5min | Cryonix auto-trade |
| `smartmoney:_overall` | Copynix | string (JSON) | 5min | (future: dashboard) |
| `aktienix:macro:event_states` | Aktienix | hash | persistent | Cryonix auto-trade |
| `solanix:positions` | Solanix | string (JSON) | 5min | Cryonix auto-trade |
| `polymarket:crypto` | Polymarket Scanner | string (JSON) | 15min | Cryonix auto-trade |
| `vedic:transit:{SYMBOL}` | Vedic Trader | string (JSON) | 1h | Cryonix auto-trade |

## Safety

All cross-instance adjustments are:
- **Fail-safe:** If data is unavailable, no adjustment is made (try/catch with empty fallback)
- **Capped:** Each source adjusts ±3-8%, total Bayesian cap ±15%
- **Conditional:** Require minimum evidence (2+ wallets for Smart Money, specific phases for macro)

## Files Modified

- `apps/web/src/app/api/auto-trade/route.ts` — Smart Money, Macro, Solanix reads
- `packages/agents/src/copynix/copynix-agent.ts` — UNKNOWN token fix + Smart Money publish
- `apps/web/src/lib/trading/bayesian.ts` — Bayesian self-learning (pre-existing)
