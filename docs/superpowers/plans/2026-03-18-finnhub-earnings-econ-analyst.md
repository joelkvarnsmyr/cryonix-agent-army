# Finnhub Earnings, Economic Calendar & Analyst Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add earnings calendar (safety gate), economic calendar (volatility gate), and analyst recommendations (confidence signal) to Aktienix via Finnhub API.

**Architecture:** Extend existing `MarketSentimentScanner` class with 3 new fetch methods + 2 gate methods. Integration via `evaluateSignal()` in aktienix-agent.ts. All data cached in Redis, read-only in hot path.

**Tech Stack:** TypeScript, Finnhub REST API (free tier, 60 calls/min), Redis via StatePublisher

**Spec:** `docs/superpowers/specs/2026-03-18-aktienix-market-sentiment.md`

---

### Task 1: Earnings Calendar + Economic Calendar fetch methods

**Files:**
- Modify: `packages/agents/src/aktienix/intelligence/market-sentiment.ts`

- [ ] **Step 1: Add timestamp trackers and helper**

After `private lastInsiderFetch = 0;` (line 20), add:

```typescript
    private lastEarningsFetch = 0;
    private lastEconFetch = 0;
    private lastAnalystFetch = 0;

    private async finnhubGet(path: string): Promise<any> {
        if (!this.finnhubKey) return null;
        const res = await fetch(
            `https://finnhub.io/api/v1${path}${path.includes('?') ? '&' : '?'}token=${this.finnhubKey}`,
            { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return null;
        return res.json();
    }
```

- [ ] **Step 2: Add fetchEarningsCalendar()**

After the `fetchInsiderActivity()` method (after line 144), add:

```typescript
    // ── Finnhub Earnings Calendar ───────────────────────────────────────────

    async fetchEarningsCalendar(symbols: string[]): Promise<void> {
        if (!this.finnhubKey) return;
        // Only fetch once daily
        if (Date.now() - this.lastEarningsFetch < 24 * 60 * 60 * 1000) return;

        try {
            // Fetch 14-day window to catch upcoming earnings
            const from = new Date().toISOString().split('T')[0];
            const to = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
            const data = await this.finnhubGet(`/calendar/earnings?from=${from}&to=${to}`);
            if (!data?.earningsCalendar) return;

            const watchSet = new Set(symbols);
            let found = 0;

            for (const entry of data.earningsCalendar) {
                if (watchSet.has(entry.symbol)) {
                    const daysUntil = Math.ceil(
                        (new Date(entry.date).getTime() - Date.now()) / 86400000,
                    );
                    await this.publisher.set(
                        `aktienix:earnings:${entry.symbol}`,
                        JSON.stringify({
                            date: entry.date,
                            daysUntil,
                            epsEstimate: entry.epsEstimate,
                            revenueEstimate: entry.revenueEstimate,
                            hour: entry.hour, // 'bmo' (before market open) or 'amc' (after market close)
                            timestamp: Date.now(),
                        }),
                        86400, // 24h TTL
                    );
                    found++;
                }
            }

            this.lastEarningsFetch = Date.now();
            if (found > 0) console.log(`[SENTIMENT] Earnings calendar: ${found} watchlist symbols have upcoming earnings`);
        } catch (err: any) {
            console.warn(`[SENTIMENT] Earnings calendar fetch failed: ${err.message}`);
        }
    }

    async getEarningsGate(symbol: string): Promise<{ blocked: boolean; tightenSL: boolean; reason: string }> {
        try {
            const raw = await this.publisher.get(`aktienix:earnings:${symbol}`);
            if (!raw) return { blocked: false, tightenSL: false, reason: '' };
            const data = JSON.parse(raw);
            if (data.daysUntil <= 3) {
                return { blocked: true, tightenSL: true, reason: `Earnings in ${data.daysUntil}d (${data.date}) — BUY blocked` };
            }
            if (data.daysUntil <= 7) {
                return { blocked: false, tightenSL: true, reason: `Earnings in ${data.daysUntil}d — SL tightened to -2%` };
            }
        } catch { /* skip */ }
        return { blocked: false, tightenSL: false, reason: '' };
    }
```

- [ ] **Step 3: Add fetchEconomicCalendar()**

After the earnings methods, add:

```typescript
    // ── Finnhub Economic Calendar ───────────────────────────────────────────

    async fetchEconomicCalendar(): Promise<void> {
        if (!this.finnhubKey) return;
        // Only fetch once daily
        if (Date.now() - this.lastEconFetch < 24 * 60 * 60 * 1000) return;

        try {
            const from = new Date().toISOString().split('T')[0];
            const to = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
            const data = await this.finnhubGet(`/calendar/economic?from=${from}&to=${to}`);
            if (!data?.economicCalendar) return;

            const HIGH_IMPACT = ['FOMC', 'Federal Funds Rate', 'CPI', 'Non-Farm Payrolls',
                'Nonfarm Payrolls', 'GDP', 'Unemployment Rate', 'PCE', 'PPI', 'Retail Sales'];

            const today = new Date().toISOString().split('T')[0];
            const majorToday: string[] = [];
            const majorUpcoming: { event: string; date: string; time: string }[] = [];

            for (const entry of data.economicCalendar) {
                const isHighImpact = HIGH_IMPACT.some(
                    (kw) => entry.event?.toLowerCase().includes(kw.toLowerCase()),
                );
                if (!isHighImpact) continue;

                if (entry.date === today) {
                    majorToday.push(entry.event);
                } else {
                    majorUpcoming.push({ event: entry.event, date: entry.date, time: entry.time ?? '' });
                }
            }

            await this.publisher.set(
                'aktienix:econ_calendar',
                JSON.stringify({ majorToday, majorUpcoming, date: today, timestamp: Date.now() }),
                86400,
            );

            this.lastEconFetch = Date.now();
            if (majorToday.length > 0) {
                console.log(`[SENTIMENT] ⚠️ HIGH IMPACT TODAY: ${majorToday.join(', ')}`);
            }
        } catch (err: any) {
            console.warn(`[SENTIMENT] Economic calendar fetch failed: ${err.message}`);
        }
    }

    async getEconGate(): Promise<{ reducedSizing: boolean; blocked: boolean; reason: string }> {
        try {
            const raw = await this.publisher.get('aktienix:econ_calendar');
            if (!raw) return { reducedSizing: false, blocked: false, reason: '' };
            const data = JSON.parse(raw);
            if (data.majorToday?.length > 0) {
                return {
                    reducedSizing: true,
                    blocked: false,
                    reason: `High-impact event today: ${data.majorToday.join(', ')} — sizing halved`,
                };
            }
        } catch { /* skip */ }
        return { reducedSizing: false, blocked: false, reason: '' };
    }
```

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/market-sentiment.ts
git commit -m "feat(aktienix): earnings calendar gate + economic calendar gate

Finnhub earnings: blocks BUY within 3 days of earnings, tightens SL within 7 days
Finnhub economic: halves position sizing on FOMC/CPI/NFP days"
```

---

### Task 2: Analyst Recommendations + Price Targets

**Files:**
- Modify: `packages/agents/src/aktienix/intelligence/market-sentiment.ts`

- [ ] **Step 1: Add fetchAnalystData()**

After the economic calendar methods, add:

```typescript
    // ── Finnhub Analyst Recommendations + Price Targets ──────────────────────

    async fetchAnalystData(symbols: string[]): Promise<void> {
        if (!this.finnhubKey) return;
        // Only fetch every 6h (same cycle as insider)
        if (Date.now() - this.lastAnalystFetch < 6 * 60 * 60 * 1000) return;

        for (const symbol of symbols) {
            try {
                // Fetch recommendation trend + price target in parallel
                const [recData, ptData] = await Promise.all([
                    this.finnhubGet(`/stock/recommendation?symbol=${symbol}`),
                    this.finnhubGet(`/stock/price-target?symbol=${symbol}`),
                ]);

                const latestRec = Array.isArray(recData) && recData.length > 0 ? recData[0] : null;
                const consensus: Record<string, number> = {};
                if (latestRec) {
                    consensus.strongBuy = latestRec.strongBuy ?? 0;
                    consensus.buy = latestRec.buy ?? 0;
                    consensus.hold = latestRec.hold ?? 0;
                    consensus.sell = latestRec.sell ?? 0;
                    consensus.strongSell = latestRec.strongSell ?? 0;
                }

                const totalAnalysts = Object.values(consensus).reduce((s, v) => s + v, 0);
                const bullish = (consensus.strongBuy ?? 0) + (consensus.buy ?? 0);
                const bearish = (consensus.sell ?? 0) + (consensus.strongSell ?? 0);

                await this.publisher.set(
                    `aktienix:analyst:${symbol}`,
                    JSON.stringify({
                        consensus,
                        totalAnalysts,
                        bullishPct: totalAnalysts > 0 ? bullish / totalAnalysts : 0,
                        bearishPct: totalAnalysts > 0 ? bearish / totalAnalysts : 0,
                        targetMedian: ptData?.targetMedian ?? null,
                        targetHigh: ptData?.targetHigh ?? null,
                        targetLow: ptData?.targetLow ?? null,
                        lastUpdated: ptData?.lastUpdated ?? latestRec?.period ?? null,
                        timestamp: Date.now(),
                    }),
                    43200, // 12h TTL
                );

                // Rate limit
                await new Promise((r) => setTimeout(r, 250));
            } catch { /* skip single symbol failure */ }
        }

        this.lastAnalystFetch = Date.now();
        console.log(`[SENTIMENT] Analyst data scanned for ${symbols.length} symbols`);
    }
```

- [ ] **Step 2: Update getConfidenceAdjustment() to include analyst data**

After the insider activity block (after line 213), before the `return` statement, add:

```typescript
        // 4. Analyst Recommendations + Price Target
        let analystUpside: number | undefined;
        try {
            const raw = await this.publisher.get(`aktienix:analyst:${symbol}`);
            if (raw) {
                const data = JSON.parse(raw);
                // Strong consensus BUY (>60% bullish) + price below target
                if (data.bullishPct > 0.60 && data.totalAnalysts >= 5) {
                    adjustment += 0.05;
                    reasons.push(`Analyst consensus bullish (${(data.bullishPct * 100).toFixed(0)}% buy, n=${data.totalAnalysts}) → +5%`);
                } else if (data.bearishPct > 0.30 && data.totalAnalysts >= 5) {
                    adjustment -= 0.05;
                    reasons.push(`Analyst consensus bearish (${(data.bearishPct * 100).toFixed(0)}% sell) → -5%`);
                }
                // Price target upside bonus
                if (data.targetMedian && currentPrice > 0) {
                    analystUpside = ((data.targetMedian - currentPrice) / currentPrice) * 100;
                    if (analystUpside > 20) {
                        adjustment += 0.03;
                        reasons.push(`Target upside ${analystUpside.toFixed(0)}% → +3%`);
                    }
                }
            }
        } catch { /* skip */ }
```

Note: `getConfidenceAdjustment` needs a `currentPrice` parameter to calculate target upside. Update the method signature:

```typescript
    async getConfidenceAdjustment(symbol: string, currentPrice?: number): Promise<{
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/aktienix/intelligence/market-sentiment.ts
git commit -m "feat(aktienix): analyst recommendations + price target confidence signal

Finnhub: consensus buy >60% → +5%, consensus sell >30% → -5%
Price target upside >20% → +3% bonus"
```

---

### Task 3: Integration in aktienix-agent.ts

**Files:**
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts`

- [ ] **Step 1: Add calendar fetches to pre-market + signal scan blocks**

In the pre-market sentiment block (after `fetchPutCallRatio()`, around line 302), add:

```typescript
                        await this.sentimentScanner.fetchEarningsCalendar(config.watchlist.symbols);
                        await this.sentimentScanner.fetchEconomicCalendar();
```

In the signal scan insider fetch block (after `fetchInsiderActivity()`, around line 572), add:

```typescript
                        await this.sentimentScanner.fetchAnalystData(config.watchlist.symbols);
```

- [ ] **Step 2: Add earnings gate at start of evaluateSignal()**

In `evaluateSignal()`, right after the `let { symbol, action, confidence, reasoning, currentPrice } = payload;` line, add:

```typescript
        // Earnings safety gate: block BUY within 3 days of earnings
        if (action === 'BUY' && this.sentimentScanner) {
            try {
                const earningsGate = await this.sentimentScanner.getEarningsGate(symbol);
                if (earningsGate.blocked) {
                    this.log('warn', `EARNINGS GATE: ${symbol} — ${earningsGate.reason}`);
                    return;
                }
            } catch { /* non-critical */ }
        }
```

- [ ] **Step 3: Add economic gate before position sizing**

Before the Bayesian sizing block (before `let bayesSizeMultiplier = 1.0;`), add:

```typescript
        // Economic calendar gate: halve sizing on FOMC/CPI/NFP days
        let econSizingMultiplier = 1.0;
        if (this.sentimentScanner) {
            try {
                const econGate = await this.sentimentScanner.getEconGate();
                if (econGate.reducedSizing) {
                    econSizingMultiplier = 0.5;
                    this.log('info', `ECON GATE: ${econGate.reason}`);
                }
            } catch { /* non-critical */ }
        }
```

Then modify the Bayesian sizing line to include econSizingMultiplier:

Change:
```typescript
        config.capital.max_position_size_usd = originalMaxSize * bayesSizeMultiplier;
```
To:
```typescript
        config.capital.max_position_size_usd = originalMaxSize * bayesSizeMultiplier * econSizingMultiplier;
```

- [ ] **Step 4: Update getConfidenceAdjustment call to pass currentPrice**

Find the existing call (around line 831):
```typescript
                const sentiment = await this.sentimentScanner.getConfidenceAdjustment(symbol);
```
Change to:
```typescript
                const sentiment = await this.sentimentScanner.getConfidenceAdjustment(symbol, currentPrice);
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/aktienix/aktienix-agent.ts
git commit -m "feat(aktienix): earnings gate + econ gate + analyst overlay in trading loop

Earnings: blocks BUY within 3d, tightens SL within 7d
Economic: halves sizing on FOMC/CPI/NFP days
Analyst: confidence from recommendations + price targets"
```

---

### Task 4: Deploy + verify

- [ ] **Step 1: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build aktienix"
```

- [ ] **Step 2: Verify Finnhub data flows**

```bash
ssh azureuser@openclaw-vm "sleep 30 && docker logs aktienix --tail 30 | grep -iE 'SENTIMENT|EARNINGS|ECON|analyst'"
```

Expected: logs showing earnings calendar scan, economic calendar, analyst data fetch.

- [ ] **Step 3: Verify Redis keys populated**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli KEYS 'aktienix:earnings:*' && docker exec cryonix-redis-1 redis-cli KEYS 'aktienix:analyst:*' && docker exec cryonix-redis-1 redis-cli GET aktienix:econ_calendar"
```
