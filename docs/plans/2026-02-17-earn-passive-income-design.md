# Earn: Passive Income Integration for Cryonix

**Date:** 2026-02-17
**Status:** Design only — parked for future implementation
**Author:** Joel + Claude
**Priority:** Low (build after Aktienix stock trading)

## Problem Statement

Capital sitting idle between trades earns 0%. At current portfolio size (~$42) the
absolute yield is negligible, but building the "never idle capital" infrastructure now
means it's ready when the portfolio grows to 100k+ SEK.

## Strategy: Phased Earn Integration

### Phase 1 — Binance Simple Earn (Recommended First Step)

**What:** Auto-subscribe idle USDC to Binance Simple Earn Flexible when no trades are
pending. Auto-redeem before executing a trade signal.

**Why Binance Earn first:**
- Zero new infrastructure — Binance API keys already configured
- Instant withdrawal (flexible earn) — no lockup, no unbonding period
- No smart contract risk — centralized, same counterparty as trading
- ~3-5% APY on USDC, ~1-2% on BNB
- Two API calls total: subscribe + redeem

**API Integration:**
```
POST /sapi/v1/simple-earn/flexible/subscribe
  { productId: "USDC001", amount: idle_usdc }

POST /sapi/v1/simple-earn/flexible/redeem
  { productId: "USDC001", amount: needed_for_trade }
```

**Data flow:**
```
Auto-Trade Route (existing)
  → After position monitoring, before sleep:
     → Check USDC balance not in earn
     → If idle USDC > min_order_value: subscribe to Earn
  → Before executing a BUY signal:
     → Check if USDC is in Earn
     → If yes: redeem needed amount (instant)
     → Wait for redemption confirmation
     → Execute trade as normal
```

**Config (cryonix.toml):**
```toml
[earn]
enabled = false                  # Master switch
auto_subscribe = true            # Auto-deploy idle USDC
min_idle_threshold_usd = 10.0    # Don't subscribe amounts below this
reserve_keep_free_usd = 5.0     # Always keep this much un-subscribed for gas/fees
```

**Dashboard addition:** Show current earn position, accrued yield, APY.

**Effort:** Small — ~50 lines in auto-trade route + config.

### Phase 2 — Liquid Staking (When Capital > $500)

**What:** Liquid stake ETH/SOL positions via Lido (stETH) or Jito (JitoSOL) when
held between trades. The liquid staking token (LST) can be sold immediately if needed.

**Why liquid staking:**
- 3-7% APY on ETH/SOL without losing liquidity
- LST tokens tradeable on DEXs — can exit without unstaking
- Compounds with existing TA-based holding strategy

**Complexity:** Medium — requires on-chain wallet interactions, gas estimation,
and LST price tracking. Not worth building until positions are large enough that
gas fees are proportional.

**When to build:** When average ETH/SOL position size > $100 and holding time > 24h.

### Phase 3 — DeFi Yield Optimization (When Capital > $5,000)

**What:** Park stablecoin reserves in Aave/Compound lending for 4-5% APY.
Potentially use revenue-sharing tokens (GMX staking → ETH rewards).

**Why deferred:** Smart contract risk, gas costs, and protocol diversification
complexity are not justified at small scale. At $5k+ the annual yield ($200-250)
starts being meaningful.

### Not Recommended for Cryonix

**Bittensor mining:** Interesting but orthogonal to trading. Requires GPU hardware,
is a separate operational concern. Better as its own project. If desired, add TAO
to the trading watchlist instead.

**Full earn-engine (yield optimizer):** Overengineered for current scale. A dedicated
"EarnTank" comparing yields across protocols and rebalancing solves a problem that
doesn't exist yet. Revisit at $10k+ capital.

**Yield farming with exotic APYs:** High-APY farming (50%+) typically means high
token emission dilution. Not compatible with a risk-managed approach.

## Key Constraints

- **Instant liquidity required:** Earn positions must be redeemable within seconds
  for trade execution. No lockup periods.
- **No additional counterparty risk:** Phase 1 uses Binance (already our broker).
  Phase 2+ introduces smart contract risk — acceptable only at larger scale.
- **Capital efficiency is the goal, not yield maximization:** 3% safe yield on idle
  capital beats 20% risky yield that might be unavailable when a trade signal fires.

## Dependencies

- Binance SAPI earn endpoints (Phase 1)
- On-chain wallet + Web3 library (Phase 2+)
- Aave/Compound SDK or direct contract calls (Phase 3)

## Revenue Projection

| Capital | Phase | APY | Annual Yield | Monthly |
|---------|-------|-----|-------------|---------|
| $42 | 1 (Binance Earn) | 4% | $1.68 | $0.14 |
| $500 | 1 + 2 (+ staking) | 5% | $25 | $2.08 |
| $5,000 | 1 + 2 + 3 (+ DeFi) | 5.5% | $275 | $22.92 |
| $50,000 | Full stack | 6% | $3,000 | $250 |

The value is not in today's yield — it's in building the system that scales.
