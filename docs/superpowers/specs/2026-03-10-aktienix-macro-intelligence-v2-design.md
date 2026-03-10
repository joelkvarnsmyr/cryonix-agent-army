# Aktienix Macro Intelligence v2 — Design Spec

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Replace the current single-source (X/Twitter only) macro scanner with a dual-pipeline system that combines RSS feeds and X/Twitter as independent, mutually-validating inputs — enabling medium-term causal chain trading (days–weeks) across all major market sectors.

**Architecture:** Two independent ingestion pipelines (RSS + X) feed a shared LLM classifier. Signals cross-validate each other before entering a lifecycle tracker that drives phase-aware trading decisions (block buys → watch recovery → buy bottom).

**Tech Stack:** TypeScript, Grok API (xAI, existing), RSS parsing (no extra deps — native fetch + XML), Redis (existing), S&P 500 + Russell 1000 ticker universe (static JSON).

---

## Current State

`StockNewsScanner` → Grok X search → 7 hardcoded events in `MACRO_EVENT_MAP` → `MacroSignal[]`

**Gaps:**
- Single source (X only) — no RSS, no cross-validation
- Static event taxonomy — can't discover new event types
- No event lifecycle — events don't expire or transition to recovery
- 7 events covering only geo/oil/FED/trade/tech — missing transport, consumer, healthcare, housing, earnings
- No audit trail — can't see why a decision was made

---

## System Overview

```
RSS Pipeline (every 15-30min)                X Pipeline (every 15min)
Reuters, EIA, Fed, AP, MarketWatch           Grok X Search, curated accounts
        │                                            │
        ↓                                            ↓
NewsIngestionService                        XIngestionService
(fetch → dedup → normalize → RawArticle)   (xAI search → normalize → RawArticle)
        │                                            │
        └──────────────┬─────────────────────────────┘
                       ↓
              MacroClassifierAgent
              (Grok LLM batch classification)
              → causal chains, tickers, TTL, phase
                       │
              ValidationPipeline
              (ticker universe, confidence gates, source trust)
                       │
              SignalMerger
              (cross-validate RSS vs X signals)
                       │
              AuditLogger → Redis: aktienix:intelligence:audit
                       │
              EventLifecycleTracker
              (developing → resolving → resolved, re-evaluated every 2h)
                       │
              CausalChainEngine
              (phase-aware: BLOCK_BUY → WATCH_RECOVERY → BUY_SIGNAL)
                       │
              Redis: aktienix:macro:live_events
                       │
              AktienixAgent (one-line change, same MacroSignal[] interface)
```

---

## File Structure

Seven new files, existing files minimally touched:

```
packages/agents/src/aktienix/intelligence/
├── macro-sector-map.ts          (existing — expand with more sectors)
├── news-scanner.ts              (existing — DEPRECATED, replaced by XIngestionService)
├── x-accounts.ts                (existing — expand with more sector accounts)
├── news-ingestion-service.ts    (NEW — RSS fetch, dedup, normalize)
├── x-ingestion-service.ts       (NEW — xAI X search, normalize)
├── macro-classifier-agent.ts    (NEW — LLM batch classification + causal chains)
├── signal-merger.ts             (NEW — cross-validate RSS vs X signals)
├── event-lifecycle-tracker.ts   (NEW — detected → developing → resolving → resolved)
├── causal-chain-engine.ts       (NEW — phase-aware MacroSignal[] output)
├── ticker-universe.ts           (NEW — S&P 500 + Russell 1000 validation list)
├── audit-logger.ts              (NEW — append-only audit log to Redis)
└── macro-intelligence.ts        (NEW — facade: wires all components, exposes getLiveSignals())
```

Two files modified:
- `aktienix-agent.ts`: swap `newsScanner.scanMacroEvents()` for `macroIntelligence.getLiveSignals()`
- `macro-sector-map.ts`: add new event categories (energy, transport, healthcare, consumer, earnings)

**Legacy `news-scanner.ts`:** Deprecated by this change. `XIngestionService` covers its function with cleaner separation. Keep the file in place (do not delete) — `aktienix-agent.ts` will no longer import it after the migration.

---

## MacroIntelligence Facade

`macro-intelligence.ts` is the single entry point for `aktienix-agent.ts`. It owns the wiring of all components.

```typescript
export class MacroIntelligence {
    private rssIngestion: NewsIngestionService;
    private xIngestion: XIngestionService;
    private classifier: MacroClassifierAgent;
    private merger: SignalMerger;
    private lifecycleTracker: EventLifecycleTracker;
    private causalChain: CausalChainEngine;
    private auditLogger: AuditLogger;

    constructor(redisUrl: string, xaiApiKey: string) { ... }

    /**
     * Called by AktienixAgent every poll cycle.
     * Returns MacroSignal[] — same interface as the old StockNewsScanner.scanMacroEvents().
     * Phase-aware: signals can be bullish (buy opportunity) or bearish (block buys).
     */
    async getLiveSignals(): Promise<MacroSignal[]> { ... }

    /**
     * Called on a separate 15-minute interval by AktienixAgent.
     * Runs the full ingestion → classify → merge → lifecycle pipeline.
     */
    async runIntelligenceCycle(): Promise<void> { ... }
}
```

`getLiveSignals()` reads the current `aktienix:macro:event_states` from Redis and converts active events to `MacroSignal[]` via `CausalChainEngine`. It does not call Grok — that happens only in `runIntelligenceCycle()`.

`runIntelligenceCycle()` is the expensive operation (Grok calls, RSS fetch). Called every 15 minutes by the agent's existing `signal_scan_interval_ms` timer.

---

## Section 1: News Ingestion Layer

### RSS Sources

| Domain | URL | Interval |
|--------|-----|----------|
| General macro | `https://feeds.reuters.com/reuters/businessNews` | 15min |
| General macro | `https://rsshub.app/ap/topics/business` | 15min |
| Energy / oil | `https://www.eia.gov/rss/press_rss.xml` | 30min |
| Energy / oil | `https://feeds.reuters.com/reuters/energy` | 30min |
| Federal Reserve | `https://www.federalreserve.gov/feeds/press_all.xml` | 15min |
| Tech | `https://feeds.reuters.com/reuters/technologyNews` | 30min |
| Consumer / retail | `https://feeds.marketwatch.com/marketwatch/topstories` | 15min |
| Geopolitics | `https://feeds.reuters.com/Reuters/worldNews` | 15min |
| Healthcare | `https://feeds.reuters.com/reuters/healthNews` | 30min |

Note: Reuters and AP feed URLs are publicly accessible but subject to ToS — use responsibly (one request per interval, no hammering). EIA and Federal Reserve are official government feeds with no rate limits stated.

### `RawArticle` interface

```typescript
interface RawArticle {
    url: string;
    urlHash: string;            // SHA256 for dedup
    headline: string;
    summary: string;            // First 300 chars of body
    source: string;             // 'reuters' | 'eia' | 'ap' | ...
    sourceTrust: 'tier1' | 'tier2' | 'unknown';
    domain: string;             // 'energy' | 'fed' | 'geopolitics' | ...
    publishedAt: Date;
    pipeline: 'rss' | 'x';
}
```

### Source trust levels

- `tier1`: Reuters, AP, EIA, Federal Reserve — high credibility
- `tier2`: MarketWatch, Yahoo Finance, Benzinga — medium
- `unknown`: everything else — requires higher LLM confidence

### Deduplication logic

- Exact URL hash match → skip
- Headline similarity > 85% within 2h window → merge, confidence boost on classification
- Articles older than 48h → skip
- X posts older than 4h → skip (social media has short shelf life)

### Redis queue

Key: `aktienix:news:queue`
- Max 200 items (FIFO, oldest dropped)
- TTL: 48h
- Classifier drains queue every 15min

---

## Section 2: X Ingestion Service

Uses the existing xAI X Search API (same OpenAI SDK already in use). Runs independently of RSS on its own 15-minute cycle.

**Search strategy:**

```typescript
// Two searches per cycle:

// 1. Account-targeted: curated financial accounts
//    Uses handle filtering (max 10 accounts per call)
//    date_range: last 2 hours
//    Accounts: @WalterBloomberg, @DeItaone, @NickTimiraos, @EIAgov,
//              @JavierBlas, @OSINTdefender, @FirstSquawk, @unusual_whales

// 2. Semantic search: market-moving keywords
//    "breaking market" OR "rate decision" OR "oil supply" OR "earnings miss"
//    date_range: last 2 hours
```

Output normalized to same `RawArticle` format with `pipeline: 'x'`.

**X account expansion** (add to `x-accounts.ts`):

```typescript
transport: ['@FreightWaves', '@JOCdotcom'],
healthcare: ['@statnews', '@FiercePharma'],
consumer: ['@NRF_Retail', '@CNBC'],
earnings: ['@earningswhisper', '@RevengeOfNerds'],
```

---

## Section 3: LLM Classification + Causal Chains

`MacroClassifierAgent` reads from the Redis queue, batches 5-8 articles per Grok call, and outputs structured causal chains.

### Event types

**Known events** (mapped in `MACRO_EVENT_MAP`, lower confidence threshold):

| Category | Events |
|----------|--------|
| Energy | `oil_supply_shock`, `gas_price_surge`, `energy_transition` |
| Macro | `fed_rate_hike`, `fed_rate_cut`, `inflation_surge`, `recession_fear` |
| Geopolitics | `middle_east_conflict`, `china_taiwan_tension`, `ukraine_russia_escalation` |
| Trade | `trade_war_tariffs`, `port_strike`, `shipping_disruption` |
| Tech | `tech_antitrust`, `ai_chip_export_ban`, `semiconductor_shortage` |
| Healthcare | `pandemic_fear`, `drug_approval_major`, `healthcare_reform` |
| Consumer | `consumer_confidence_drop`, `retail_sales_miss`, `housing_slowdown` |
| Transport | `airline_fuel_shock`, `logistics_disruption` |
| Earnings | `sector_earnings_beat`, `sector_earnings_miss` |

**Emergent events** (LLM-named dynamically, higher confidence threshold):
- Free-form slug: `"bird_flu_outbreak"`, `"port_strike_us_east"`, `"ai_chip_export_ban"`
- Confidence >= 0.80 required
- TTL capped at 24h until confirmed by second pipeline

### Classification prompt structure

```
You are a macro economist and portfolio strategist.

Analyze these news articles and identify market-moving events.

For each event, generate:
1. event_id: short slug (known event ID or new descriptive slug)
2. category: 'known' | 'emergent'
3. causal_chain:
   - immediate (hours-days): affected tickers NOW (bullish/bearish)
   - secondary (days-weeks): recovery tickers to watch, watch_after_days
   - resolution_signal: what does it mean when this event is OVER?
4. affected_tickers: max 10, NYSE/NASDAQ only
5. confidence: 0.0-1.0
6. reasoning: 2-3 sentences citing the source
7. phase: 'developing' | 'resolving' | 'resolved'
8. ttl_hours: 24-168
9. market_moving: boolean (would this cause >1% sector move?)

Return JSON array only. If nothing is market-moving, return [].
```

### Causal chain data structure

```typescript
interface CausalChain {
    triggerEvent: string;
    immediate: {
        bearishTickers: string[];
        bullishTickers: string[];
        reasoning: string;
    };
    secondary: {
        recoveryWatchTickers: string[];   // Watch these for TA bottom signals
        watchAfterDays: number;           // Don't watch until N days in
        reasoning: string;
    };
    resolutionSignal: string;            // Human-readable: "WTI falls below $X"
}
```

### Example output (oil supply shock)

```json
{
  "event_id": "opec_surprise_cut_march2026",
  "category": "emergent",
  "causal_chain": {
    "immediate": {
      "bearish_tickers": ["UAL", "DAL", "AAL", "FDX", "UPS"],
      "bullish_tickers": ["XOM", "CVX", "XLE", "USO"],
      "reasoning": "Fuel costs surge immediately for transport sector"
    },
    "secondary": {
      "recovery_watch_tickers": ["UAL", "DAL", "AAL"],
      "watch_after_days": 4,
      "reasoning": "Airlines historically bottom 3-7 days after oil spike as hedge contracts kick in"
    },
    "resolution_signal": "WTI crude falls back below spike level OR RSI < 32 on airlines"
  },
  "confidence": 0.84,
  "ttl_hours": 96,
  "market_moving": true
}
```

---

## Section 4: Validation Pipeline

Every `MacroSignal` from the LLM must pass all steps in order. One failed step drops the signal.

### Step 1 — Ticker Universe Check

All tickers validated against a static embedded list in `ticker-universe.ts` (~1500 symbols: S&P 500 + Russell 1000). The list is a hardcoded TypeScript `Set<string>` export — no file reads, no API calls, no extra dependencies. Updated manually each quarter when index compositions change (next update: June 2026 rebalancing).

Unknown ticker → removed from signal. Zero valid tickers remaining → signal dropped.

### Step 2 — Source Trust Multiplier (applied first)

Applied to the raw LLM confidence score before any gate check:

| Trust level | Multiplier |
|-------------|-----------|
| `tier1` (Reuters, EIA, Fed) | ×1.00 |
| `tier2` (Yahoo, MarketWatch) | ×0.90 |
| `unknown` | ×0.75 |

### Step 3 — Cross-Validation Delta (applied second, from SignalMerger)

Applied to the trust-adjusted confidence:

| Corroboration status | Delta | Set by |
|---------------------|-------|--------|
| `confirmed` (both pipelines, exact event_id, same direction) | +0.15 | SignalMerger |
| `confirmed_weak` (both pipelines, category match only, same direction) | +0.08 | SignalMerger |
| `rss_only` | ±0.00 | SignalMerger |
| `social_only` (X only, no RSS) | −0.10 | SignalMerger |
| `conflicting` (both pipelines, opposite direction) | −0.20 | SignalMerger |

`SignalMerger` sets the corroboration status and the corresponding delta before the signal enters the Validation Pipeline. Step 3 reads the delta from the signal object — it does not recalculate it.

### Step 4 — Confidence Gate (applied last, on fully adjusted confidence)

| Event type + corroboration | Minimum adjusted confidence |
|---------------------------|----------------------------|
| Known event, `confirmed` | 0.50 |
| Known event, `rss_only` | 0.50 |
| Known event, `social_only` | 0.60 |
| Emergent event, `confirmed` | 0.75 |
| Emergent event, any other | 0.80 |
| Any event, `conflicting` | 0.85 |

Example: emergent event, X only (social_only), tier2 source. Raw LLM conf = 0.88 → ×0.90 = 0.79 → −0.10 = 0.69 → gate requires 0.80 → **rejected**.

### Step 5 — Temporal Relevance

- RSS article > 48h old → dropped
- X post > 4h old → dropped

### Step 6 — Market Impact Sanity

`market_moving: false` in LLM output → dropped regardless of confidence.

### Step 7 — Audit Entry

Every signal (accepted or rejected) logged:

```typescript
interface AuditEntry {
    id: string;                           // nanoid, referenced by LiveEvent.auditIds
    timestamp: string;                    // ISO8601
    event_id: string;
    sources: string[];                    // ["reuters", "x_@WalterBloomberg"]
    corroboration: 'confirmed' | 'rss_only' | 'social_only' | 'conflicting';
    validation_steps: {
        step: string;
        passed: boolean;
        reason?: string;
    }[];
    final_decision: 'accepted' | 'rejected';
    confidence_raw: number;               // Raw LLM output
    confidence_trust_adjusted: number;    // After source trust multiplier
    confidence_corroboration_adjusted: number; // After cross-validation delta
    confidence_final: number;             // Final value checked against gate
}
```

**Redis storage:** `aktienix:intelligence:audit` as a **List** (RPUSH new entries, LTRIM to 10,000 entries). Entries are JSON-serialized. Dashboard reads with LRANGE. Effective rolling window: at 1 entry/15min, 10,000 entries ≈ 100 days.

---

## Section 5: Cross-Validation (SignalMerger)

RSS and X run independently. `SignalMerger` matches signals from both pipelines and assigns a corroboration status.

### Matching algorithm

1. **Exact event_id match**: if both pipelines produce the same slug (e.g., `oil_supply_shock`), they are matched directly.
2. **Known-event category match**: if one pipeline produces `oil_supply_shock` and the other produces an emergent slug classified under the same known event category (energy), treat as a match with a `category_match: true` flag (lowers confidence bonus to +0.08 instead of +0.15).
3. **No match within 2h window**: signals from one pipeline with no corresponding signal from the other within a 2-hour publication window are treated as pipeline-only signals (`rss_only` or `social_only`).
4. **Direction conflict**: matched event_id but `impact` fields disagree (one bullish, one bearish) → `conflicting`.

| RSS | X | Result |
|-----|---|--------|
| ✅ | ✅ same event_id + same direction | `confirmed` |
| ✅ | ✅ category match + same direction | `confirmed` (weaker) |
| ✅ | ❌ no match within 2h | `rss_only` |
| ❌ | ✅ no match within 2h | `social_only` |
| ✅ | ✅ same event_id + opposite direction | `conflicting` |

Each stored event includes `sources: string[]` for full traceability (e.g., `["reuters", "x_@WalterBloomberg"]`).

---

## Section 6: Event Lifecycle Tracker

**`EventLifecycleTracker`** re-evaluates all active events every 2 hours.

### Lifecycle states

```
detected → developing → resolving → resolved
```

- **detected**: first signal accepted by ValidationPipeline. Written to Redis immediately. Not yet traded on.
- **developing**: confirmed by a second signal from either pipeline within 2h. `BLOCK_BUY` becomes active.
- **resolving**: confidence decays to < 0.55 through natural decay OR re-evaluation returns `phase: 'resolving'`. Recovery watch activates after `watchAfterDays`.
- **resolved**: confidence < 0.30 OR re-evaluation returns `phase: 'resolved'`. Recovery BUY signals can fire.

### State transitions

- **detected → developing**: second pipeline confirms same event within 2h window
- **developing → resolving**: every 2h, confidence ×0.85 decay if no new confirming articles; OR Grok re-evaluation prompt returns `phase: 'resolving'`
- **resolving → resolved**: confidence falls below 0.30 OR re-evaluation prompt returns `phase: 'resolved'`
- **resolved**: `CausalChainEngine` starts emitting `WATCH_RECOVERY` signals for secondary tickers

### Lifecycle re-evaluation prompt

Run every 2 hours per active event against Grok with `search: { mode: 'on' }`:

```
Current event: [event_id] — [description]
This event was detected [N hours] ago with confidence [X].
Original reasoning: [reasoning]

Search X and the latest news for evidence that this event is:
- Still actively developing (return phase: "developing")
- Starting to stabilize or resolve (return phase: "resolving")
- Over / normalized (return phase: "resolved")

Cite specific recent evidence (last 4 hours). If no relevant new posts found, return phase: "resolving".

Return JSON only: { "phase": "developing"|"resolving"|"resolved", "evidence": "...", "confidence": 0.0-1.0 }
```

If Grok call fails or times out: apply confidence ×0.85 decay and keep current phase unchanged.

### Redis storage

```typescript
// Key: aktienix:macro:event_states (JSON string, single object)
// Type: Redis Hash — one key per event_id for O(1) updates
interface LiveEvent {
    event_id: string;
    phase: 'detected' | 'developing' | 'resolving' | 'resolved';
    causal_chain: CausalChain;
    sources: string[];
    corroboration: 'confirmed' | 'rss_only' | 'social_only' | 'conflicting';
    confidence: number;
    detectedAt: string;         // ISO8601
    expiresAt: string;          // ISO8601
    lastEvaluatedAt: string;    // ISO8601
    auditIds: string[];         // References to AuditEntry.id values
}
```

Redis structure: `HSET aktienix:macro:event_states [event_id] [JSON]` — one hash field per active event. `HGETALL` to read all active events. Events expire by checking `expiresAt` field on read (no native Redis TTL, to avoid race conditions with lifecycle updates).

---

## Section 7: CausalChainEngine + Trading Integration

**Phase-aware signal output:**

```typescript
// Phase DEVELOPING: block buys on bearish tickers
{ action: 'BLOCK_BUY', tickers: ['UAL', 'DAL', 'AAL'],
  reason: 'oil_supply_shock developing', confidence: 0.84 }

// Phase RESOLVING + past watchAfterDays: activate TA watch
{ action: 'WATCH_RECOVERY', tickers: ['UAL', 'DAL'],
  condition: 'RSI < 32 AND price below lower Bollinger' }

// Phase RESOLVED + TA confirms bottom: emit buy signal
{ action: 'BUY_SIGNAL', ticker: 'UAL', confidence: 0.72,
  reasoning: 'Oil shock resolved. RSI=28, below Bollinger lower. Recovery entry.' }
```

### MacroSignal interface compatibility

The existing `MacroSignal` interface in `news-scanner.ts` uses `impact: 'bullish' | 'bearish' | 'neutral'`. The existing `evaluateSignal()` in `aktienix-agent.ts` branches on `macro.impact`.

`CausalChainEngine` maps its internal phase-aware actions to this interface as follows:

| CausalChainEngine internal action | MacroSignal.impact | MacroSignal.tickers |
|-----------------------------------|--------------------|---------------------|
| `BLOCK_BUY` (developing phase) | `'bearish'` | `causal_chain.immediate.bearishTickers` |
| `WATCH_RECOVERY` (resolving phase, not yet TA-confirmed) | `'neutral'` | `causal_chain.secondary.recoveryWatchTickers` |
| `BUY_SIGNAL` (resolved + TA confirmed) | `'bullish'` | `[ticker]` (single, TA-confirmed) |

`WATCH_RECOVERY` signals with `impact: 'neutral'` are emitted but result in no trade action from the current agent — they serve as a "warming up" signal that primes the TA scanner to pay attention to these tickers. The `aktienix-agent.ts` evaluateSignal() already handles `neutral` as a no-op.

`MacroSignal` interface does **not** need to change. The adapter lives entirely inside `CausalChainEngine.toMacroSignal()`.

**Integration with `AktienixAgent`** — two changes:

```typescript
// Change 1 — constructor: add MacroIntelligence
this.macroIntelligence = new MacroIntelligence(redisUrl, process.env.XAI_API_KEY);

// Change 2 — replace scanner call (one line):
// Before:
const macroSignals = await this.newsScanner.scanMacroEvents();
// After:
const macroSignals = await this.macroIntelligence.getLiveSignals();

// Note: runIntelligenceCycle() is called by the existing signal_scan_interval_ms timer:
await this.macroIntelligence.runIntelligenceCycle(); // replaces old newsScanner call in scan block
```

No changes to `evaluateSignal()`, `applyMacroBoost()`, or any other agent logic.

---

## Expanded Watchlist (aktienix.toml)

Add energy and transport tickers to enable causal chain trading:

```toml
symbols = [
    # Tech
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA",
    # ETFs
    "SPY", "QQQ",
    # Financials / Healthcare
    "JPM", "JNJ",
    # Energy — benefits from oil price rises
    "XOM", "CVX", "XLE", "USO",
    # Airlines — recovery plays after oil shocks
    "UAL", "DAL",
    # Logistics — affected by shipping/trade disruptions
    "FDX", "UPS",
]
```

---

## API Cost Budget

Grok calls happen in two places:
1. **`MacroClassifierAgent`**: batches of 5-8 articles → ~1 call per 15min cycle if queue is non-empty. Max ~96 calls/day.
2. **`EventLifecycleTracker`**: 1 call per active event per 2h re-evaluation cycle. With max ~10 concurrent active events, max ~120 calls/day.

**Total: ~216 Grok calls/day worst case.** At typical xAI pricing, this is negligible (<$1/day). If the Grok API returns a rate limit error (HTTP 429), the classifier skips that cycle and logs a warning — no retry storm. The lifecycle tracker applies confidence ×0.85 decay passively if the call fails.

---

## What This Is NOT

- Not a real-time HFT system — medium-term (days-weeks) only
- Not a sentiment analysis tool — only actionable market-moving events
- Not a replacement for TA — macro signals augment, not replace, RSI/MACD/BB analysis
- No short selling — aktienix is long-only on a cash account; bearish signals block buys, not open shorts

---

## Testing Strategy

Each new module has a unit test file alongside it:

- `news-ingestion-service.test.ts` — mock RSS feed responses, verify dedup and normalization
- `x-ingestion-service.test.ts` — mock xAI response, verify normalization
- `macro-classifier-agent.test.ts` — mock Grok response, verify causal chain parsing
- `event-lifecycle-tracker.test.ts` — state machine transitions, confidence decay
- `causal-chain-engine.test.ts` — phase-aware signal generation
- `ticker-universe.test.ts` — validation against known good/bad tickers
- `audit-logger.test.ts` — verify audit entries written correctly

Integration smoke test: `scripts/aktienix/test-macro-intelligence.ts` — runs full pipeline end-to-end with mock articles, prints audit log and final signals.
