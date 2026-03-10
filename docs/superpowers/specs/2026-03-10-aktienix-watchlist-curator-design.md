# Aktienix WatchlistCurator — Design Spec

**Goal:** Replace the static `aktienix.toml` symbol list with an autonomous daily-refresh system that combines Alpaca market movers, Grok thematic discovery, and active macro intelligence to select the 40–60 most interesting symbols each trading day.

---

## Architecture

One new file. Three additions to `aktienix-agent.ts`.

```
packages/agents/src/aktienix/
└── watchlist-curator.ts    (NEW)

packages/agents/src/aktienix/aktienix-agent.ts   (3-line change)
```

---

## WatchlistCurator

```typescript
export class WatchlistCurator {
    constructor(alpacaInstance: any, xaiApiKey: string | null) {}

    // Returns true on new trading date or cold start
    needsRefresh(): boolean {}

    // Discovers and validates today's watchlist
    async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {}
}
```

### curate() — three sources, merged

**Source 1 — Alpaca getMostActives (top 30)**
- Calls `alpaca.data.getStocksMostActives({ by: 'volume', top: 30 })`
- Falls back silently if endpoint unavailable (paper account limitation)
- Provides factual volume-based signal: something is moving today

**Source 2 — Grok thematic discovery (20 picks)**
- Single Grok call with `search: { mode: 'on' }`
- Prompt asks for 20 US stocks interesting for swing trading today
- Returns structured JSON: `[{ symbol, reason, sector, catalyst }]`
- Falls back to empty list if XAI_API_KEY missing or call fails

**Source 3 — Active macro signal tickers**
- Reads `activeMacroSignals[]` passed in from the agent
- Extracts tickers from all three causal chain layers:
  - `immediate.bullishTickers` — buy candidates now
  - `immediate.bearishTickers` — watch for recovery entry
  - `secondary.recoveryWatchTickers` — watch after event resolves
- Future (v2): reads directly from `aktienix:macro:event_states` Redis key instead
- The interface `getMacroTickers(signals)` isolates this change to one method

### Merge + Validation

1. Combine all three sources → deduplicate
2. Validate each symbol against `ticker-universe.ts` (S&P 500 + Russell 1000 static set)
3. For unknowns not in universe: call `alpaca.getAsset(symbol)` to confirm tradability
4. Cap at 60 symbols (keeps signal scan under ~30 seconds)
5. Always include `aktienix.toml` core list as non-removable seed

### Grok prompt

```
You are a US equity swing trading strategist. Today is {date}.

Search X and financial news for the 20 most interesting US stocks to
watch for swing trading TODAY. Focus on:
- High momentum AI/tech with strong recent moves or upcoming catalysts
- Biotech with FDA events, trial data, or earnings
- Stocks seeing unusual volume or short squeeze potential
- High-beta plays amplifying current market themes
- Turnaround stories in current news cycle

Return ONLY a JSON array, no other text:
[{"symbol": "TICKER", "reason": "...", "sector": "tech|health|finance|energy|consumer|other", "catalyst": "earnings|fda|momentum|squeeze|macro|other"}]

US stocks only. Max 20 entries.
```

### needsRefresh()

```typescript
private lastRefreshDate: string | null = null;

needsRefresh(): boolean {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return this.lastRefreshDate !== today;
}
```

Refreshes once per calendar day. `lastRefreshDate` is set to today after a successful `curate()` call.

---

## Integration — AktienixAgent (3 changes)

```typescript
// 1. New field (alongside signalGenerator)
private watchlistCurator: WatchlistCurator | null = null;

// 2. In initialize(), after Alpaca connects
this.watchlistCurator = new WatchlistCurator(
    this.alpacaInstance,
    process.env.XAI_API_KEY ?? null,
);

// 3. In trading loop, before signal scan block (step 8)
if (this.watchlistCurator?.needsRefresh() && this.signalGenerator) {
    const symbols = await this.watchlistCurator.curate(this.activeMacroSignals);
    this.signalGenerator = new StockSignalGenerator(
        this.alpacaInstance, loggerAdapter,
        { symbols, timeframe: config.watchlist.timeframe, barsCount: config.watchlist.bars_count }
    );
    this.log('info', `Watchlist refreshed: ${symbols.length} symbols`);
}
```

Only runs when Alpaca broker is active (`this.signalGenerator !== null`). Mock and IBKR brokers are unaffected.

---

## Fallback chain

| Failure | Behaviour |
|---------|-----------|
| Alpaca movers unavailable | Skip source 1, continue with sources 2+3 |
| Grok call fails / no key | Skip source 2, continue with sources 1+3 |
| Macro signals empty | Skip source 3, continue with sources 1+2 |
| All three sources empty | Use `aktienix.toml` static list unchanged |
| curate() throws | Log error, keep existing signalGenerator, retry next day |

The agent never stops trading due to curator failures.

---

## Future: v2 macro integration

When `MacroIntelligence` (v2 design) is built, `getMacroTickers()` changes from:

```typescript
// Today: reads passed-in MacroSignal[]
private getMacroTickers(signals: MacroSignal[]): string[] { ... }
```

To:

```typescript
// v2: reads Redis aktienix:macro:event_states directly
private async getMacroTickers(): Promise<string[]> {
    const events = await this.redis.hgetall('aktienix:macro:event_states');
    // extract causal chain tickers from LiveEvent objects
}
```

`curate()` signature does not change for the agent — it still receives `activeMacroSignals[]` as a parameter (v2 will just pass an empty array since tickers are read from Redis internally).

---

## Timing

- Runs at first loop iteration after market open (typically ~09:15 ET)
- `needsRefresh()` checks date only — no clock arithmetic needed
- One Grok call per day: ~$0.01 cost
- Alpaca movers: free REST call, no rate limit concern

---

## What this is NOT

- Not a screener that runs every 15 minutes
- Not a replacement for TA signal generation (WatchlistCurator only picks *which* symbols to scan, not *when* to trade them)
- Not dependent on v2 macro intelligence — works with current `StockNewsScanner` output today
