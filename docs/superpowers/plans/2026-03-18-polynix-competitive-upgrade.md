# Polynix Competitive Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Polynix from a slow-settlement arb scanner into a high-frequency Polymarket trading system that trades 100+ bets/day across 5-min markets, copy trading, and weather arb — matching the performance seen in competing systems ($43K+, 31K+ trades).

**Architecture:** Four independent modules bolt onto the existing PolynixAgent loop. Each module is a scanner that feeds opportunities into the existing risk manager + order manager pipeline. The 5-min scanner discovers markets via Gamma API series slugs (`btc-updown-5m-*`), the copy tracker monitors top Polymarket trader positions on-chain, and the weather optimizer specializes arb detection for weather markets.

**Tech Stack:** TypeScript, Gamma API (REST), CLOB API (REST), Binance REST, existing StatePublisher + DbLogger + BayesianLearner infrastructure.

---

## Current State

- **28 open bets**, 2 settled, $2.50 P&L, 100% WR
- Finding 2-5 arb/cycle but blocked on max_exposure
- Directional engine filtered by backtest fixes (entry price < 0.80)
- Settlements take days/weeks (longest: Bulgaria election Apr 19)

## Target State

- **100+ bets/day** via 5-min crypto markets (every 5 min = 288 possible/day)
- Copy top Polymarket trader positions for directional alpha
- Weather markets auto-classified with optimized edge thresholds
- All strategies feed into shared risk manager + Bayesian learner

---

## File Structure

```
packages/agents/src/polynix/
  polynix-agent.ts           # MODIFY — integrate new scanners into main loop
  micro-market-scanner.ts    # CREATE — discover 5-min BTC/ETH/SOL markets via series slugs
  copy-tracker.ts            # CREATE — track top Polymarket trader positions
  weather-optimizer.ts       # CREATE — weather market arb specialization
  market-scanner.ts          # MODIFY — add series-based discovery
  config.ts                  # MODIFY — add new config sections
  types.ts                   # MODIFY — add new interfaces

polynix.toml                 # MODIFY — add micro_markets + copy_trader + weather sections
```

---

## Task 1: Discover 5-Minute Crypto Markets via Series Slugs

**Context:** Competitor screenshots show slugs like `eth-updown-5m-1773776288` and `btc-multistrike-4h-1758873600`. Polymarket organizes short-duration markets into **series** — repeating events with timestamps in the slug. The Gamma API supports `GET /events?slug={pattern}` queries.

**Files:**
- Create: `packages/agents/src/polynix/micro-market-scanner.ts`
- Modify: `packages/agents/src/polynix/types.ts`
- Modify: `polynix.toml`

- [ ] **Step 1: Probe Gamma API for 5-min series patterns**

Write a standalone probe script to discover what series exist:

```typescript
// scripts/strategy-lab/polynix-probe-series.ts
const GAMMA = 'https://gamma-api.polymarket.com';

const SERIES_PATTERNS = [
  'btc-updown-5m', 'eth-updown-5m', 'sol-updown-5m',
  'bitcoin-updown-5m', 'ethereum-updown-5m',
  'btc-5min', 'eth-5min', 'bitcoin-5min',
  'bitcoin-multi-strikes-5m', 'btc-multistrike-5m',
  'bitcoin-up-or-down', 'btc-up-or-down',
];

async function probe() {
  // Try /events?slug= prefix matching
  for (const pattern of SERIES_PATTERNS) {
    const url = `${GAMMA}/events?slug=${pattern}&closed=false&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log(`FOUND: ${pattern} → ${data.length} events`);
      for (const e of data) console.log(`  ${e.slug} | ${e.title}`);
    }
  }

  // Try /markets with keyword search
  for (const q of ['5 minutes', '5 min', 'up or down']) {
    const url = `${GAMMA}/markets?closed=false&active=true&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const matches = data.filter((m: any) =>
      m.question?.toLowerCase().includes(q)
    );
    if (matches.length > 0) {
      console.log(`KEYWORD "${q}": ${matches.length} matches`);
      for (const m of matches) console.log(`  ${m.question?.slice(0, 80)}`);
    }
  }

  // Try series endpoint if it exists
  for (const seriesSlug of ['bitcoin-up-or-down-5-min', 'crypto-5-minute', 'bitcoin-multi-strikes-5m']) {
    const url = `${GAMMA}/events?series=${seriesSlug}&closed=false&limit=5`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        console.log(`SERIES "${seriesSlug}": ${data.length} events`);
      }
    } catch { /* ignore */ }
  }
}

probe();
```

Run: `npx tsx scripts/strategy-lab/polynix-probe-series.ts`
Expected: Discover which slug patterns match active 5-min markets.

- [ ] **Step 2: Build MicroMarketScanner class**

Based on probe results, implement the scanner:

```typescript
// packages/agents/src/polynix/micro-market-scanner.ts

import type { CryptoMicroMarket, PolynixConfig } from './types';

const GAMMA = 'https://gamma-api.polymarket.com';

// Series slug patterns for 5-min crypto binary markets
// These are populated from probe results + competitor slug analysis
const MICRO_SERIES = [
  'btc-updown-5m',
  'eth-updown-5m',
  'sol-updown-5m',
];

export class MicroMarketScanner {
  /**
   * Find active 5-minute crypto markets by querying known series slugs.
   * Returns markets expiring in 30s-300s (the tradeable window).
   */
  async scan(): Promise<CryptoMicroMarket[]> {
    const results: CryptoMicroMarket[] = [];
    const now = Date.now();

    // Strategy 1: Query by series slug prefix
    for (const series of MICRO_SERIES) {
      try {
        const url = `${GAMMA}/events?slug=${series}&closed=false&active=true&limit=10`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) continue;
        const events = await res.json();
        if (!Array.isArray(events)) continue;

        for (const event of events) {
          for (const market of event.markets ?? []) {
            if (market.closed) continue;
            const expiresAt = new Date(market.endDate ?? event.endDate).getTime();
            const timeToExpiry = (expiresAt - now) / 1000;

            // Only trade markets 30s-300s from expiry
            if (timeToExpiry < 30 || timeToExpiry > 300) continue;

            // Parse token IDs
            let tokenIds: string[];
            try { tokenIds = JSON.parse(market.clobTokenIds); } catch { continue; }
            if (tokenIds.length !== 2) continue;

            const asset = this.extractAsset(event.title ?? market.question ?? '');

            results.push({
              conditionId: market.conditionId,
              questionId: market.questionID ?? market.id,
              title: market.question ?? event.title,
              asset: asset ?? 'BTC',
              expiresAt,
              timeToExpiry,
              yesTokenId: tokenIds[0],
              noTokenId: tokenIds[1],
              liquidity: parseFloat(market.liquidity ?? '0'),
              volume24hr: market.volume24hr ?? 0,
            });
          }
        }
      } catch { continue; }
    }

    // Strategy 2: Broad scan filtered by duration
    try {
      const url = `${GAMMA}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const markets = await res.json();
        for (const m of markets) {
          if (m.closed || !m.active) continue;
          const expiresAt = new Date(m.endDate).getTime();
          const timeToExpiry = (expiresAt - now) / 1000;
          if (timeToExpiry < 30 || timeToExpiry > 300) continue;

          // Must be binary
          let outcomes: string[];
          try { outcomes = JSON.parse(m.outcomes); } catch { continue; }
          if (outcomes.length !== 2) continue;

          let tokenIds: string[];
          try { tokenIds = JSON.parse(m.clobTokenIds); } catch { continue; }

          const title = m.question ?? '';
          const asset = this.extractAsset(title);
          if (!asset) continue; // Only crypto

          // Dedup
          if (results.some(r => r.conditionId === m.conditionId)) continue;

          results.push({
            conditionId: m.conditionId,
            questionId: m.questionID ?? m.id,
            title,
            asset,
            expiresAt,
            timeToExpiry,
            yesTokenId: tokenIds[0],
            noTokenId: tokenIds[1],
            liquidity: parseFloat(m.liquidity ?? '0'),
            volume24hr: m.volume24hr ?? 0,
          });
        }
      }
    } catch { /* continue */ }

    return results.sort((a, b) => a.timeToExpiry - b.timeToExpiry);
  }

  private extractAsset(text: string): string | null {
    const t = text.toUpperCase();
    if (t.includes('BITCOIN') || t.includes('BTC')) return 'BTC';
    if (t.includes('ETHEREUM') || t.includes('ETH')) return 'ETH';
    if (t.includes('SOLANA') || t.includes('SOL')) return 'SOL';
    return null;
  }
}
```

- [ ] **Step 3: Add config section for micro markets**

Add to `polynix.toml`:
```toml
[micro_markets]
enabled = true
scan_interval_ms = 10000        # 10s — fast markets need fast scanning
min_time_to_expiry_s = 30       # 30s minimum (need time to execute)
max_time_to_expiry_s = 300      # 5 minutes max
max_bet_size_usd = 9            # $9 per bet (matches competitor)
```

Update `types.ts` with `MicroMarketsConfig` interface.
Update `config.ts` with defaults + TOML merge.

- [ ] **Step 4: Integrate into PolynixAgent main loop**

Add a fast micro-market scan cycle alongside the existing 60s scan:

In `polynix-agent.ts`, add a separate timer for micro-markets that runs every 10s, independent of the main 60s loop. This catches the narrow 30-300s trading window.

```typescript
// In runLoop(), before the existing scan:
if (this.tomlConfig.micro_markets?.enabled) {
  const microMarkets = await this.microScanner.scan();
  for (const market of microMarkets) {
    // Use directional engine for 5-min bets
    // Use spread detector for micro-arb
    await this.handleMicroMarket(market);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/polynix/micro-market-scanner.ts \
  scripts/strategy-lab/polynix-probe-series.ts \
  packages/agents/src/polynix/types.ts \
  packages/agents/src/polynix/config.ts \
  packages/agents/src/polynix/polynix-agent.ts \
  polynix.toml
git commit -m "feat(polynix): add 5-min micro-market scanner via series slugs"
```

---

## Task 2: Copy Trader — Track Top Polymarket Performers

**Context:** Copy trading generates +$12K in the competitor setup (50.3% WR, 6059 trades). Polymarket has no public trader API, but the Data API (`data-api.polymarket.com`) is mentioned in our codebase as having leaderboard data. We probe it first, then build accordingly.

**Files:**
- Create: `packages/agents/src/polynix/copy-tracker.ts`
- Create: `scripts/strategy-lab/polynix-probe-leaderboard.ts`
- Modify: `packages/agents/src/polynix/polynix-agent.ts`
- Modify: `polynix.toml`

- [ ] **Step 1: Probe Polymarket Data API for leaderboard endpoints**

```typescript
// scripts/strategy-lab/polynix-probe-leaderboard.ts
const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function probe() {
  const endpoints = [
    `${DATA_API}/leaderboard`,
    `${DATA_API}/leaderboard?limit=10`,
    `${DATA_API}/rankings`,
    `${DATA_API}/top-traders`,
    `${DATA_API}/users`,
    `${DATA_API}/positions`,
    `${DATA_API}/activity`,
    `${GAMMA_API}/leaderboard`,
    `${GAMMA_API}/profiles`,
    // Polymarket profile API (seen in competitor tools)
    `https://polymarket.com/api/leaderboard`,
    `https://polymarket.com/api/profile`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json' },
      });
      const status = res.status;
      const body = await res.text();
      const preview = body.slice(0, 200);
      console.log(`${status} ${url}`);
      if (status < 400) console.log(`  ${preview}\n`);
    } catch (e: any) {
      console.log(`ERR ${url}: ${e.message}`);
    }
  }
}

probe();
```

Run: `npx tsx scripts/strategy-lab/polynix-probe-leaderboard.ts`
Expected: Find which endpoints return trader/leaderboard data.

- [ ] **Step 2: Build CopyTracker based on probe results**

```typescript
// packages/agents/src/polynix/copy-tracker.ts

export interface TopTrader {
  address: string;
  username?: string;
  pnl: number;
  volume: number;
  winRate: number;
  recentBets: TraderBet[];
}

export interface TraderBet {
  marketId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  size: number;
  price: number;
  timestamp: number;
}

export class CopyTracker {
  private topTraders: TopTrader[] = [];
  private lastRefresh = 0;
  private refreshInterval = 15 * 60 * 1000; // 15min

  /**
   * Fetch top traders and their recent positions.
   * Adapter pattern — implementation depends on probe results.
   */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastRefresh < this.refreshInterval) return;

    // Implementation varies based on available API:
    // Option A: Data API leaderboard
    // Option B: Web scraping polymarket.com/leaderboard
    // Option C: On-chain position tracking
    // Stubbed until probe reveals available endpoints

    this.lastRefresh = Date.now();
  }

  /**
   * Get copy signals: markets where top traders have recently bet.
   * Returns only markets with consensus (2+ top traders on same side).
   */
  getCopySignals(): { marketId: string; side: 'YES' | 'NO'; confidence: number; traders: number }[] {
    // Aggregate recent bets by market
    const marketBets = new Map<string, { yes: number; no: number }>();

    for (const trader of this.topTraders) {
      for (const bet of trader.recentBets) {
        const existing = marketBets.get(bet.marketId) ?? { yes: 0, no: 0 };
        if (bet.side === 'YES') existing.yes++;
        else existing.no++;
        marketBets.set(bet.marketId, existing);
      }
    }

    const signals: { marketId: string; side: 'YES' | 'NO'; confidence: number; traders: number }[] = [];
    for (const [marketId, counts] of marketBets) {
      const total = counts.yes + counts.no;
      if (total < 2) continue; // Need consensus

      const side = counts.yes > counts.no ? 'YES' as const : 'NO' as const;
      const majority = Math.max(counts.yes, counts.no);
      const confidence = majority / total;

      if (confidence >= 0.6) {
        signals.push({ marketId, side, confidence, traders: total });
      }
    }

    return signals;
  }
}
```

- [ ] **Step 3: Add config + integrate into agent loop**

```toml
[copy_trader]
enabled = false                 # Disabled until probe confirms API availability
refresh_interval_min = 15
min_consensus_traders = 2
min_confidence = 0.6
max_bet_size_usd = 10
```

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/polynix/copy-tracker.ts \
  scripts/strategy-lab/polynix-probe-leaderboard.ts \
  polynix.toml
git commit -m "feat(polynix): add copy trader scaffold + API probes"
```

---

## Task 3: Increase Bet Frequency — Faster Scanning + More Markets

**Context:** Competitors run 100-288 bets/day. We run ~5/day. Three changes needed:
1. Scan more frequently (60s → 30s for standard markets)
2. Scan more markets per cycle (80 → 150)
3. Lower arb threshold to catch more opportunities
4. Reduce min_liquidity to include more markets

**Files:**
- Modify: `polynix.toml`
- Modify: `packages/agents/src/polynix/polynix-agent.ts` — add dedup guard to prevent re-betting same market

- [ ] **Step 1: Update config for higher throughput**

```toml
# Updated polynix.toml sections:
[strategy]
arb_threshold = 0.97            # Was 0.96 — catch more near-threshold arbs
min_liquidity_usd = 200         # Was 500 — include thinner markets
max_markets_per_scan = 150      # Was 80 — scan more per cycle

[timing]
scan_interval_ms = 30000        # Was 60000 — scan every 30s
```

- [ ] **Step 2: Add market dedup guard**

Prevent re-entering the same market (by conditionId) if we already have an open position:

```typescript
// In polynix-agent.ts checkArb() and directional evaluation:
// Before risk check, add:
const alreadyHolding = this.positionTracker.getOpen()
  .some(p => p.market.conditionId === market.conditionId);
if (alreadyHolding) return null;
```

- [ ] **Step 3: Track daily bet count and log it**

Add to heartbeat: `bets_today=X` counter, reset daily. This lets us measure if we're hitting the 100/day target.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(polynix): increase scan frequency + market coverage for 100+ bets/day"
```

---

## Task 4: Weather Market Arb Optimization

**Context:** Competitor runs "Weather Arb" at 73.3% WR (+$68). Weather markets are high-volume on Polymarket (temperature predictions) with predictable settlement (official weather data). Our arb scanner already catches them but doesn't optimize for their unique characteristics.

**Files:**
- Create: `packages/agents/src/polynix/weather-optimizer.ts`
- Modify: `packages/agents/src/polynix/polynix-agent.ts`

- [ ] **Step 1: Build WeatherOptimizer**

```typescript
// packages/agents/src/polynix/weather-optimizer.ts

import type { CryptoMicroMarket, ArbOpportunity } from './types';

/**
 * Weather markets have properties that make arb more reliable:
 * 1. Settlement is objective (official temperature readings)
 * 2. Markets cluster (10+ temperature buckets per city per day)
 * 3. Adjacent buckets often have correlated mispricing
 * 4. High volume, regular liquidity replenishment
 *
 * This optimizer:
 * - Identifies weather market clusters (same city, same day)
 * - Prioritizes clusters with multiple arb opportunities
 * - Adjusts sizing based on cluster confidence
 */

const WEATHER_KEYWORDS = ['temperature', 'weather', '°F', '°C', 'highest temp', 'lowest temp'];

export class WeatherOptimizer {
  isWeatherMarket(market: CryptoMicroMarket): boolean {
    const q = market.title.toLowerCase();
    return WEATHER_KEYWORDS.some(kw => q.includes(kw));
  }

  /**
   * Group weather arb opportunities by city+date cluster.
   * If multiple arbs exist in same cluster, boost confidence.
   */
  optimizeArbs(arbs: ArbOpportunity[]): ArbOpportunity[] {
    const weatherArbs = arbs.filter(a => this.isWeatherMarket(a.market));
    if (weatherArbs.length === 0) return arbs;

    // Group by city + date
    const clusters = new Map<string, ArbOpportunity[]>();
    for (const arb of weatherArbs) {
      const key = this.extractClusterKey(arb.market.title);
      if (!key) continue;
      const existing = clusters.get(key) ?? [];
      existing.push(arb);
      clusters.set(key, existing);
    }

    // Clusters with 2+ arbs are higher confidence (systematic mispricing)
    const boosted: ArbOpportunity[] = [];
    for (const [_key, clusterArbs] of clusters) {
      if (clusterArbs.length >= 2) {
        // Sort by net edge descending, take best opportunities
        clusterArbs.sort((a, b) => b.netEdge - a.netEdge);
        boosted.push(...clusterArbs);
      } else {
        boosted.push(...clusterArbs);
      }
    }

    // Return weather arbs (sorted by edge) + non-weather arbs
    const nonWeather = arbs.filter(a => !this.isWeatherMarket(a.market));
    return [...boosted, ...nonWeather];
  }

  /**
   * Extract cluster key: "dallas-2026-03-19", "london-2026-03-20"
   */
  private extractClusterKey(title: string): string | null {
    const cities = ['dallas', 'london', 'paris', 'tokyo', 'seoul', 'shanghai',
      'miami', 'chicago', 'seattle', 'buenos aires', 'sydney', 'mumbai'];
    const t = title.toLowerCase();
    const city = cities.find(c => t.includes(c));
    if (!city) return null;

    // Extract date: "March 19" → "2026-03-19"
    const dateMatch = title.match(/(march|april|may|june|july|august|september|october|november|december|january|february)\s+(\d{1,2})/i);
    if (!dateMatch) return null;

    return `${city}-${dateMatch[1].toLowerCase()}-${dateMatch[2]}`;
  }
}
```

- [ ] **Step 2: Integrate into arb scanning**

In `polynix-agent.ts`, after collecting arb opportunities, pass through weather optimizer:

```typescript
// After arb batch scanning:
if (this.weatherOptimizer) {
  const optimized = this.weatherOptimizer.optimizeArbs(collectedArbs);
  // Execute optimized arbs in priority order
}
```

- [ ] **Step 3: Add weather-specific Bayesian categories**

When recording outcomes, tag weather markets specifically:
```typescript
if (this.weatherOptimizer.isWeatherMarket(pos.market)) {
  await this.bayesian.recordOutcome({ ...features, type: 'arb', asset: 'WEATHER' });
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/polynix/weather-optimizer.ts \
  packages/agents/src/polynix/polynix-agent.ts
git commit -m "feat(polynix): add weather market arb optimizer with cluster detection"
```

---

## Execution Order

```
Task 1 (5-min markets)  ←— CRITICAL: probe first to validate markets exist
Task 3 (bet frequency)  ←— QUICK WIN: config changes only
Task 4 (weather arb)    ←— MEDIUM: new module but simple logic
Task 2 (copy trader)    ←— BLOCKED until API probe confirms endpoints
```

**Task 1 must run the probe script first** — if 5-min markets don't exist via Gamma API, we pivot to alternative discovery (web scraping, slug enumeration).

**Task 2 is speculative** — depends on what the leaderboard probe reveals. May need to pivot to on-chain tracking or web scraping.

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Bets/day | 5 | 50+ (100+ with 5-min markets) |
| Settlement time | Days-weeks | Minutes-hours (5-min markets) |
| Bayesian observations/day | <1 | 20+ |
| Strategies | 2 (arb + directional) | 4 (+ micro + copy + weather) |
| Arb hit rate | 2-5/cycle | 5-10/cycle (lower threshold + more markets) |

---

## Risk Considerations

1. **5-min markets may not be discoverable** via public Gamma API — probe first
2. **Copy trader API may not exist** — have fallback plan (on-chain tracking)
3. **Higher frequency = more API calls** — respect rate limits (1 req/s Gamma, no cap on CLOB)
4. **Weather arb clusters** — correlated positions mean correlated losses if weather API is wrong
5. **$9 bet size on micro markets** — small enough to limit damage while learning
