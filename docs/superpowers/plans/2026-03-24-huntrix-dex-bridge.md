# Huntrix DEX Bridge — DexScreener Pricing + Solanix Signal Relay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Enable Huntrix to track pump prices on DEX tokens (via DexScreener) and relay actionable signals to Solanix for Jupiter execution.

**Architecture:** HuntrixAgent gets a DexScreener price fallback when CCXT returns 0/null. Detected pump signals above threshold are written to Redis (`huntrix:trade_signal`) for Solanix to consume. Solanix polls this key and executes via Jupiter.

**Tech Stack:** TypeScript, DexScreener API (free, no auth), Redis, existing Huntrix + Solanix patterns

---

## Problem

Huntrix detects pump tokens (SHIB2, PEPE2, MOON, FOMO) from X/Telegram scanning. But:
1. These tokens don't exist on Binance → CCXT `fetchTicker()` returns 0
2. PumpProfiler sees 0% price movement → never triggers trade signals
3. Even if it did, there's no execution path to DEX

## Solution

### Change 1: DexScreener price fallback in HuntrixAgent

In `huntrix-agent.ts` `monitorPositions()` (line ~393), after CCXT fetchTicker fails or returns 0, fallback to DexScreener:

```typescript
// Existing: CCXT price
let currentPrice = ticker.last ?? ticker.close ?? 0;

// NEW: DexScreener fallback for DEX tokens
if (currentPrice <= 0 && signal.tokenAddress) {
    currentPrice = await this.fetchDexScreenerPrice(signal.tokenAddress);
}
```

Same for `evaluateEntry()` where it checks current price before entering.

### Change 2: Huntrix → Redis trade signal relay

When Huntrix detects a pump with sufficient confidence AND the token is a DEX token (not on CEX), write a trade signal to Redis for Solanix:

```typescript
// In huntrix-agent.ts, after EntryValidator approves:
if (signal.exchange === 'dex' || signal.exchange === 'unknown') {
    await this.redis.set('huntrix:trade_signal', JSON.stringify({
        symbol: signal.symbol,
        tokenAddress: signal.tokenAddress,
        action: 'BUY',
        confidence: signal.coordinationScore,
        source: 'huntrix_pump',
        detectedAt: Date.now(),
        expectedPeakMinutes: pumpStats?.median_peak_minutes ?? 10,
        maxHoldMinutes: 30,
    }), 'EX', 300); // 5 min TTL
}
```

### Change 3: Solanix reads huntrix:trade_signal

In Solanix scan loop, check for Huntrix signals:

```typescript
// In solanix agent scan loop:
const huntrixSignal = await redis.get('huntrix:trade_signal');
if (huntrixSignal) {
    const signal = JSON.parse(huntrixSignal);
    if (signal.action === 'BUY' && signal.confidence >= 70) {
        // Execute via Jupiter with tight exit (max 30 min hold)
        await this.executeHuntrixSignal(signal);
        await redis.del('huntrix:trade_signal'); // Consume
    }
}
```

## Files

| File | Change |
|------|--------|
| `packages/agents/src/huntrix/huntrix-agent.ts` | Add DexScreener fallback + signal relay |
| `packages/agents/src/solanix/solanix-agent.ts` | Read huntrix:trade_signal + execute |
| `huntrix.toml` | Add `[dex_bridge]` config |
