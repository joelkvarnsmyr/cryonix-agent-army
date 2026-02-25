# ADR-017: Passive Earn Strategy for Idle Capital
**Date:** 2026-02-17 | **Status:** Deferred

**Origin:** `docs/plans/2026-02-17-earn-passive-income-design.md`

### Context (Why)

Capital sitting idle between trades earns 0%. At the current portfolio size (~$42) the absolute yield is negligible, but building "never idle capital" infrastructure now means it scales when the portfolio grows. The system sits without open positions ~90% of the time, and idle USDC in the Binance spot wallet generates no return.

The key constraint is instant liquidity: any earn mechanism must allow redemption within seconds when a trade signal fires. Lockup periods are incompatible with an autonomous trading system.

### Decision (What)

A three-phase earn integration strategy, with only Phase 1 recommended for near-term implementation:

**Phase 1 -- Binance Simple Earn (Flexible)**: Auto-subscribe idle USDC to Binance Simple Earn when no trades are pending. Auto-redeem before executing a BUY signal. Zero new infrastructure (Binance API keys already configured), instant withdrawal, no smart contract risk, ~3-5% APY on USDC. Implementation is ~50 lines in the auto-trade route plus TOML config (`[earn]` section with `enabled`, `min_idle_threshold_usd`, `reserve_keep_free_usd`). Two API calls total: subscribe + redeem.

**Phase 2 -- Liquid Staking (when capital > $500)**: Liquid stake ETH/SOL via Lido (stETH) or Jito (JitoSOL). LST tokens tradeable on DEXs without unstaking. 3-7% APY. Requires on-chain wallet interactions and gas estimation -- not worth building until positions are large enough that gas fees are proportional.

**Phase 3 -- DeFi Yield (when capital > $5,000)**: Park stablecoin reserves in Aave/Compound lending for 4-5% APY. Smart contract risk and protocol diversification complexity only justified at scale where $200-250 annual yield is meaningful.

Explicitly excluded: Bittensor mining (orthogonal to trading), full earn-engine yield optimizer (overengineered), exotic high-APY farming (incompatible with risk management).

### Consequences (How)

- **Deferred**: All phases are parked. Phase 1 is trivial to implement but yields ~$0.14/month at current capital. Build it when portfolio growth makes even small yield meaningful.
- **Trade-off**: Phase 1 adds Binance counterparty risk for idle capital, but this is the same counterparty already used for trading -- no incremental risk.
- **Trade-off**: Phases 2-3 introduce smart contract risk and gas costs that don't justify themselves below $500-5,000 respectively.
- **Design principle**: Capital efficiency over yield maximization. 3% safe yield on instantly-redeemable capital beats 20% risky yield that might be unavailable when a signal fires.
- **Revenue projection**: At $50k capital with all phases active, ~$3,000/year ($250/month). The value is in building infrastructure that scales, not in today's yield.
