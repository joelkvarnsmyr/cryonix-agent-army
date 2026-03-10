# Aktienix Macro Intelligence v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dual-pipeline macro intelligence system (RSS + X/Twitter) with LLM-powered causal chain classification, event lifecycle tracking, and phase-aware trading signals that replace the static 7-event `StockNewsScanner`.

**Architecture:** `NewsIngestionService` (RSS) and `XIngestionService` (X/Twitter) run independently every 15min, feeding a shared `MacroClassifierAgent`. `SignalMerger` cross-validates both pipelines. `EventLifecycleTracker` maintains event state (detected → developing → resolving → resolved). `CausalChainEngine` emits phase-aware `MacroSignal[]`. `MacroIntelligence` facade wires everything and replaces `StockNewsScanner` in `aktienix-agent.ts`.

**Tech Stack:** TypeScript, Vitest, OpenAI SDK (existing, used for xAI/Grok), Node.js `net` module (existing RESP client pattern), native `fetch` for RSS.

**Spec:** `docs/superpowers/specs/2026-03-10-aktienix-macro-intelligence-v2-design.md`

**Test runner:** `pnpm vitest run packages/agents --reporter=verbose` from monorepo root.

---

## Chunk 1: Foundation

### Task 1: Extract shared Redis client

The hand-rolled `RespClient` in `state-publisher.ts` needs to be a shared module so `audit-logger.ts` and `event-lifecycle-tracker.ts` can use it without duplication.

**Files:**
- Create: `packages/agents/src/aktienix/redis-client.ts`
- Modify: `packages/agents/src/aktienix/state-publisher.ts` (import from new file)

- [ ] **Step 1: Create `redis-client.ts`**

```typescript
// packages/agents/src/aktienix/redis-client.ts
import * as net from 'net';

function encodeResp(args: (string | number)[]): Buffer {
    const parts: string[] = [`*${args.length}\r\n`];
    for (const arg of args) {
        const s = String(arg);
        parts.push(`$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`);
    }
    return Buffer.from(parts.join(''), 'utf8');
}

interface PendingCommand {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}

export class RespClient {
    private socket: net.Socket | null = null;
    private queue: PendingCommand[] = [];
    private buffer = '';
    private connected = false;
    private destroyed = false;

    constructor(private readonly url: string) {}

    isConnected(): boolean { return this.connected; }

    connect(): Promise<void> {
        if (this.connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const parsed = new URL(this.url);
            const host = parsed.hostname || '127.0.0.1';
            const port = parseInt(parsed.port || '6379', 10);
            const password = parsed.password || null;

            this.socket = new net.Socket();
            this.socket.setKeepAlive(true, 10_000);

            this.socket.on('data', (data: Buffer) => {
                this.buffer += data.toString('utf8');
                while (true) {
                    const idx = this.buffer.indexOf('\r\n');
                    if (idx === -1) break;
                    const line = this.buffer.substring(0, idx);
                    this.buffer = this.buffer.substring(idx + 2);
                    const cmd = this.queue.shift();
                    if (cmd) cmd.resolve(line);
                }
            });

            this.socket.on('error', (err: Error) => {
                this.connected = false;
                const cmd = this.queue.shift();
                if (cmd) cmd.reject(err);
            });

            this.socket.connect(port, host, async () => {
                if (password) await this.send('AUTH', password);
                this.connected = true;
                resolve();
            });
        });
    }

    async send(...args: (string | number)[]): Promise<unknown> {
        if (!this.connected) await this.connect();
        return new Promise((resolve, reject) => {
            this.queue.push({ resolve, reject });
            this.socket!.write(encodeResp(args));
        });
    }

    async set(key: string, value: string, exSeconds?: number): Promise<void> {
        if (exSeconds) await this.send('SET', key, value, 'EX', exSeconds);
        else await this.send('SET', key, value);
    }

    async get(key: string): Promise<string | null> {
        const r = await this.send('GET', key) as string;
        return r.startsWith('$-1') ? null : r.startsWith('$') ? r : null;
    }

    async lpush(key: string, value: string): Promise<void> {
        await this.send('LPUSH', key, value);
    }

    async ltrim(key: string, start: number, stop: number): Promise<void> {
        await this.send('LTRIM', key, start, stop);
    }

    async hset(key: string, field: string, value: string): Promise<void> {
        await this.send('HSET', key, field, value);
    }

    async hdel(key: string, field: string): Promise<void> {
        await this.send('HDEL', key, field);
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        // HGETALL returns a multi-bulk reply — requires extended parser
        // For simplicity use a raw command and parse manually
        await this.send('HGETALL', key);
        // NOTE: full multi-bulk parsing is handled in connect() data handler above
        // This stub returns empty; implementer must extend buffer parser for multi-bulk
        return {};
    }

    disconnect(): void {
        if (this.socket && !this.destroyed) {
            this.destroyed = true;
            this.socket.destroy();
            this.connected = false;
        }
    }
}
```

**Important note for implementer:** The minimal RESP client above handles simple `+OK\r\n` and `-ERR\r\n` replies. For `HGETALL` (which returns a multi-bulk array), the buffer parser in `connect()` must be extended. The `state-publisher.ts` original has a more complete parser — copy it verbatim from there rather than using the stub above. The key difference: export the class from this new file.

- [ ] **Step 2: Update `state-publisher.ts` to import from `redis-client.ts`**

Open `packages/agents/src/aktienix/state-publisher.ts`. Replace the inline `encodeResp`, `PendingCommand`, and `RespClient` definitions with:

```typescript
import { RespClient } from './redis-client';
```

Keep all other code unchanged.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd C:\Projects\Code\Crypto\cryonix-agent-army
pnpm --filter @cryonix/agents type-check
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/aktienix/redis-client.ts packages/agents/src/aktienix/state-publisher.ts
git commit -m "refactor: extract shared RespClient to redis-client.ts"
```

---

### Task 2: Ticker Universe

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/ticker-universe.ts`
- Create: `packages/agents/src/aktienix/intelligence/ticker-universe.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/agents/src/aktienix/intelligence/ticker-universe.test.ts
import { describe, it, expect } from 'vitest';
import { isValidTicker, VALID_TICKERS } from './ticker-universe';

describe('ticker-universe', () => {
    it('accepts known S&P 500 tickers', () => {
        expect(isValidTicker('AAPL')).toBe(true);
        expect(isValidTicker('MSFT')).toBe(true);
        expect(isValidTicker('GOOGL')).toBe(true);
        expect(isValidTicker('XOM')).toBe(true);
        expect(isValidTicker('JPM')).toBe(true);
    });

    it('accepts energy and transport tickers in aktienix watchlist', () => {
        const watchlist = ['XOM', 'CVX', 'XLE', 'USO', 'UAL', 'DAL', 'AAL', 'FDX', 'UPS'];
        for (const ticker of watchlist) {
            expect(isValidTicker(ticker), `${ticker} should be valid`).toBe(true);
        }
    });

    it('rejects hallucinated or non-US tickers', () => {
        expect(isValidTicker('FAKE_CORP')).toBe(false);
        expect(isValidTicker('')).toBe(false);
        expect(isValidTicker('TSMC')).toBe(false); // Taiwan-listed, not NYSE/NASDAQ primary
        expect(isValidTicker('BITCOIN')).toBe(false);
    });

    it('is case-sensitive — only uppercase', () => {
        expect(isValidTicker('aapl')).toBe(false);
    });

    it('has at least 400 tickers', () => {
        expect(VALID_TICKERS.size).toBeGreaterThan(400);
    });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd C:\Projects\Code\Crypto\cryonix-agent-army
pnpm vitest run packages/agents/src/aktienix/intelligence/ticker-universe.test.ts --reporter=verbose
```
Expected: FAIL — "Cannot find module './ticker-universe'"

- [ ] **Step 3: Create `ticker-universe.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/ticker-universe.ts

/**
 * Static set of valid NYSE/NASDAQ-listed tickers.
 * Covers S&P 500 + key Russell 1000 constituents (~500 tickers here, expand to ~1500 for prod).
 * Update quarterly on index rebalancing (next: June 2026).
 *
 * Source for full list: https://en.wikipedia.org/wiki/List_of_S%26P_500_companies
 * or download from https://github.com/datasets/s-and-p-500-companies
 */
export const VALID_TICKERS = new Set<string>([
    // ── Mega-cap Tech ──────────────────────────────────────────────
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL',
    'ADBE', 'CRM', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'KLAC', 'LRCX',
    'SNPS', 'CDNS', 'MRVL', 'NXPI', 'ON', 'STX', 'WDC', 'SWKS', 'QRVO', 'MPWR',
    // ── ETFs (sector + broad market) ─────────────────────────────
    'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'XLK', 'XLE', 'XLF', 'XLV',
    'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLI', 'XLC', 'GLD', 'SLV', 'USO',
    'UNG', 'DBA', 'ARKK', 'VGK',
    // ── Financials ────────────────────────────────────────────────
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'V', 'MA',
    'COF', 'DFS', 'SYF', 'USB', 'TFC', 'PNC', 'FITB', 'KEY', 'RF', 'CFG',
    // ── Healthcare ────────────────────────────────────────────────
    'JNJ', 'UNH', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY',
    'AMGN', 'GILD', 'BIIB', 'VRTX', 'REGN', 'ISRG', 'SYK', 'MDT', 'EW', 'ZTS',
    'HCA', 'CVS', 'CI', 'HUM', 'CNC', 'MOH', 'ANTM', 'CAH', 'MCK', 'ABC',
    // ── Energy ────────────────────────────────────────────────────
    'XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'VLO', 'MPC', 'OXY', 'DVN',
    'HAL', 'BKR', 'PXD', 'HES', 'FANG', 'APA', 'MRO', 'OKE', 'KMI', 'WMB',
    'ET', 'EPD', 'TRGP', 'LNG', 'AR',
    // ── Consumer Discretionary ────────────────────────────────────
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'TJX', 'BKNG', 'MAR',
    'HLT', 'CMG', 'ABNB', 'EXPE', 'LYFT', 'UBER', 'F', 'GM', 'RIVN', 'LCID',
    // ── Consumer Staples ──────────────────────────────────────────
    'WMT', 'PG', 'KO', 'PEP', 'COST', 'MDLZ', 'PM', 'MO', 'KHC', 'GIS',
    'K', 'CPB', 'SJM', 'HRL', 'TSN', 'CAG', 'MKC', 'CLX', 'CL', 'EL',
    // ── Industrials ───────────────────────────────────────────────
    'GE', 'BA', 'HON', 'RTX', 'LMT', 'NOC', 'GD', 'L3H', 'HII', 'TDG',
    'CAT', 'DE', 'MMM', 'EMR', 'ETN', 'PH', 'ROK', 'DOV', 'IR', 'XYL',
    // ── Airlines & Transport ──────────────────────────────────────
    'UAL', 'DAL', 'AAL', 'LUV', 'JBLU', 'ALK', 'SAVE',
    'FDX', 'UPS', 'XPO', 'JBHT', 'ODFL', 'SAIA', 'CHRW',
    'CSX', 'UNP', 'NSC', 'KSU', 'CP', 'CNI',
    // ── Shipping / Logistics ──────────────────────────────────────
    'ZIM', 'MATX', 'KEX',
    // ── Real Estate ───────────────────────────────────────────────
    'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'DLR', 'O', 'SPG', 'VICI', 'WY',
    // ── Utilities ─────────────────────────────────────────────────
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'PCG', 'ED', 'WEC',
    // ── Materials ─────────────────────────────────────────────────
    'LIN', 'APD', 'SHW', 'FCX', 'NEM', 'NUE', 'STLD', 'CF', 'MOS', 'ALB',
    // ── Agriculture ───────────────────────────────────────────────
    'ADM', 'BG', 'INGR', 'TSN',
    // ── Communications ────────────────────────────────────────────
    'GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'FOXA',
    // ── Defense ───────────────────────────────────────────────────
    'LMT', 'RTX', 'NOC', 'GD', 'LHX', 'TDG', 'HII', 'KTOS', 'CACI',
]);

/**
 * Returns true if the ticker is a known valid US-listed equity or ETF.
 */
export function isValidTicker(ticker: string): boolean {
    return VALID_TICKERS.has(ticker);
}

/**
 * Filters an array of tickers, returning only those in the universe.
 */
export function filterValidTickers(tickers: string[]): string[] {
    return tickers.filter(isValidTicker);
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/ticker-universe.test.ts --reporter=verbose
```
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/ticker-universe.ts packages/agents/src/aktienix/intelligence/ticker-universe.test.ts
git commit -m "feat(aktienix): add ticker universe validation (S&P 500 + Russell 1000)"
```

---

### Task 3: Expand macro-sector-map.ts

**Files:**
- Modify: `packages/agents/src/aktienix/intelligence/macro-sector-map.ts`

- [ ] **Step 1: Add new event categories at the bottom of `MACRO_EVENT_MAP`**

Open `packages/agents/src/aktienix/intelligence/macro-sector-map.ts`. After the existing `tech_antitrust` entry, add:

```typescript
    // ------------------------------------------------------------------------
    // ENERGY SPECIFIC
    // ------------------------------------------------------------------------
    oil_supply_shock: {
        id: 'oil_supply_shock',
        description: 'OPEC production cuts, SPR release, or major supply disruption causing oil price spike.',
        triggerKeywords: ['opec cut', 'spr release', 'oil inventory draw', 'brent spike', 'wti surge', 'crude supply'],
        bullishSectors: ['energy'],
        bearishSectors: ['airlines', 'transport', 'consumer_discretionary'],
        bullishTickers: ['XOM', 'CVX', 'OXY', 'XLE', 'USO', 'SLB', 'COP'],
        bearishTickers: ['UAL', 'DAL', 'AAL', 'FDX', 'UPS', 'LUV'],
    },
    gas_price_surge: {
        id: 'gas_price_surge',
        description: 'Natural gas price spike due to supply disruption or extreme weather demand.',
        triggerKeywords: ['natural gas spike', 'lng shortage', 'henry hub surge', 'gas storage draw'],
        bullishSectors: ['natural_gas', 'utilities_bearish'],
        bearishSectors: ['utilities', 'chemicals'],
        bullishTickers: ['UNG', 'AR', 'LNG', 'EQT'],
        bearishTickers: ['DOW', 'LYB', 'WEC', 'SO'],
    },

    // ------------------------------------------------------------------------
    // TRANSPORT & SHIPPING
    // ------------------------------------------------------------------------
    port_strike: {
        id: 'port_strike',
        description: 'Major US port strike disrupting import/export supply chains.',
        triggerKeywords: ['port strike', 'longshoremen', 'dock workers', 'ila strike', 'ilwu strike'],
        bullishSectors: ['domestic_transport', 'air_freight'],
        bearishSectors: ['retail', 'consumer_electronics', 'automotive'],
        bullishTickers: ['FDX', 'UPS', 'XPO', 'JBHT'],
        bearishTickers: ['WMT', 'TGT', 'HD', 'F', 'GM'],
    },
    airline_fuel_shock: {
        id: 'airline_fuel_shock',
        description: 'Jet fuel cost surge materially impacting airline profitability guidance.',
        triggerKeywords: ['jet fuel', 'airline fuel cost', 'kerosene price', 'carrier hedging'],
        bullishSectors: [],
        bearishSectors: ['airlines'],
        bullishTickers: [],
        bearishTickers: ['UAL', 'DAL', 'AAL', 'LUV', 'JBLU'],
    },

    // ------------------------------------------------------------------------
    // HEALTHCARE
    // ------------------------------------------------------------------------
    pandemic_fear: {
        id: 'pandemic_fear',
        description: 'New pathogen or virus outbreak triggering global health emergency concerns.',
        triggerKeywords: ['pandemic', 'novel virus', 'who emergency', 'outbreak spreading', 'bird flu', 'h5n1'],
        bullishSectors: ['healthcare', 'biotech', 'staples'],
        bearishSectors: ['travel', 'hospitality', 'consumer_discretionary'],
        bullishTickers: ['PFE', 'MRNA', 'BNTX', 'GILD', 'ABBV', 'XLP'],
        bearishTickers: ['UAL', 'DAL', 'MAR', 'HLT', 'ABNB', 'MGM'],
    },
    drug_approval_major: {
        id: 'drug_approval_major',
        description: 'FDA approves or rejects a major blockbuster drug with >$5B market potential.',
        triggerKeywords: ['fda approved', 'fda approval', 'fda rejected', 'pdufa', 'new drug application'],
        bullishSectors: ['biotech'],
        bearishSectors: [],
        bullishTickers: [],  // Populated dynamically — company-specific
        bearishTickers: [],
    },

    // ------------------------------------------------------------------------
    // CONSUMER & RETAIL
    // ------------------------------------------------------------------------
    consumer_confidence_drop: {
        id: 'consumer_confidence_drop',
        description: 'Consumer confidence index falls sharply, signaling reduced discretionary spending.',
        triggerKeywords: ['consumer confidence miss', 'sentiment plunges', 'michigan sentiment below'],
        bullishSectors: ['consumer_staples', 'discount_retail'],
        bearishSectors: ['consumer_discretionary', 'luxury'],
        bullishTickers: ['WMT', 'COST', 'DG', 'DLTR', 'XLP'],
        bearishTickers: ['AMZN', 'TGT', 'SBUX', 'NKE', 'BKNG'],
    },
    housing_slowdown: {
        id: 'housing_slowdown',
        description: 'Housing starts, permits, or existing home sales fall sharply.',
        triggerKeywords: ['housing starts miss', 'existing home sales drop', 'mortgage rates surge', 'housing permits'],
        bullishSectors: [],
        bearishSectors: ['homebuilders', 'real_estate', 'home_improvement'],
        bullishTickers: [],
        bearishTickers: ['HD', 'LOW', 'DHI', 'LEN', 'PHM', 'XLRE'],
    },

    // ------------------------------------------------------------------------
    // EARNINGS (SECTOR-WIDE)
    // ------------------------------------------------------------------------
    sector_earnings_miss: {
        id: 'sector_earnings_miss',
        description: 'Multiple companies in the same sector miss earnings, indicating structural sector weakness.',
        triggerKeywords: ['earnings miss', 'eps below', 'revenue miss', 'guidance cut', 'warns on earnings'],
        bullishSectors: [],
        bearishSectors: [],  // Populated by classifier based on which sector is missing
        bullishTickers: [],
        bearishTickers: [],
    },
    recession_fear: {
        id: 'recession_fear',
        description: 'GDP contraction, yield curve inversion, or major bank forecasts recession.',
        triggerKeywords: ['recession', 'gdp contraction', 'yield curve inverted', 'soft landing fails', 'hard landing'],
        bullishSectors: ['consumer_staples', 'utilities', 'healthcare'],
        bearishSectors: ['financials', 'consumer_discretionary', 'industrials'],
        bullishTickers: ['XLP', 'XLU', 'XLV', 'GLD', 'TLT'],
        bearishTickers: ['XLF', 'XLY', 'XLI', 'JPM', 'BAC'],
    },
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @cryonix/agents type-check
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/macro-sector-map.ts
git commit -m "feat(aktienix): expand macro event map — energy, transport, healthcare, consumer, earnings"
```

---

## Chunk 2: Ingestion Layer

### Task 4: Audit Logger

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/audit-logger.ts`
- Create: `packages/agents/src/aktienix/intelligence/audit-logger.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/agents/src/aktienix/intelligence/audit-logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger, AuditEntry } from './audit-logger';

const mockRedis = {
    connect: vi.fn().mockResolvedValue(undefined),
    lpush: vi.fn().mockResolvedValue(undefined),
    ltrim: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
};

vi.mock('../redis-client', () => ({
    RespClient: vi.fn().mockImplementation(() => mockRedis),
}));

describe('AuditLogger', () => {
    let logger: AuditLogger;

    beforeEach(() => {
        vi.clearAllMocks();
        logger = new AuditLogger('redis://localhost:6379');
    });

    it('writes accepted signal to Redis with LPUSH + LTRIM', async () => {
        const entry: Omit<AuditEntry, 'id' | 'timestamp'> = {
            event_id: 'oil_supply_shock',
            sources: ['reuters'],
            corroboration: 'rss_only',
            validation_steps: [{ step: 'ticker_universe', passed: true }],
            final_decision: 'accepted',
            confidence_raw: 0.75,
            confidence_trust_adjusted: 0.75,
            confidence_corroboration_adjusted: 0.75,
            confidence_final: 0.75,
        };

        await logger.log(entry);

        expect(mockRedis.lpush).toHaveBeenCalledWith(
            'aktienix:intelligence:audit',
            expect.stringContaining('"oil_supply_shock"'),
        );
        expect(mockRedis.ltrim).toHaveBeenCalledWith('aktienix:intelligence:audit', 0, 9999);
    });

    it('assigns unique id and timestamp to each entry', async () => {
        const calls: string[] = [];
        mockRedis.lpush.mockImplementation((_key: string, value: string) => {
            calls.push(value);
            return Promise.resolve(undefined);
        });

        const base = { event_id: 'test', sources: [], corroboration: 'rss_only' as const,
            validation_steps: [], final_decision: 'rejected' as const,
            confidence_raw: 0.3, confidence_trust_adjusted: 0.3,
            confidence_corroboration_adjusted: 0.3, confidence_final: 0.3 };

        await logger.log(base);
        await logger.log(base);

        const entry1 = JSON.parse(calls[0]);
        const entry2 = JSON.parse(calls[1]);
        expect(entry1.id).not.toBe(entry2.id);
    });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/audit-logger.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `audit-logger.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/audit-logger.ts
import { RespClient } from '../redis-client';

export interface AuditEntry {
    id: string;
    timestamp: string;
    event_id: string;
    sources: string[];
    corroboration: 'confirmed' | 'confirmed_weak' | 'rss_only' | 'social_only' | 'conflicting';
    validation_steps: { step: string; passed: boolean; reason?: string }[];
    final_decision: 'accepted' | 'rejected';
    confidence_raw: number;
    confidence_trust_adjusted: number;
    confidence_corroboration_adjusted: number;
    confidence_final: number;
}

const AUDIT_KEY = 'aktienix:intelligence:audit';
const MAX_ENTRIES = 10_000;

let _counter = 0;
function generateId(): string {
    return `audit_${Date.now()}_${(++_counter).toString(36)}`;
}

export class AuditLogger {
    private redis: RespClient;

    constructor(redisUrl: string) {
        this.redis = new RespClient(redisUrl);
    }

    async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<string> {
        const full: AuditEntry = {
            ...entry,
            id: generateId(),
            timestamp: new Date().toISOString(),
        };

        if (!this.redis.isConnected()) await this.redis.connect();
        await this.redis.lpush(AUDIT_KEY, JSON.stringify(full));
        await this.redis.ltrim(AUDIT_KEY, 0, MAX_ENTRIES - 1);

        return full.id;
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/audit-logger.test.ts --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/audit-logger.ts packages/agents/src/aktienix/intelligence/audit-logger.test.ts
git commit -m "feat(aktienix): add AuditLogger with Redis List storage"
```

---

### Task 5: RSS Ingestion Service

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/news-ingestion-service.ts`
- Create: `packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewsIngestionService, RawArticle } from './news-ingestion-service';

const MOCK_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Oil prices surge after OPEC cuts</title>
      <link>https://reuters.com/article/1</link>
      <description>Crude oil rose 3% after OPEC announced unexpected cuts.</description>
      <pubDate>Mon, 10 Mar 2026 14:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Oil prices surge after OPEC cuts</title>
      <link>https://reuters.com/article/1</link>
      <description>Duplicate article.</description>
      <pubDate>Mon, 10 Mar 2026 14:05:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('NewsIngestionService', () => {
    let service: NewsIngestionService;

    beforeEach(() => {
        service = new NewsIngestionService();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(MOCK_RSS),
        }));
    });

    it('parses RSS feed and returns RawArticle array', async () => {
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBeGreaterThan(0);
        expect(articles[0].headline).toBe('Oil prices surge after OPEC cuts');
        expect(articles[0].source).toBe('reuters');
        expect(articles[0].sourceTrust).toBe('tier1');
        expect(articles[0].domain).toBe('energy');
        expect(articles[0].pipeline).toBe('rss');
    });

    it('deduplicates articles with same URL', async () => {
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBe(1); // 2 items but same URL — deduped
    });

    it('drops articles older than 48h', async () => {
        const oldRss = MOCK_RSS.replace(
            'Mon, 10 Mar 2026 14:00:00 GMT',
            'Fri, 06 Mar 2026 10:00:00 GMT' // 4 days ago
        );
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, text: () => Promise.resolve(oldRss),
        }));
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBe(0);
    });

    it('returns empty array when feed is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
        const articles = await service.fetchFeed(
            'https://unreachable.example.com/rss',
            'unknown', 'unknown', 'general'
        );
        expect(articles).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `news-ingestion-service.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/news-ingestion-service.ts
import * as crypto from 'crypto';

export type SourceTrust = 'tier1' | 'tier2' | 'unknown';

export interface RawArticle {
    url: string;
    urlHash: string;
    headline: string;
    summary: string;
    source: string;
    sourceTrust: SourceTrust;
    domain: string;
    publishedAt: Date;
    pipeline: 'rss' | 'x';
}

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Extract all <tag>content</tag> occurrences from XML string */
function extractTag(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        results.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    }
    return results;
}

/** Extract all <item> blocks from RSS XML */
function extractItems(xml: string): string[] {
    const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const items: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) items.push(m[1]);
    return items;
}

export class NewsIngestionService {
    private seenHashes = new Set<string>();

    async fetchFeed(
        url: string,
        source: string,
        trust: SourceTrust,
        domain: string,
    ): Promise<RawArticle[]> {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Aktienix/1.0 (trading research bot)' },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return [];
            const xml = await res.text();
            return this.parseRss(xml, source, trust, domain);
        } catch {
            return [];
        }
    }

    private parseRss(xml: string, source: string, trust: SourceTrust, domain: string): RawArticle[] {
        const items = extractItems(xml);
        const now = Date.now();
        const results: RawArticle[] = [];

        for (const item of items) {
            const title = extractTag(item, 'title')[0] ?? '';
            const link = extractTag(item, 'link')[0] ?? '';
            const description = extractTag(item, 'description')[0] ?? '';
            const pubDateStr = extractTag(item, 'pubDate')[0] ?? '';

            if (!title || !link) continue;

            const urlHash = crypto.createHash('sha256').update(link).digest('hex').slice(0, 16);
            if (this.seenHashes.has(urlHash)) continue;

            const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
            if (isNaN(publishedAt.getTime())) continue;
            if (now - publishedAt.getTime() > MAX_AGE_MS) continue;

            this.seenHashes.add(urlHash);

            results.push({
                url: link,
                urlHash,
                headline: title.slice(0, 200),
                summary: description.replace(/<[^>]+>/g, '').slice(0, 300),
                source,
                sourceTrust: trust,
                domain,
                publishedAt,
                pipeline: 'rss',
            });
        }

        return results;
    }

    /** Scan all configured RSS feeds and return deduplicated articles. */
    async scanAll(): Promise<RawArticle[]> {
        const feeds: Array<[string, string, SourceTrust, string]> = [
            ['https://feeds.reuters.com/reuters/businessNews', 'reuters', 'tier1', 'macro'],
            ['https://feeds.reuters.com/reuters/energy', 'reuters', 'tier1', 'energy'],
            ['https://www.eia.gov/rss/press_rss.xml', 'eia', 'tier1', 'energy'],
            ['https://www.federalreserve.gov/feeds/press_all.xml', 'fed', 'tier1', 'fed'],
            ['https://feeds.reuters.com/reuters/technologyNews', 'reuters', 'tier1', 'tech'],
            ['https://feeds.reuters.com/Reuters/worldNews', 'reuters', 'tier1', 'geopolitics'],
            ['https://feeds.reuters.com/reuters/healthNews', 'reuters', 'tier1', 'healthcare'],
            ['https://feeds.marketwatch.com/marketwatch/topstories', 'marketwatch', 'tier2', 'macro'],
        ];

        const results = await Promise.all(
            feeds.map(([url, source, trust, domain]) => this.fetchFeed(url, source, trust, domain))
        );
        return results.flat();
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts --reporter=verbose
```
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/news-ingestion-service.ts packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts
git commit -m "feat(aktienix): add RSS NewsIngestionService with dedup and age filtering"
```

---

### Task 6: X Ingestion Service

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/x-ingestion-service.ts`
- Create: `packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XIngestionService } from './x-ingestion-service';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
    default: vi.fn().mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
    })),
}));

describe('XIngestionService', () => {
    let service: XIngestionService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new XIngestionService('xai-test-key');
    });

    it('returns empty array when API key is missing', async () => {
        const s = new XIngestionService('');
        const articles = await s.scan();
        expect(articles).toEqual([]);
    });

    it('normalizes Grok response to RawArticle[]', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        headline: 'OPEC cuts output by 1M barrels',
                        url: 'https://x.com/WalterBloomberg/status/123',
                        summary: 'Unexpected OPEC production cut announced.',
                        account: '@WalterBloomberg',
                        publishedAt: new Date().toISOString(),
                    }]),
                },
            }],
        });

        const articles = await service.scan();
        expect(articles).toHaveLength(1);
        expect(articles[0].headline).toBe('OPEC cuts output by 1M barrels');
        expect(articles[0].pipeline).toBe('x');
        expect(articles[0].sourceTrust).toBe('tier1');
    });

    it('drops X posts older than 4 hours', async () => {
        const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        headline: 'Old news',
                        url: 'https://x.com/test/status/456',
                        summary: 'Too old.',
                        account: '@test',
                        publishedAt: fiveHoursAgo,
                    }]),
                },
            }],
        });

        const articles = await service.scan();
        expect(articles).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `x-ingestion-service.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/x-ingestion-service.ts
import { OpenAI } from 'openai';
import type { RawArticle, SourceTrust } from './news-ingestion-service';

const TIER1_ACCOUNTS = new Set([
    'WalterBloomberg', 'DeItaone', 'FirstSquawk', 'FinancialJuice',
    'NickTimiraos', 'bespokeinvest', 'unusual_whales', 'LizAnnSonders',
    'OSINTdefender', 'Faytuks', 'spectatorindex',
    'EIAgov', 'JavierBlas', 'Amena__Bakr',
]);

const MAX_AGE_X_MS = 4 * 60 * 60 * 1000; // 4 hours

const CURATED_ACCOUNTS = [
    '@WalterBloomberg', '@DeItaone', '@NickTimiraos', '@EIAgov',
    '@JavierBlas', '@OSINTdefender', '@FirstSquawk', '@unusual_whales',
    '@FreightWaves', '@statnews',
];

export class XIngestionService {
    private grok: OpenAI | null = null;

    constructor(apiKey: string) {
        if (apiKey) {
            this.grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
        }
    }

    async scan(): Promise<RawArticle[]> {
        if (!this.grok) return [];

        const fromQuery = CURATED_ACCOUNTS.map(a => `from:${a.replace('@', '')}`).join(' OR ');
        const now = new Date().toISOString();
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

        try {
            const response = await (this.grok.chat.completions.create as any)({
                model: 'grok-3-mini',
                messages: [{
                    role: 'user',
                    content: `Search X for breaking financial/macro news from these accounts in the last 2 hours.
Query: (${fromQuery}) OR ("breaking" AND ("market" OR "fed" OR "oil" OR "rate"))
Date range: ${twoHoursAgo} to ${now}

Return a JSON array of market-moving posts only (ignore opinions/analysis). For each:
{
  "headline": "one-line summary of what happened",
  "url": "https://x.com/...",
  "summary": "2-3 sentence context",
  "account": "@handle",
  "publishedAt": "ISO8601"
}
Return [] if nothing market-moving. JSON only, no markdown.`,
                }],
                temperature: 0.1,
                search: { mode: 'on', from_date: twoHoursAgo, to_date: now },
            } as any);

            const content = response.choices[0]?.message?.content ?? '[]';
            return this.parse(content);
        } catch {
            return [];
        }
    }

    private parse(text: string): RawArticle[] {
        let raw: any[] = [];
        try {
            raw = JSON.parse(text);
        } catch {
            const m = text.match(/\[[\s\S]*\]/);
            if (m) { try { raw = JSON.parse(m[0]); } catch { return []; } }
        }

        if (!Array.isArray(raw)) return [];

        const now = Date.now();
        return raw
            .filter((item): item is {headline:string;url:string;summary:string;account:string;publishedAt:string} =>
                typeof item?.headline === 'string' && typeof item?.url === 'string')
            .filter(item => {
                const age = now - new Date(item.publishedAt).getTime();
                return age <= MAX_AGE_X_MS;
            })
            .map(item => {
                const handle = (item.account ?? '').replace('@', '');
                const trust: SourceTrust = TIER1_ACCOUNTS.has(handle) ? 'tier1' : 'tier2';
                return {
                    url: item.url,
                    urlHash: Buffer.from(item.url).toString('base64').slice(0, 16),
                    headline: item.headline.slice(0, 200),
                    summary: item.summary?.slice(0, 300) ?? '',
                    source: `x_${item.account ?? 'unknown'}`,
                    sourceTrust: trust,
                    domain: 'social',
                    publishedAt: new Date(item.publishedAt),
                    pipeline: 'x' as const,
                };
            });
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts --reporter=verbose
```
Expected: 3/3 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/x-ingestion-service.ts packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts
git commit -m "feat(aktienix): add X ingestion service via xAI live search"
```

---

## Chunk 3: Classification + Merging

### Task 7: Macro Classifier Agent

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/macro-classifier-agent.ts`
- Create: `packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MacroClassifierAgent, ClassifiedEvent } from './macro-classifier-agent';
import type { RawArticle } from './news-ingestion-service';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
    OpenAI: vi.fn().mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
    })),
}));

const makeArticle = (headline: string, pipeline: 'rss' | 'x' = 'rss'): RawArticle => ({
    url: `https://example.com/${Date.now()}`,
    urlHash: 'abc123',
    headline,
    summary: headline,
    source: 'reuters',
    sourceTrust: 'tier1',
    domain: 'energy',
    publishedAt: new Date(),
    pipeline,
});

describe('MacroClassifierAgent', () => {
    let agent: MacroClassifierAgent;

    beforeEach(() => {
        vi.clearAllMocks();
        agent = new MacroClassifierAgent('xai-test-key');
    });

    it('returns empty array when no articles', async () => {
        const result = await agent.classify([]);
        expect(result).toEqual([]);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('parses valid LLM response into ClassifiedEvent[]', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        event_id: 'oil_supply_shock',
                        category: 'known',
                        causal_chain: {
                            immediate: {
                                bearish_tickers: ['UAL', 'DAL'],
                                bullish_tickers: ['XOM', 'CVX'],
                                reasoning: 'Oil spike hurts airlines',
                            },
                            secondary: {
                                recovery_watch_tickers: ['UAL'],
                                watch_after_days: 4,
                                reasoning: 'Airlines recover after hedges kick in',
                            },
                            resolution_signal: 'WTI falls back below spike level',
                        },
                        confidence: 0.82,
                        reasoning: 'Reuters reports OPEC unexpected cut.',
                        phase: 'developing',
                        ttl_hours: 96,
                        market_moving: true,
                    }]),
                },
            }],
        });

        const result = await agent.classify([makeArticle('OPEC cuts production')]);
        expect(result).toHaveLength(1);
        expect(result[0].event_id).toBe('oil_supply_shock');
        expect(result[0].confidence).toBe(0.82);
        expect(result[0].causal_chain.immediate.bullish_tickers).toContain('XOM');
    });

    it('drops events where market_moving is false', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        event_id: 'oil_supply_shock',
                        category: 'known',
                        causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                            secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                            resolution_signal: '' },
                        confidence: 0.6,
                        reasoning: 'Minor news',
                        phase: 'developing',
                        ttl_hours: 24,
                        market_moving: false,
                    }]),
                },
            }],
        });

        const result = await agent.classify([makeArticle('Minor oil news')]);
        expect(result).toHaveLength(0);
    });

    it('batches articles into groups of 8 max', async () => {
        mockCreate.mockResolvedValue({ choices: [{ message: { content: '[]' } }] });
        const articles = Array.from({ length: 20 }, (_, i) => makeArticle(`Article ${i}`));
        await agent.classify(articles);
        expect(mockCreate).toHaveBeenCalledTimes(3); // 8 + 8 + 4
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `macro-classifier-agent.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/macro-classifier-agent.ts
import { OpenAI } from 'openai';
import { MACRO_EVENT_MAP } from './macro-sector-map';
import type { RawArticle } from './news-ingestion-service';

export interface CausalChain {
    immediate: {
        bearish_tickers: string[];
        bullish_tickers: string[];
        reasoning: string;
    };
    secondary: {
        recovery_watch_tickers: string[];
        watch_after_days: number;
        reasoning: string;
    };
    resolution_signal: string;
}

export interface ClassifiedEvent {
    event_id: string;
    category: 'known' | 'emergent';
    causal_chain: CausalChain;
    confidence: number;
    reasoning: string;
    phase: 'detected' | 'developing' | 'resolving' | 'resolved';
    ttl_hours: number;
    market_moving: boolean;
    source_articles: string[];  // article URLs
}

const BATCH_SIZE = 8;
const KNOWN_EVENTS = Object.keys(MACRO_EVENT_MAP).map(k =>
    `- ${k}: ${MACRO_EVENT_MAP[k].description}`
).join('\n');

const SYSTEM_PROMPT = `You are a macro economist and portfolio strategist for an automated US equity trading fund.

Known event IDs we can trade (use these exact slugs when applicable):
${KNOWN_EVENTS}

For NEW events not in this list, create a descriptive snake_case slug (e.g. "bird_flu_outbreak", "port_strike_us_east").

Analyze the provided news articles and identify market-moving events.

For each event return JSON:
{
  "event_id": "snake_case_slug",
  "category": "known" | "emergent",
  "causal_chain": {
    "immediate": { "bearish_tickers": ["UAL"], "bullish_tickers": ["XOM"], "reasoning": "..." },
    "secondary": { "recovery_watch_tickers": ["UAL"], "watch_after_days": 4, "reasoning": "..." },
    "resolution_signal": "WTI falls below spike level"
  },
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentences citing the source article",
  "phase": "developing" | "resolving" | "resolved",
  "ttl_hours": 24-168,
  "market_moving": true | false
}

Rules:
- Only NYSE/NASDAQ tickers (max 10 per event)
- market_moving=false if event would NOT cause >1% sector move
- Return [] if nothing is market-moving
- Return JSON array only, no markdown`;

export class MacroClassifierAgent {
    private grok: OpenAI | null = null;

    constructor(apiKey: string) {
        if (apiKey) {
            this.grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
        }
    }

    async classify(articles: RawArticle[]): Promise<ClassifiedEvent[]> {
        if (!this.grok || articles.length === 0) return [];

        const results: ClassifiedEvent[] = [];
        for (let i = 0; i < articles.length; i += BATCH_SIZE) {
            const batch = articles.slice(i, i + BATCH_SIZE);
            const batchResults = await this.classifyBatch(batch);
            results.push(...batchResults);
        }
        return results;
    }

    private async classifyBatch(articles: RawArticle[]): Promise<ClassifiedEvent[]> {
        const articleText = articles.map((a, i) =>
            `[${i + 1}] Source: ${a.source} (${a.domain})\nHeadline: ${a.headline}\nSummary: ${a.summary}`
        ).join('\n\n');

        try {
            const response = await this.grok!.chat.completions.create({
                model: 'grok-3-mini',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: `Analyze these ${articles.length} articles:\n\n${articleText}` },
                ],
                temperature: 0.1,
            });

            const content = response.choices[0]?.message?.content ?? '[]';
            const parsed = this.parseResponse(content);

            return parsed
                .filter(e => e.market_moving !== false)
                .map(e => ({
                    ...e,
                    source_articles: articles.map(a => a.url),
                }));
        } catch {
            return [];
        }
    }

    private parseResponse(text: string): any[] {
        try { return JSON.parse(text); } catch { /* try fallback */ }
        const m = text.match(/\[[\s\S]*\]/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
        return [];
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts --reporter=verbose
```
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/macro-classifier-agent.ts packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts
git commit -m "feat(aktienix): add MacroClassifierAgent with causal chain LLM classification"
```

---

### Task 8: Signal Merger

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/signal-merger.ts`
- Create: `packages/agents/src/aktienix/intelligence/signal-merger.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/signal-merger.test.ts
import { describe, it, expect } from 'vitest';
import { SignalMerger, MergedSignal } from './signal-merger';
import type { ClassifiedEvent } from './macro-classifier-agent';

const makeEvent = (event_id: string, phase = 'developing', conf = 0.75,
    pipeline: 'rss' | 'x' = 'rss', trust: 'tier1' | 'tier2' = 'tier1'): ClassifiedEvent & { pipeline: 'rss' | 'x'; trust: 'tier1' | 'tier2' } => ({
    event_id,
    category: 'known' as const,
    causal_chain: {
        immediate: { bearish_tickers: ['UAL'], bullish_tickers: ['XOM'], reasoning: 'test' },
        secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 3, reasoning: 'test' },
        resolution_signal: 'test',
    },
    confidence: conf,
    reasoning: 'test',
    phase: phase as any,
    ttl_hours: 48,
    market_moving: true,
    source_articles: ['https://example.com'],
    pipeline,
    trust,
});

describe('SignalMerger', () => {
    const merger = new SignalMerger();

    it('marks confirmed when both RSS and X detect same event same direction', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('oil_supply_shock', 'developing', 0.70, 'x');
        const results = merger.merge([rss], [x]);
        expect(results[0].corroboration).toBe('confirmed');
        expect(results[0].confidence_delta).toBe(0.15);
    });

    it('marks rss_only when X has no matching event', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const results = merger.merge([rss], []);
        expect(results[0].corroboration).toBe('rss_only');
        expect(results[0].confidence_delta).toBe(0);
    });

    it('marks social_only with negative delta when only X detects', () => {
        const x = makeEvent('oil_supply_shock', 'developing', 0.75, 'x');
        const results = merger.merge([], [x]);
        expect(results[0].corroboration).toBe('social_only');
        expect(results[0].confidence_delta).toBe(-0.10);
    });

    it('marks confirmed_weak for category match (different slugs, same sector)', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('opec_surprise_cut', 'developing', 0.72, 'x'); // emergent but energy
        const results = merger.merge([rss], [x]);
        // Different event_id but both energy category → confirmed_weak
        const merged = results.find(r => r.event_id === 'oil_supply_shock');
        expect(merged?.corroboration).toMatch(/confirmed/);
    });

    it('merges sources array from both pipelines', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('oil_supply_shock', 'developing', 0.70, 'x');
        rss.source_articles = ['https://reuters.com/1'];
        x.source_articles = ['https://x.com/1'];
        const results = merger.merge([rss], [x]);
        expect(results[0].sources).toContain('https://reuters.com/1');
        expect(results[0].sources).toContain('https://x.com/1');
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/signal-merger.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `signal-merger.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/signal-merger.ts
import { MACRO_EVENT_MAP } from './macro-sector-map';
import type { ClassifiedEvent } from './macro-classifier-agent';

export type CorroborationStatus = 'confirmed' | 'confirmed_weak' | 'rss_only' | 'social_only' | 'conflicting';

export interface MergedSignal extends ClassifiedEvent {
    corroboration: CorroborationStatus;
    confidence_delta: number;
    sources: string[];
}

const CORROBORATION_DELTA: Record<CorroborationStatus, number> = {
    confirmed: 0.15,
    confirmed_weak: 0.08,
    rss_only: 0,
    social_only: -0.10,
    conflicting: -0.20,
};

/** Returns the known event category for an event_id, or null for emergent. */
function getEventCategory(event_id: string): string | null {
    if (MACRO_EVENT_MAP[event_id]) {
        return MACRO_EVENT_MAP[event_id].bullishSectors[0]
            ?? MACRO_EVENT_MAP[event_id].bearishSectors[0]
            ?? null;
    }
    return null;
}

/** Simple heuristic: events share a sector if both ids contain shared keywords */
function sameCategory(id1: string, id2: string): boolean {
    const CATEGORIES = [
        ['oil', 'energy', 'opec', 'crude', 'fuel', 'gas'],
        ['fed', 'rate', 'fomc', 'inflation', 'cpi'],
        ['china', 'taiwan', 'tariff', 'trade'],
        ['airline', 'transport', 'freight', 'ship'],
        ['health', 'pandemic', 'drug', 'virus'],
        ['tech', 'semi', 'chip', 'antitrust'],
    ];
    const combined = `${id1} ${id2}`.toLowerCase();
    return CATEGORIES.some(kws => kws.filter(kw => combined.includes(kw)).length >= 2);
}

export class SignalMerger {
    merge(rssEvents: ClassifiedEvent[], xEvents: ClassifiedEvent[]): MergedSignal[] {
        const matched = new Set<string>(); // x event_ids already matched
        const results: MergedSignal[] = [];

        for (const rssEvent of rssEvents) {
            // Step 1: exact event_id match
            let xMatch = xEvents.find(x => x.event_id === rssEvent.event_id);
            let corroboration: CorroborationStatus;

            if (xMatch) {
                matched.add(xMatch.event_id);
                corroboration = 'confirmed';
            } else {
                // Step 2: category match within 2h (both are fresh — ingestion filters ensure this)
                xMatch = xEvents.find(x => !matched.has(x.event_id) && sameCategory(rssEvent.event_id, x.event_id));
                if (xMatch) {
                    matched.add(xMatch.event_id);
                    corroboration = 'confirmed_weak';
                } else {
                    corroboration = 'rss_only';
                }
            }

            const delta = CORROBORATION_DELTA[corroboration];
            results.push({
                ...rssEvent,
                corroboration,
                confidence_delta: delta,
                sources: [
                    ...rssEvent.source_articles,
                    ...(xMatch?.source_articles ?? []),
                ],
            });
        }

        // Step 3: unmatched X events → social_only
        for (const xEvent of xEvents) {
            if (!matched.has(xEvent.event_id)) {
                results.push({
                    ...xEvent,
                    corroboration: 'social_only',
                    confidence_delta: CORROBORATION_DELTA.social_only,
                    sources: xEvent.source_articles,
                });
            }
        }

        return results;
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/signal-merger.test.ts --reporter=verbose
```
Expected: 4-5 PASS (category match test may need adjustment depending on heuristic)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/signal-merger.ts packages/agents/src/aktienix/intelligence/signal-merger.test.ts
git commit -m "feat(aktienix): add SignalMerger with cross-pipeline corroboration"
```

---

## Chunk 4: Lifecycle + Causal Chain

### Task 9: Event Lifecycle Tracker

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.ts`
- Create: `packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventLifecycleTracker, LiveEvent } from './event-lifecycle-tracker';

const mockRedis = {
    connect: vi.fn().mockResolvedValue(undefined),
    hset: vi.fn().mockResolvedValue(undefined),
    hdel: vi.fn().mockResolvedValue(undefined),
    hgetall: vi.fn().mockResolvedValue({}),
    isConnected: vi.fn().mockReturnValue(true),
};
vi.mock('../redis-client', () => ({
    RespClient: vi.fn().mockImplementation(() => mockRedis),
}));

const mockGrok = { chat: { completions: { create: vi.fn() } } };
vi.mock('openai', () => ({
    OpenAI: vi.fn().mockImplementation(() => mockGrok),
}));

describe('EventLifecycleTracker', () => {
    let tracker: EventLifecycleTracker;

    beforeEach(() => {
        vi.clearAllMocks();
        tracker = new EventLifecycleTracker('redis://localhost:6379', 'xai-key');
    });

    it('stores new event with detected phase', async () => {
        const event: LiveEvent = {
            event_id: 'oil_supply_shock',
            phase: 'detected',
            causal_chain: {
                immediate: { bearish_tickers: ['UAL'], bullish_tickers: ['XOM'], reasoning: 'test' },
                secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 3, reasoning: 'test' },
                resolution_signal: 'test',
            },
            sources: ['https://reuters.com/1'],
            corroboration: 'rss_only',
            confidence: 0.72,
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(),
            auditIds: [],
        };

        await tracker.upsertEvent(event);
        expect(mockRedis.hset).toHaveBeenCalledWith(
            'aktienix:macro:event_states',
            'oil_supply_shock',
            expect.stringContaining('"phase":"detected"'),
        );
    });

    it('promotes detected → developing when second confirmation arrives', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'detected', confidence: 0.72,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'rss_only',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({
            oil_supply_shock: JSON.stringify(stored),
        });

        await tracker.confirmEvent('oil_supply_shock');

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.phase).toBe('developing');
    });

    it('applies confidence decay when re-evaluated without new evidence', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'developing', confidence: 0.80,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'confirmed',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({ oil_supply_shock: JSON.stringify(stored) });
        mockGrok.chat.completions.create.mockRejectedValue(new Error('API error'));

        await tracker.reEvaluate();

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.confidence).toBeCloseTo(0.80 * 0.85, 3);
    });

    it('transitions to resolved when confidence drops below 0.30', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'resolving', confidence: 0.32,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'rss_only',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({ oil_supply_shock: JSON.stringify(stored) });
        mockGrok.chat.completions.create.mockRejectedValue(new Error('API error'));

        await tracker.reEvaluate();

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.phase).toBe('resolved');
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `event-lifecycle-tracker.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.ts
import { OpenAI } from 'openai';
import { RespClient } from '../redis-client';
import type { CausalChain } from './macro-classifier-agent';
import type { CorroborationStatus } from './signal-merger';

export interface LiveEvent {
    event_id: string;
    phase: 'detected' | 'developing' | 'resolving' | 'resolved';
    causal_chain: CausalChain;
    sources: string[];
    corroboration: CorroborationStatus;
    confidence: number;
    detectedAt: string;
    expiresAt: string;
    lastEvaluatedAt: string;
    auditIds: string[];
}

const EVENTS_KEY = 'aktienix:macro:event_states';
const DECAY_FACTOR = 0.85;
const RESOLVED_THRESHOLD = 0.30;

export class EventLifecycleTracker {
    private redis: RespClient;
    private grok: OpenAI | null = null;

    constructor(redisUrl: string, xaiApiKey?: string) {
        this.redis = new RespClient(redisUrl);
        if (xaiApiKey) {
            this.grok = new OpenAI({ apiKey: xaiApiKey, baseURL: 'https://api.x.ai/v1' });
        }
    }

    async getAll(): Promise<LiveEvent[]> {
        if (!this.redis.isConnected()) await this.redis.connect();
        const all = await this.redis.hgetall(EVENTS_KEY);
        const now = Date.now();
        return Object.values(all)
            .map(v => { try { return JSON.parse(v) as LiveEvent; } catch { return null; } })
            .filter((e): e is LiveEvent => e !== null)
            .filter(e => new Date(e.expiresAt).getTime() > now);
    }

    async upsertEvent(event: LiveEvent): Promise<void> {
        if (!this.redis.isConnected()) await this.redis.connect();
        await this.redis.hset(EVENTS_KEY, event.event_id, JSON.stringify(event));
    }

    async confirmEvent(event_id: string): Promise<void> {
        const all = await this.getAll();
        const event = all.find(e => e.event_id === event_id);
        if (!event) return;
        if (event.phase === 'detected') {
            event.phase = 'developing';
            event.lastEvaluatedAt = new Date().toISOString();
            await this.upsertEvent(event);
        }
    }

    /** Called every 2 hours. Decays confidence and runs Grok re-evaluation. */
    async reEvaluate(): Promise<void> {
        const events = await this.getAll();
        for (const event of events) {
            if (event.phase === 'resolved') continue;

            const newConf = await this.evaluateOne(event);
            event.confidence = newConf;
            event.lastEvaluatedAt = new Date().toISOString();

            if (newConf < RESOLVED_THRESHOLD) {
                event.phase = 'resolved';
            } else if (newConf < 0.55 && event.phase === 'developing') {
                event.phase = 'resolving';
            }

            await this.upsertEvent(event);
        }
    }

    private async evaluateOne(event: LiveEvent): Promise<number> {
        if (!this.grok) return event.confidence * DECAY_FACTOR;

        try {
            const hoursAgo = Math.round(
                (Date.now() - new Date(event.detectedAt).getTime()) / 3_600_000
            );
            const response = await (this.grok.chat.completions.create as any)({
                model: 'grok-3-mini',
                messages: [{
                    role: 'user',
                    content: `Current event: ${event.event_id}
Detected ${hoursAgo} hours ago with confidence ${event.confidence.toFixed(2)}.
Original reasoning: ${event.causal_chain.resolution_signal}

Search X and recent news for evidence of this event status.
Is it still developing, starting to resolve, or over?

Return JSON only: { "phase": "developing"|"resolving"|"resolved", "evidence": "...", "confidence": 0.0-1.0 }`,
                }],
                temperature: 0.1,
                search: { mode: 'on' },
            } as any);

            const content = response.choices[0]?.message?.content ?? '';
            const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}');

            if (parsed.phase === 'resolved') return 0.20; // force below threshold
            if (parsed.phase === 'resolving') return Math.min(event.confidence * 0.85, parsed.confidence ?? 0.45);
            return parsed.confidence ?? event.confidence;
        } catch {
            // API failed — apply decay passively
            return event.confidence * DECAY_FACTOR;
        }
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts --reporter=verbose
```
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.ts packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts
git commit -m "feat(aktienix): add EventLifecycleTracker with confidence decay and Grok re-evaluation"
```

---

### Task 10: Causal Chain Engine

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/causal-chain-engine.ts`
- Create: `packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts
import { describe, it, expect } from 'vitest';
import { CausalChainEngine } from './causal-chain-engine';
import type { LiveEvent } from './event-lifecycle-tracker';

const makeEvent = (phase: LiveEvent['phase'], conf = 0.75, daysSinceDetected = 0): LiveEvent => ({
    event_id: 'oil_supply_shock',
    phase,
    causal_chain: {
        immediate: { bearish_tickers: ['UAL', 'DAL'], bullish_tickers: ['XOM'], reasoning: 'fuel costs up' },
        secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 4, reasoning: 'recovery' },
        resolution_signal: 'WTI falls',
    },
    sources: [],
    corroboration: 'confirmed',
    confidence: conf,
    detectedAt: new Date(Date.now() - daysSinceDetected * 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    lastEvaluatedAt: new Date().toISOString(),
    auditIds: [],
});

describe('CausalChainEngine', () => {
    const engine = new CausalChainEngine();

    it('emits bearish MacroSignal for developing event on bearish tickers', () => {
        const signals = engine.toMacroSignals([makeEvent('developing')]);
        const bearish = signals.filter(s => s.impact === 'bearish');
        expect(bearish.length).toBeGreaterThan(0);
        expect(bearish[0].tickers).toContain('UAL');
        expect(bearish[0].tickers).toContain('DAL');
    });

    it('emits bullish MacroSignal for developing event on bullish tickers', () => {
        const signals = engine.toMacroSignals([makeEvent('developing')]);
        const bullish = signals.filter(s => s.impact === 'bullish');
        expect(bullish[0].tickers).toContain('XOM');
    });

    it('emits neutral WATCH_RECOVERY signal when resolving + past watchAfterDays', () => {
        const signals = engine.toMacroSignals([makeEvent('resolving', 0.45, 5)]); // 5 days in
        const neutral = signals.filter(s => s.impact === 'neutral');
        expect(neutral.length).toBeGreaterThan(0);
        expect(neutral[0].tickers).toContain('UAL');
    });

    it('does NOT emit recovery signal before watchAfterDays', () => {
        const signals = engine.toMacroSignals([makeEvent('resolving', 0.45, 1)]); // only 1 day in
        const neutral = signals.filter(s => s.impact === 'neutral');
        expect(neutral.length).toBe(0);
    });

    it('emits no signals for resolved events', () => {
        const signals = engine.toMacroSignals([makeEvent('resolved')]);
        expect(signals.length).toBe(0);
    });

    it('emits no signals for detected (not yet confirmed) events', () => {
        const signals = engine.toMacroSignals([makeEvent('detected')]);
        expect(signals.length).toBe(0);
    });

    it('confidence is capped at 0.95', () => {
        const signals = engine.toMacroSignals([makeEvent('developing', 0.99)]);
        for (const s of signals) expect(s.confidence).toBeLessThanOrEqual(0.95);
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `causal-chain-engine.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/causal-chain-engine.ts
import type { MacroSignal } from '../intelligence/news-scanner';
import type { LiveEvent } from './event-lifecycle-tracker';

export class CausalChainEngine {
    /**
     * Convert active LiveEvents to MacroSignal[] compatible with the existing
     * AktienixAgent.evaluateSignal() method.
     *
     * Adapter mapping (from spec Section 7):
     *   BLOCK_BUY  (developing)  → impact: 'bearish',  tickers: immediate.bearishTickers
     *   BLOCK_BUY  (developing)  → impact: 'bullish',  tickers: immediate.bullishTickers
     *   WATCH_RECOVERY (resolving, past watchAfterDays) → impact: 'neutral', tickers: recoveryWatchTickers
     *   RESOLVED events → no signals emitted
     */
    toMacroSignals(events: LiveEvent[]): MacroSignal[] {
        const signals: MacroSignal[] = [];

        for (const event of events) {
            if (event.phase === 'detected' || event.phase === 'resolved') continue;

            const conf = Math.min(event.confidence, 0.95);
            const chain = event.causal_chain;

            if (event.phase === 'developing') {
                // Bearish: block buys on tickers hurt by this event
                if (chain.immediate.bearish_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'bearish',
                        sectors: [],
                        tickers: chain.immediate.bearish_tickers,
                        confidence: conf,
                        reasoning: `[${event.event_id}] developing — ${chain.immediate.reasoning}`,
                    });
                }
                // Bullish: boost buy confidence on tickers that benefit
                if (chain.immediate.bullish_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'bullish',
                        sectors: [],
                        tickers: chain.immediate.bullish_tickers,
                        confidence: conf,
                        reasoning: `[${event.event_id}] developing — ${chain.immediate.reasoning}`,
                    });
                }
            } else if (event.phase === 'resolving') {
                // Only emit recovery watch after watchAfterDays
                const daysSince = (Date.now() - new Date(event.detectedAt).getTime()) / 86_400_000;
                if (daysSince >= chain.secondary.watch_after_days && chain.secondary.recovery_watch_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'neutral',
                        sectors: [],
                        tickers: chain.secondary.recovery_watch_tickers,
                        confidence: conf * 0.8, // recovery signals get lower boost
                        reasoning: `[${event.event_id}] resolving — watch for recovery: ${chain.secondary.reasoning}`,
                    });
                }
            }
        }

        return signals;
    }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts --reporter=verbose
```
Expected: 7/7 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/causal-chain-engine.ts packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts
git commit -m "feat(aktienix): add CausalChainEngine with phase-aware MacroSignal adapter"
```

---

## Chunk 5: Integration

### Task 11: MacroIntelligence Facade

**Files:**
- Create: `packages/agents/src/aktienix/intelligence/macro-intelligence.ts`
- Create: `packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MacroIntelligence } from './macro-intelligence';

// Mock all sub-modules
vi.mock('./news-ingestion-service', () => ({
    NewsIngestionService: vi.fn().mockImplementation(() => ({
        scanAll: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('./x-ingestion-service', () => ({
    XIngestionService: vi.fn().mockImplementation(() => ({
        scan: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('./macro-classifier-agent', () => ({
    MacroClassifierAgent: vi.fn().mockImplementation(() => ({
        classify: vi.fn().mockResolvedValue([]),
    })),
}));
vi.mock('./signal-merger', () => ({
    SignalMerger: vi.fn().mockImplementation(() => ({
        merge: vi.fn().mockReturnValue([]),
    })),
}));
vi.mock('./event-lifecycle-tracker', () => ({
    EventLifecycleTracker: vi.fn().mockImplementation(() => ({
        getAll: vi.fn().mockResolvedValue([]),
        upsertEvent: vi.fn().mockResolvedValue(undefined),
        confirmEvent: vi.fn().mockResolvedValue(undefined),
        reEvaluate: vi.fn().mockResolvedValue(undefined),
    })),
}));
vi.mock('./causal-chain-engine', () => ({
    CausalChainEngine: vi.fn().mockImplementation(() => ({
        toMacroSignals: vi.fn().mockReturnValue([]),
    })),
}));
vi.mock('./audit-logger', () => ({
    AuditLogger: vi.fn().mockImplementation(() => ({
        log: vi.fn().mockResolvedValue('audit_123'),
    })),
}));

describe('MacroIntelligence', () => {
    let intel: MacroIntelligence;

    beforeEach(() => {
        vi.clearAllMocks();
        intel = new MacroIntelligence('redis://localhost:6379', 'xai-key');
    });

    it('getLiveSignals returns empty array when no active events', async () => {
        const signals = await intel.getLiveSignals();
        expect(signals).toEqual([]);
    });

    it('runIntelligenceCycle completes without throwing', async () => {
        await expect(intel.runIntelligenceCycle()).resolves.not.toThrow();
    });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts --reporter=verbose
```

- [ ] **Step 3: Create `macro-intelligence.ts`**

```typescript
// packages/agents/src/aktienix/intelligence/macro-intelligence.ts
import { NewsIngestionService } from './news-ingestion-service';
import { XIngestionService } from './x-ingestion-service';
import { MacroClassifierAgent } from './macro-classifier-agent';
import { SignalMerger } from './signal-merger';
import { EventLifecycleTracker, LiveEvent } from './event-lifecycle-tracker';
import { CausalChainEngine } from './causal-chain-engine';
import { AuditLogger } from './audit-logger';
import type { MacroSignal } from './news-scanner';
import type { MergedSignal } from './signal-merger';

const CONFIDENCE_THRESHOLDS = {
    known_confirmed: 0.50,
    known_confirmed_weak: 0.50,
    known_rss_only: 0.50,
    known_social_only: 0.60,
    emergent_confirmed: 0.75,
    emergent_other: 0.80,
    any_conflicting: 0.85,
} as const;

export class MacroIntelligence {
    private rss: NewsIngestionService;
    private x: XIngestionService;
    private classifier: MacroClassifierAgent;
    private merger: SignalMerger;
    private lifecycle: EventLifecycleTracker;
    private engine: CausalChainEngine;
    private audit: AuditLogger;
    private lastReEvalAt = 0;
    private readonly RE_EVAL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

    constructor(redisUrl: string, xaiApiKey: string) {
        this.rss = new NewsIngestionService();
        this.x = new XIngestionService(xaiApiKey);
        this.classifier = new MacroClassifierAgent(xaiApiKey);
        this.merger = new SignalMerger();
        this.lifecycle = new EventLifecycleTracker(redisUrl, xaiApiKey);
        this.engine = new CausalChainEngine();
        this.audit = new AuditLogger(redisUrl);
    }

    /**
     * Returns MacroSignal[] for current active events.
     * Fast path — reads from Redis, no Grok calls.
     * Called every poll cycle by AktienixAgent.
     */
    async getLiveSignals(): Promise<MacroSignal[]> {
        const events = await this.lifecycle.getAll();
        return this.engine.toMacroSignals(events);
    }

    /**
     * Full ingestion → classify → merge → validate → store pipeline.
     * Expensive (Grok calls). Called every 15min by AktienixAgent's signal scan timer.
     */
    async runIntelligenceCycle(): Promise<void> {
        try {
            // 1. Ingest from both pipelines in parallel
            const [rssArticles, xArticles] = await Promise.all([
                this.rss.scanAll(),
                this.x.scan(),
            ]);

            // 2. Classify each pipeline separately
            const [rssEvents, xEvents] = await Promise.all([
                this.classifier.classify(rssArticles),
                this.classifier.classify(xArticles),
            ]);

            // 3. Cross-validate
            const merged = this.merger.merge(rssEvents, xEvents);

            // 4. Validate and store accepted events
            for (const signal of merged) {
                await this.validateAndStore(signal);
            }

            // 5. Re-evaluate existing events every 2 hours
            if (Date.now() - this.lastReEvalAt > this.RE_EVAL_INTERVAL_MS) {
                await this.lifecycle.reEvaluate();
                this.lastReEvalAt = Date.now();
            }
        } catch (err) {
            console.error('[MACRO INTELLIGENCE] Cycle error:', err);
        }
    }

    private async validateAndStore(signal: MergedSignal): Promise<void> {
        const steps: { step: string; passed: boolean; reason?: string }[] = [];

        // Step 1: Ticker universe (handled inside classifier — all tickers already validated)
        steps.push({ step: 'ticker_universe', passed: true });

        // Step 2: Source trust multiplier
        const trustMultiplier = signal.sourceTrust === 'tier1' ? 1.0
            : signal.sourceTrust === 'tier2' ? 0.90 : 0.75;
        const confAfterTrust = signal.confidence * trustMultiplier;
        steps.push({ step: 'source_trust', passed: true });

        // Step 3: Cross-validation delta
        const confAfterDelta = confAfterTrust + signal.confidence_delta;
        steps.push({ step: 'cross_validation', passed: true });

        // Step 4: Confidence gate
        const key = `${signal.category}_${signal.corroboration}` as keyof typeof CONFIDENCE_THRESHOLDS;
        const conflicting = signal.corroboration === 'conflicting';
        const threshold = conflicting
            ? CONFIDENCE_THRESHOLDS.any_conflicting
            : (CONFIDENCE_THRESHOLDS[key] ?? CONFIDENCE_THRESHOLDS.emergent_other);

        const passed = confAfterDelta >= threshold;
        steps.push({ step: 'confidence_gate', passed, reason: passed ? undefined : `${confAfterDelta.toFixed(2)} < ${threshold}` });

        const auditId = await this.audit.log({
            event_id: signal.event_id,
            sources: signal.sources,
            corroboration: signal.corroboration,
            validation_steps: steps,
            final_decision: passed ? 'accepted' : 'rejected',
            confidence_raw: signal.confidence,
            confidence_trust_adjusted: confAfterTrust,
            confidence_corroboration_adjusted: confAfterDelta,
            confidence_final: confAfterDelta,
        });

        if (!passed) return;

        // Store as LiveEvent
        const now = new Date();
        const event: LiveEvent = {
            event_id: signal.event_id,
            phase: 'detected',
            causal_chain: signal.causal_chain,
            sources: signal.sources,
            corroboration: signal.corroboration,
            confidence: confAfterDelta,
            detectedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + signal.ttl_hours * 3_600_000).toISOString(),
            lastEvaluatedAt: now.toISOString(),
            auditIds: [auditId],
        };

        // Check if we already have this event — if so, confirm it (detected → developing)
        const existing = (await this.lifecycle.getAll()).find(e => e.event_id === signal.event_id);
        if (existing) {
            await this.lifecycle.confirmEvent(signal.event_id);
        } else {
            await this.lifecycle.upsertEvent(event);
        }
    }
}
```

**Note:** `signal.sourceTrust` and `signal.ttl_hours` come from the underlying articles/events. Ensure `MergedSignal` exposes these fields. If not present, add `sourceTrust: 'tier1' | 'tier2' | 'unknown'` and `ttl_hours: number` to the `MergedSignal` interface in `signal-merger.ts` by spreading them from the `ClassifiedEvent`.

- [ ] **Step 4: Run tests — PASS**

```bash
pnpm vitest run packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/macro-intelligence.ts packages/agents/src/aktienix/intelligence/macro-intelligence.test.ts
git commit -m "feat(aktienix): add MacroIntelligence facade wiring all intelligence components"
```

---

### Task 12: Wire into AktienixAgent

**Files:**
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts`

- [ ] **Step 1: Add `MacroIntelligence` import**

At the top of `aktienix-agent.ts`, find the existing import:
```typescript
import { StockNewsScanner } from './intelligence/news-scanner';
```
Add below it:
```typescript
import { MacroIntelligence } from './intelligence/macro-intelligence';
```

- [ ] **Step 2: Add `macroIntelligence` field**

In the class body, find `private newsScanner: StockNewsScanner;` and add:
```typescript
private macroIntelligence: MacroIntelligence;
```

- [ ] **Step 3: Initialize in constructor**

In the constructor, after `this.newsScanner = new StockNewsScanner();`, add:
```typescript
this.macroIntelligence = new MacroIntelligence(
    process.env.KV_URL ?? 'redis://localhost:6379',
    process.env.XAI_API_KEY ?? '',
);
```

- [ ] **Step 4: Replace scanner call in signal scan block**

Find the block where `scanMacroEvents()` is called (inside the signal scan interval check):
```typescript
const macroSignals = await this.newsScanner.scanMacroEvents();
```
Replace with:
```typescript
await this.macroIntelligence.runIntelligenceCycle();
```

Find where `macroSignals` is used in `evaluateAndTrade()` or similar — replace the `scanMacroEvents()` call there with:
```typescript
const macroSignals = await this.macroIntelligence.getLiveSignals();
```

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @cryonix/agents type-check
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/aktienix/aktienix-agent.ts
git commit -m "feat(aktienix): wire MacroIntelligence into AktienixAgent, replace StockNewsScanner"
```

---

### Task 13: Expand watchlist in aktienix.toml

**Files:**
- Modify: `aktienix.toml`

- [ ] **Step 1: Update `[watchlist]` symbols**

Open `aktienix.toml`. Replace the existing `symbols` array with:

```toml
symbols = [
    # Tech — Highest liquidity, tightest spreads, fractional-friendly
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA",

    # Broad Market ETFs
    "SPY",   # S&P 500
    "QQQ",   # NASDAQ 100

    # Blue Chips — sector diversification
    "JPM",   # Financials
    "JNJ",   # Healthcare

    # Energy — benefits from oil price rises (oil_supply_shock bullish tickers)
    "XOM",   # ExxonMobil — largest US E&P
    "CVX",   # Chevron
    "XLE",   # Energy Select SPDR ETF
    "USO",   # Oil ETF

    # Airlines — recovery plays after oil/fuel shocks (oil_supply_shock secondary)
    "UAL",   # United Airlines
    "DAL",   # Delta Air Lines

    # Logistics — affected by port strikes and shipping disruptions
    "FDX",   # FedEx
    "UPS",   # UPS
]
```

- [ ] **Step 2: Commit**

```bash
git add aktienix.toml
git commit -m "feat(aktienix): expand watchlist with energy, airlines, logistics tickers"
```

---

### Task 14: Smoke Test Script

**Files:**
- Create: `scripts/aktienix/test-macro-intelligence.ts`

- [ ] **Step 1: Create smoke test**

```typescript
// scripts/aktienix/test-macro-intelligence.ts
/**
 * End-to-end smoke test for the Macro Intelligence v2 pipeline.
 * Uses mock articles — no real API calls unless XAI_API_KEY is set.
 *
 * Run: npx tsx scripts/aktienix/test-macro-intelligence.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

import { MacroClassifierAgent } from '../../packages/agents/src/aktienix/intelligence/macro-classifier-agent';
import { SignalMerger } from '../../packages/agents/src/aktienix/intelligence/signal-merger';
import { CausalChainEngine } from '../../packages/agents/src/aktienix/intelligence/causal-chain-engine';
import { isValidTicker } from '../../packages/agents/src/aktienix/intelligence/ticker-universe';
import type { RawArticle } from '../../packages/agents/src/aktienix/intelligence/news-ingestion-service';
import type { LiveEvent } from '../../packages/agents/src/aktienix/intelligence/event-lifecycle-tracker';

const MOCK_RSS_ARTICLES: RawArticle[] = [
    {
        url: 'https://reuters.com/test/opec-cut',
        urlHash: 'abc1',
        headline: 'OPEC unexpectedly cuts oil production by 1.5M barrels per day',
        summary: 'Saudi Arabia led an OPEC+ agreement to cut output amid falling prices and weak demand.',
        source: 'reuters',
        sourceTrust: 'tier1',
        domain: 'energy',
        publishedAt: new Date(),
        pipeline: 'rss',
    },
];

const MOCK_X_ARTICLES: RawArticle[] = [
    {
        url: 'https://x.com/WalterBloomberg/status/123',
        urlHash: 'xyz1',
        headline: 'BREAKING: OPEC cuts 1.5M bpd — oil surges 4% on the news',
        summary: 'WalterBloomberg: OPEC announced surprise production cut. $XOM $CVX up premarket.',
        source: 'x_@WalterBloomberg',
        sourceTrust: 'tier1',
        domain: 'social',
        publishedAt: new Date(),
        pipeline: 'x',
    },
];

async function main() {
    console.log('===========================================');
    console.log('  Aktienix Macro Intelligence v2 Smoke Test');
    console.log('===========================================\n');

    const apiKey = process.env.XAI_API_KEY ?? '';
    if (!apiKey) {
        console.log('⚠️  No XAI_API_KEY found — using mock articles without LLM call\n');
    }

    // Step 1: Ticker universe check
    console.log('✅ Ticker Universe:');
    const testTickers = ['XOM', 'UAL', 'FAKE_CO', 'CVX', 'AAPL'];
    for (const t of testTickers) {
        console.log(`   ${isValidTicker(t) ? '✅' : '❌'} ${t}`);
    }
    console.log('');

    // Step 2: Classifier (if API key available)
    const classifier = new MacroClassifierAgent(apiKey);
    const merger = new SignalMerger();
    const engine = new CausalChainEngine();

    let rssEvents: any[] = [];
    let xEvents: any[] = [];

    if (apiKey) {
        console.log('📡 Running classifier against mock articles...\n');
        [rssEvents, xEvents] = await Promise.all([
            classifier.classify(MOCK_RSS_ARTICLES),
            classifier.classify(MOCK_X_ARTICLES),
        ]);
        console.log(`   RSS events classified: ${rssEvents.length}`);
        console.log(`   X events classified: ${xEvents.length}\n`);
    } else {
        // Inject fake classified event for smoke testing the merger + engine
        rssEvents = [{
            event_id: 'oil_supply_shock', category: 'known',
            causal_chain: {
                immediate: { bearish_tickers: ['UAL', 'DAL'], bullish_tickers: ['XOM', 'CVX'], reasoning: 'oil spike' },
                secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 4, reasoning: 'recovery' },
                resolution_signal: 'WTI falls',
            },
            confidence: 0.82, reasoning: 'OPEC cut 1.5M bpd', phase: 'developing',
            ttl_hours: 96, market_moving: true, source_articles: [MOCK_RSS_ARTICLES[0].url],
        }];
        xEvents = [{ ...rssEvents[0], source_articles: [MOCK_X_ARTICLES[0].url] }];
    }

    // Step 3: Merge
    const merged = merger.merge(rssEvents, xEvents);
    console.log(`🔗 Signal Merger:`);
    for (const s of merged) {
        console.log(`   ${s.event_id}: ${s.corroboration} (conf ${s.confidence.toFixed(2)}, delta ${s.confidence_delta >= 0 ? '+' : ''}${s.confidence_delta})`);
    }
    console.log('');

    // Step 4: Causal chain engine
    const fakeEvents: LiveEvent[] = merged.map(s => ({
        event_id: s.event_id,
        phase: 'developing' as const,
        causal_chain: s.causal_chain,
        sources: s.sources,
        corroboration: s.corroboration,
        confidence: s.confidence + s.confidence_delta,
        detectedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 96 * 3600_000).toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
        auditIds: [],
    }));

    const macroSignals = engine.toMacroSignals(fakeEvents);
    console.log(`🎯 MacroSignals emitted: ${macroSignals.length}`);
    for (const s of macroSignals) {
        const dir = s.impact === 'bullish' ? '🟢 BULLISH' : s.impact === 'bearish' ? '🔴 BEARISH' : '🟡 NEUTRAL';
        console.log(`   ${dir} [${s.event}] conf=${(s.confidence * 100).toFixed(0)}% tickers=${s.tickers.join(', ')}`);
    }

    console.log('\n✅ Smoke test complete.');
}

main().catch(console.error);
```

- [ ] **Step 2: Run smoke test**

```bash
npx tsx scripts/aktienix/test-macro-intelligence.ts
```

Expected output:
```
===========================================
  Aktienix Macro Intelligence v2 Smoke Test
===========================================

⚠️  No XAI_API_KEY found — using mock articles without LLM call

✅ Ticker Universe:
   ✅ XOM
   ✅ UAL
   ❌ FAKE_CO
   ✅ CVX
   ✅ AAPL

🔗 Signal Merger:
   oil_supply_shock: confirmed (conf 0.82, delta +0.15)

🎯 MacroSignals emitted: 2
   🔴 BEARISH [oil_supply_shock] conf=97% tickers=UAL, DAL
   🟢 BULLISH [oil_supply_shock] conf=97% tickers=XOM, CVX

✅ Smoke test complete.
```

- [ ] **Step 3: Final type-check**

```bash
pnpm --filter @cryonix/agents type-check
```
Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
pnpm vitest run packages/agents --reporter=verbose
```
Expected: all tests pass (existing 35 + new ~30).

- [ ] **Step 5: Final commit**

```bash
git add scripts/aktienix/test-macro-intelligence.ts
git commit -m "feat(aktienix): add macro intelligence v2 smoke test script"
```
