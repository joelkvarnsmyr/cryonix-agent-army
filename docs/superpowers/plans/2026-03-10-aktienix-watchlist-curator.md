# Aktienix WatchlistCurator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `WatchlistCurator` — a daily-refresh symbol discovery engine that replaces the static `aktienix.toml` watchlist with symbols sourced from Alpaca market movers, Grok thematic picks, and active macro signals.

**Architecture:** One new class (`WatchlistCurator`) with three data sources merged into a validated symbol list. Integrated into `AktienixAgent` with three lines of code. Falls back to static TOML list on any failure.

**Tech Stack:** TypeScript, Alpaca SDK (existing), OpenAI SDK pointing at xAI (existing), Vitest (existing).

**Spec:** `docs/superpowers/specs/2026-03-10-aktienix-watchlist-curator-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| CREATE | `packages/agents/src/aktienix/watchlist-curator.ts` | All discovery + validation logic |
| CREATE | `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts` | Unit tests |
| MODIFY | `packages/agents/src/aktienix/aktienix-agent.ts` | Wire curator into trading loop |
| MODIFY | `packages/agents/src/aktienix/index.ts` | Export `WatchlistCurator` |

---

## Chunk 1: WatchlistCurator core

### Task 1: Scaffold file + needsRefresh()

**Files:**
- Create: `packages/agents/src/aktienix/watchlist-curator.ts`
- Create: `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts`

- [ ] **Step 1: Write the failing tests for needsRefresh()**

```typescript
// packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WatchlistCurator } from '../watchlist-curator';

describe('WatchlistCurator.needsRefresh()', () => {
    it('returns true on first call (cold start)', () => {
        const curator = new WatchlistCurator(null, null, []);
        expect(curator.needsRefresh()).toBe(true);
    });

    it('returns false after a successful curate() on the same day', async () => {
        const curator = new WatchlistCurator(null, null, ['SPY', 'QQQ']);
        await curator.curate([]);
        expect(curator.needsRefresh()).toBe(false);
    });

    it('returns true the next calendar day', async () => {
        vi.useFakeTimers();
        const curator = new WatchlistCurator(null, null, ['SPY']);
        // Simulate yesterday's refresh
        vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));
        await curator.curate([]);
        // Advance to next day
        vi.setSystemTime(new Date('2026-03-11T10:00:00Z'));
        expect(curator.needsRefresh()).toBe(true);
        vi.useRealTimers();
    });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: FAIL — `WatchlistCurator` not found.

- [ ] **Step 3: Create the file with minimal scaffold**

```typescript
// packages/agents/src/aktienix/watchlist-curator.ts
import type { MacroSignal } from './intelligence/news-scanner';

export class WatchlistCurator {
    private lastRefreshDate: string | null = null;

    constructor(
        private readonly alpaca: any | null,
        private readonly xaiApiKey: string | null,
        private readonly fallbackSymbols: string[],
    ) {}

    needsRefresh(): boolean {
        const today = new Date().toISOString().slice(0, 10);
        return this.lastRefreshDate !== today;
    }

    async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
        const today = new Date().toISOString().slice(0, 10);
        this.lastRefreshDate = today;
        return this.fallbackSymbols;
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/watchlist-curator.ts packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
git commit -m "feat(aktienix): scaffold WatchlistCurator with needsRefresh()"
```

---

### Task 2: Source 3 — getMacroTickers()

**Files:**
- Modify: `packages/agents/src/aktienix/watchlist-curator.ts`
- Modify: `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts`

- [ ] **Step 1: Write failing tests for macro ticker extraction**

Add to the test file:

```typescript
import type { MacroSignal } from '../intelligence/news-scanner';

describe('WatchlistCurator — macro tickers', () => {
    const macroSignals: MacroSignal[] = [
        {
            event: 'oil_supply_shock',
            impact: 'bearish',
            sectors: ['energy', 'transport'],
            tickers: ['UAL', 'DAL', 'XOM', 'CVX'],
            confidence: 0.82,
            reasoning: 'OPEC cut',
        },
        {
            event: 'ai_chip_export_ban',
            impact: 'bullish',
            sectors: ['tech'],
            tickers: ['AMD', 'NVDA'],
            confidence: 0.75,
            reasoning: 'Export ban lifted',
        },
    ];

    it('extracts all tickers from active macro signals', async () => {
        const curator = new WatchlistCurator(null, null, []);
        const symbols = await curator.curate(macroSignals);
        expect(symbols).toContain('UAL');
        expect(symbols).toContain('DAL');
        expect(symbols).toContain('XOM');
        expect(symbols).toContain('AMD');
        expect(symbols).toContain('NVDA');
    });

    it('deduplicates tickers that appear in multiple signals', async () => {
        const signals: MacroSignal[] = [
            { event: 'a', impact: 'bearish', sectors: [], tickers: ['AAPL', 'MSFT'], confidence: 0.7, reasoning: '' },
            { event: 'b', impact: 'bullish', sectors: [], tickers: ['AAPL', 'GOOGL'], confidence: 0.7, reasoning: '' },
        ];
        const curator = new WatchlistCurator(null, null, []);
        const symbols = await curator.curate(signals);
        const aaplCount = symbols.filter(s => s === 'AAPL').length;
        expect(aaplCount).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: FAIL — macro tickers not included in curate() output.

- [ ] **Step 3: Implement getMacroTickers() and integrate into curate()**

```typescript
private getMacroTickers(signals: MacroSignal[]): string[] {
    const tickers = new Set<string>();
    for (const signal of signals) {
        for (const ticker of signal.tickers) {
            tickers.add(ticker);
        }
    }
    return Array.from(tickers);
}
```

Update `curate()` to merge macro tickers:

```typescript
async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const combined = new Set<string>(this.fallbackSymbols);

    // Source 3: Macro signal tickers
    for (const t of this.getMacroTickers(activeMacroSignals)) {
        combined.add(t);
    }

    this.lastRefreshDate = today;
    return Array.from(combined);
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/watchlist-curator.ts packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
git commit -m "feat(aktienix): WatchlistCurator extracts tickers from active macro signals"
```

---

### Task 3: Source 1 — Alpaca getMostActives()

**Files:**
- Modify: `packages/agents/src/aktienix/watchlist-curator.ts`
- Modify: `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts`

- [ ] **Step 0: Verify the SDK method exists**

Before implementing, confirm `getMostActiveStocks` is available in the installed SDK version:

```bash
node -e "const A = require('@alpacahq/alpaca-trade-api'); const a = new A({ keyId: 'x', secretKey: 'x', paper: true }); console.log(typeof a.data?.getMostActiveStocks);"
```

Expected: prints `function`. If it prints `undefined`, check the SDK docs and use the actual method name (e.g. `getTopMoversBars`, a REST fallback, or the `alpaca.getBars()` approach). Update the implementation in Step 3 accordingly.

- [ ] **Step 1: Write failing test with mocked Alpaca**

```typescript
describe('WatchlistCurator — Alpaca movers', () => {
    it('includes top-volume symbols from Alpaca when available', async () => {
        const mockAlpaca = {
            data: {
                getMostActiveStocks: vi.fn().mockResolvedValue([
                    { symbol: 'PLTR', volume: 90_000_000 },
                    { symbol: 'RIVN', volume: 75_000_000 },
                    { symbol: 'HOOD', volume: 60_000_000 },
                ]),
            },
        };
        const curator = new WatchlistCurator(mockAlpaca, null, []);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('PLTR');
        expect(symbols).toContain('RIVN');
        expect(symbols).toContain('HOOD');
    });

    it('falls back gracefully when Alpaca movers call fails', async () => {
        const mockAlpaca = {
            data: {
                getMostActiveStocks: vi.fn().mockRejectedValue(new Error('API unavailable')),
            },
        };
        const curator = new WatchlistCurator(mockAlpaca, null, ['SPY']);
        const symbols = await curator.curate([]);
        // Should not throw, should return fallback
        expect(symbols).toContain('SPY');
    });

    it('falls back gracefully when alpacaInstance is null', async () => {
        const curator = new WatchlistCurator(null, null, ['QQQ']);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('QQQ');
    });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: FAIL — Alpaca movers not implemented.

- [ ] **Step 3: Implement getAlpacaMovers()**

```typescript
private async getAlpacaMovers(): Promise<string[]> {
    if (!this.alpaca) return [];
    try {
        const actives = await this.alpaca.data.getMostActiveStocks({ by: 'volume', top: 30 });
        return actives.map((s: { symbol: string }) => s.symbol);
    } catch {
        return [];
    }
}
```

Update `curate()` to include Source 1:

```typescript
async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const combined = new Set<string>(this.fallbackSymbols);

    // Source 1: Alpaca volume movers
    for (const t of await this.getAlpacaMovers()) combined.add(t);

    // Source 3: Macro signal tickers
    for (const t of this.getMacroTickers(activeMacroSignals)) combined.add(t);

    this.lastRefreshDate = today;
    return Array.from(combined).slice(0, 60);
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/watchlist-curator.ts packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
git commit -m "feat(aktienix): WatchlistCurator adds Alpaca volume movers as source 1"
```

---

### Task 4: Source 2 — Grok thematic picks

**Files:**
- Modify: `packages/agents/src/aktienix/watchlist-curator.ts`
- Modify: `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts`

- [ ] **Step 1: Write failing test with mocked Grok**

`vi.mock()` calls must be hoisted to file top level (Vitest transforms them before imports). Add this at the very top of the test file, alongside the other imports:

```typescript
import { OpenAI } from 'openai';
import { vi, describe, it, expect } from 'vitest';

// MUST be at file top level — vi.mock() is hoisted by Vitest's transform
vi.mock('openai');
```

Then use `vi.mocked(OpenAI).mockImplementation(...)` inside each test:

```typescript
describe('WatchlistCurator — Grok picks', () => {
    it('includes Grok-discovered symbols when XAI key is provided', async () => {
        const mockGrokResponse = JSON.stringify([
            { symbol: 'COIN', reason: 'Crypto rally', sector: 'finance', catalyst: 'momentum' },
            { symbol: 'MRNA', reason: 'FDA catalyst', sector: 'health', catalyst: 'fda' },
        ]);

        vi.mocked(OpenAI).mockImplementation(() => ({
            chat: {
                completions: {
                    create: vi.fn().mockResolvedValue({
                        choices: [{ message: { content: mockGrokResponse } }],
                    }),
                },
            },
        }) as any);

        const curator = new WatchlistCurator(null, 'xai-fake-key', []);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('COIN');
        expect(symbols).toContain('MRNA');
    });

    it('falls back gracefully when Grok returns malformed JSON', async () => {
        vi.mocked(OpenAI).mockImplementation(() => ({
            chat: {
                completions: {
                    create: vi.fn().mockResolvedValue({
                        choices: [{ message: { content: 'not json at all' } }],
                    }),
                },
            },
        }) as any);

        const curator = new WatchlistCurator(null, 'xai-fake-key', ['SPY']);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('SPY'); // fallback preserved
    });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: FAIL — Grok not implemented.

- [ ] **Step 3: Implement getGrokPicks()**

```typescript
private async getGrokPicks(): Promise<string[]> {
    if (!this.xaiApiKey) return [];
    try {
        const grok = new OpenAI({ apiKey: this.xaiApiKey, baseURL: 'https://api.x.ai/v1' });
        const date = new Date().toISOString().slice(0, 10);
        const response = await grok.chat.completions.create({
            model: 'grok-3-latest',
            messages: [
                {
                    role: 'user',
                    content: `You are a US equity swing trading strategist. Today is ${date}.

Search X and financial news for the 20 most interesting US stocks to watch for swing trading TODAY. Focus on:
- High momentum AI/tech with strong recent moves or upcoming catalysts
- Biotech with FDA events, trial data, or earnings
- Stocks seeing unusual volume or short squeeze potential
- High-beta plays amplifying current market themes
- Turnaround stories in current news cycle

Return ONLY a JSON array, no other text:
[{"symbol": "TICKER", "reason": "...", "sector": "tech|health|finance|energy|consumer|other", "catalyst": "earnings|fda|momentum|squeeze|macro|other"}]

US stocks only. Max 20 entries.`,
                },
            ],
            // @ts-expect-error xAI-specific search parameter
            search: { mode: 'on' },
        });

        const content = response.choices[0]?.message?.content ?? '';
        // Extract JSON array — handle markdown code blocks
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];
        const picks = JSON.parse(jsonMatch[0]) as Array<{ symbol: string }>;
        return picks.map(p => p.symbol).filter(s => typeof s === 'string' && s.length > 0);
    } catch {
        return [];
    }
}
```

Update `curate()` to include Source 2:

```typescript
async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const combined = new Set<string>(this.fallbackSymbols);

    // Source 1: Alpaca volume movers
    for (const t of await this.getAlpacaMovers()) combined.add(t);

    // Source 2: Grok thematic picks
    for (const t of await this.getGrokPicks()) combined.add(t);

    // Source 3: Macro signal tickers
    for (const t of this.getMacroTickers(activeMacroSignals)) combined.add(t);

    this.lastRefreshDate = today;
    return Array.from(combined).slice(0, 60);
}
```

- [ ] **Step 4: Run all tests — expect pass**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Add import at top of file**

```typescript
import { OpenAI } from 'openai';
import type { MacroSignal } from './intelligence/news-scanner';
```

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/aktienix/watchlist-curator.ts packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
git commit -m "feat(aktienix): WatchlistCurator adds Grok thematic discovery as source 2"
```

---

### Task 5: Cap at 60 + log breakdown

**Files:**
- Modify: `packages/agents/src/aktienix/watchlist-curator.ts`
- Modify: `packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts`

- [ ] **Step 1: Write test for 60-symbol cap**

```typescript
describe('WatchlistCurator — cap and dedup', () => {
    it('never returns more than 60 symbols', async () => {
        // Provide 80 fallback symbols
        const bigList = Array.from({ length: 80 }, (_, i) => `SYM${i}`);
        const curator = new WatchlistCurator(null, null, bigList);
        const symbols = await curator.curate([]);
        expect(symbols.length).toBeLessThanOrEqual(60);
    });

    it('always includes fallback symbols at the start (priority seed)', async () => {
        const curator = new WatchlistCurator(null, null, ['SPY', 'QQQ']);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('SPY');
        expect(symbols).toContain('QQQ');
    });
});
```

- [ ] **Step 2: Run tests — expect pass (cap already implemented)**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
```
Expected: all tests PASS — `.slice(0, 60)` already handles this.

- [ ] **Step 3: Add optional logger for breakdown**

Add a logger parameter and breakdown log inside `curate()`:

```typescript
constructor(
    private readonly alpaca: any | null,
    private readonly xaiApiKey: string | null,
    private readonly fallbackSymbols: string[],
    private readonly logger?: { info: (msg: string) => void },
) {}
```

Inside `curate()`, after merging:

```typescript
this.logger?.info(
    `WatchlistCurator: ${combined.size} total symbols (fallback: ${this.fallbackSymbols.length}, movers: ${alpacaCount}, grok: ${grokCount}, macro: ${macroCount}) → capped at ${result.length}`
);
```

Track counts with local `let alpacaCount = 0` etc., increment when adding from each source.

- [ ] **Step 4: Run full test suite to check no regressions**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/watchlist-curator.ts packages/agents/src/aktienix/__tests__/watchlist-curator.test.ts
git commit -m "feat(aktienix): WatchlistCurator cap at 60 symbols + breakdown logging"
```

---

## Chunk 2: Integration

### Task 6: Export + wire into AktienixAgent

**Files:**
- Modify: `packages/agents/src/aktienix/index.ts`
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts`

- [ ] **Step 1: Add export to index.ts**

```typescript
// Add to packages/agents/src/aktienix/index.ts
export { WatchlistCurator } from './watchlist-curator';
```

- [ ] **Step 2: Add field to AktienixAgent**

In `aktienix-agent.ts`, alongside `private signalGenerator`:

```typescript
private watchlistCurator: WatchlistCurator | null = null;
```

Add import at top:

```typescript
import { WatchlistCurator } from './watchlist-curator';
```

- [ ] **Step 3: Initialize in initialize() — after Alpaca connects**

Inside the `if (this.tradingConfig.broker === 'alpaca')` block, after `this.signalGenerator = new StockSignalGenerator(...)`:

```typescript
this.watchlistCurator = new WatchlistCurator(
    this.alpacaInstance,
    process.env.XAI_API_KEY ?? null,
    this.tomlConfig.watchlist.symbols,
    loggerAdapter,
);
```

- [ ] **Step 4: Add refresh check in trading loop**

> **Note:** `loggerAdapter` is constructed inside `initialize()` and is not in scope inside `start()`. Fix this by storing it as a class field. Add this alongside the other private fields at the top of the class:
>
> ```typescript
> private loggerAdapter: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void } | null = null;
> ```
>
> Then in `initialize()`, assign it before it's used:
>
> ```typescript
> this.loggerAdapter = {
>     info: (msg: string) => this.log('info', msg),
>     warn: (msg: string) => this.log('warn', msg),
>     error: (msg: string) => this.log('error', msg),
>     debug: (msg: string) => this.log('info', msg),
> } as any;
> ```
>
> Replace all existing `loggerAdapter` references inside `initialize()` with `this.loggerAdapter`.

In the trading loop, just before step `// 8. Scan for TA signals`:

```typescript
// 7b. Refresh watchlist if new trading day
if (this.watchlistCurator?.needsRefresh() && this.signalGenerator && this.loggerAdapter) {
    const symbols = await this.watchlistCurator.curate(this.activeMacroSignals);
    this.signalGenerator = new StockSignalGenerator(
        this.alpacaInstance, this.loggerAdapter,
        { symbols, timeframe: config.watchlist.timeframe, barsCount: config.watchlist.bars_count }
    );
    this.log('info', `Watchlist refreshed: ${symbols.length} symbols`);
}
```

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @cryonix/agents exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Run full agent test suite**

```bash
pnpm vitest run packages/agents/src/aktienix/__tests__/
```
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/aktienix/aktienix-agent.ts packages/agents/src/aktienix/index.ts
git commit -m "feat(aktienix): integrate WatchlistCurator into AktienixAgent trading loop"
```

---

### Task 7: Smoke test

**Files:**
- Read: `scripts/aktienix/scan-signals.ts` (reference only)
- Create: `scripts/aktienix/test-watchlist-curator.ts`

- [ ] **Step 1: Create smoke test script**

```typescript
// scripts/aktienix/test-watchlist-curator.ts
// Run: npx tsx scripts/aktienix/test-watchlist-curator.ts
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import Alpaca from '@alpacahq/alpaca-trade-api';
import { WatchlistCurator } from '../../packages/agents/src/aktienix/watchlist-curator';

const FALLBACK = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'];

async function main() {
    console.log('=== WatchlistCurator Smoke Test ===\n');

    const alpaca = new (Alpaca as any)({
        keyId: process.env.ALPACA_PAPER_API_KEY,
        secretKey: process.env.ALPACA_PAPER_API_SECRET,
        paper: true,
    });

    const curator = new WatchlistCurator(
        alpaca,
        process.env.XAI_API_KEY ?? null,
        FALLBACK,
        { info: (msg: string) => console.log(msg) },
    );

    console.log('Running curate() with empty macro signals...\n');
    const symbols = await curator.curate([]);

    console.log(`\nResult: ${symbols.length} symbols`);
    console.log(symbols.join(', '));
    console.log('\nneedsRefresh() after curate:', curator.needsRefresh());
}

main().catch(console.error);
```

- [ ] **Step 2: Run smoke test**

```bash
npx tsx scripts/aktienix/test-watchlist-curator.ts
```
Expected: prints 30–60 symbols, `needsRefresh()` = `false`.

- [ ] **Step 3: Commit**

```bash
git add scripts/aktienix/test-watchlist-curator.ts
git commit -m "feat(aktienix): add WatchlistCurator smoke test script"
```

---

## Done

When all tasks are complete:
- `WatchlistCurator` refreshes the symbol list once per trading day
- Symbols come from Alpaca movers + Grok thematic picks + macro signal tickers
- `aktienix.toml` watchlist is always the fallback seed — agent never stops trading
- Full unit test coverage on all three sources and fallback paths

## Deferred — Out of Scope for This Plan

**Symbol validation against a known universe** (e.g. `ticker-universe.ts` filtering curated symbols against a whitelist of tradeable US equities) is explicitly deferred to a future plan. The spec (`docs/superpowers/specs/2026-03-10-aktienix-watchlist-curator-design.md`) acknowledges this gap. For now, symbols from all three sources are passed directly to `StockSignalGenerator`, which fetches bars from Alpaca — any invalid symbols will simply return 0 bars and produce no signals.
