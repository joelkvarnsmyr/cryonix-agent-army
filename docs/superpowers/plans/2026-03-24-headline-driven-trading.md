# Headline-Driven Trading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture headline-driven market moves by scanning breaking news via Grok every 5 minutes and bridging Aktienix stock rallies to Cryonix crypto signals within a 1-4h lag window.

**Architecture:** Two independent systems. (1) Headlines Scanner: a lightweight loop that calls Grok to scan X/Twitter for market-moving events, writes sentiment to Redis, auto-trade reads it and boosts/penalizes signals. (2) Cross-Market Lag: Aktienix publishes stock performance to Redis, auto-trade reads it and boosts crypto when stocks rally. Both follow the exact same pattern as the existing Polymarket boost (Step 3e in auto-trade).

**Tech Stack:** TypeScript, Grok/xAI API (existing), Redis, ioredis, Docker

---

## File Map

```
CREATE  scripts/services/headline-scanner.ts              # Task 1: Grok headlines scanner (5min loop)
CREATE  packages/agents/src/shared/headline-types.ts       # Task 1: Shared types
MODIFY  apps/web/src/app/api/auto-trade/route.ts           # Task 2: Headline boost (Step 3h)
MODIFY  apps/web/src/app/api/auto-trade/route.ts           # Task 3: Cross-market lag boost (Step 3i)
MODIFY  packages/agents/src/aktienix/aktienix-agent.ts      # Task 3: Publish stock performance to Redis
MODIFY  cryonix.toml                                       # Task 4: Config section
CREATE  Dockerfile.headlines                                 # Task 5: Lightweight Docker image
MODIFY  docker-compose.prod.yml                            # Task 5: Docker service
```

---

## Task 1: Headlines Scanner — Grok X/Twitter Scan Every 5 Minutes

**Problem:** Trump tweets, Fed announcements, hack reports, and geopolitical events move markets in minutes. Our NewsScoutTank scans RSS every 15min (too slow). Grok has live X access.

**Files:**
- Create: `packages/agents/src/shared/headline-types.ts`
- Create: `scripts/services/headline-scanner.ts`

- [ ] **Step 1: Create headline types**

Create `packages/agents/src/shared/headline-types.ts`:

```typescript
export interface HeadlineScan {
    /** -3 (crash-level bearish) to +3 (euphoric bullish) */
    impact: number;
    /** What happened in 1-2 sentences */
    summary: string;
    /** Category */
    category: 'geopolitik' | 'fed' | 'crypto' | 'earnings' | 'trade_war' | 'regulation' | 'hack' | 'other';
    /** Which assets are most affected */
    affectedAssets: string[];
    /** Raw source tweets/headlines */
    sources: string[];
    /** Confidence in this assessment 0-1 */
    confidence: number;
}

export interface HeadlineState {
    scan: HeadlineScan;
    timestamp: number;
    /** 'bullish' | 'bearish' | 'neutral' */
    direction: 'bullish' | 'bearish' | 'neutral';
    /** Seconds since the event broke */
    ageSeconds: number;
}
```

- [ ] **Step 2: Create headline scanner**

Create `scripts/services/headline-scanner.ts`:

```typescript
import OpenAI from 'openai';
import Redis from 'ioredis';

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEADLINE_TTL = 1800; // 30 minutes — headlines are stale fast

const redis = new Redis(process.env.KV_URL || 'redis://localhost:6379');
const grok = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
});

async function scanHeadlines(): Promise<void> {
    try {
        const response = await grok.chat.completions.create({
            model: 'grok-3-mini',
            messages: [{
                role: 'user',
                content: `You have access to real-time X/Twitter data.

Scan X/Twitter RIGHT NOW for any market-moving events in the last 10 minutes.
Focus on: geopolitical news, Fed/central bank statements, crypto-specific events,
major earnings surprises, trade war developments, regulatory actions, hacks/exploits.

If nothing significant happened, respond with impact: 0.

Respond ONLY as JSON:
{
    "impact": -3 to +3 (0 = nothing, 1 = minor, 2 = notable, 3 = major),
    "summary": "what happened",
    "category": "geopolitik|fed|crypto|earnings|trade_war|regulation|hack|other",
    "affectedAssets": ["BTC", "ETH", "SOL", "STOCKS", "OIL", etc],
    "sources": ["@user: tweet summary", ...],
    "confidence": 0.0 to 1.0
}`
            }],
            temperature: 0.1,
            max_tokens: 500,
        });

        const text = response.choices[0]?.message?.content?.trim();
        if (!text) return;

        // Parse JSON from response (handle markdown code blocks)
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const scan = JSON.parse(jsonStr);

        if (typeof scan.impact !== 'number') return;

        const direction = scan.impact > 0 ? 'bullish' : scan.impact < 0 ? 'bearish' : 'neutral';
        const state = {
            scan,
            timestamp: Date.now(),
            direction,
            ageSeconds: 0,
        };

        // Always write latest scan (even impact=0, so consumers know scanner is alive)
        await redis.set('headlines:latest', JSON.stringify(state), 'EX', HEADLINE_TTL);

        // Only write to active key if impact is meaningful (|impact| >= 2)
        if (Math.abs(scan.impact) >= 2) {
            await redis.set('headlines:active', JSON.stringify(state), 'EX', HEADLINE_TTL);
            console.log(`[HEADLINES] 🔴 ACTIVE: impact=${scan.impact} ${direction} | ${scan.summary}`);

            // Push to history for analysis
            await redis.lpush('headlines:history', JSON.stringify(state));
            await redis.ltrim('headlines:history', 0, 99); // Keep last 100
        } else {
            console.log(`[HEADLINES] Scan complete: impact=${scan.impact} (${scan.summary || 'nothing notable'})`);
        }
    } catch (err) {
        console.warn('[HEADLINES] Scan error:', err instanceof Error ? err.message : err);
    }
}

// ── Main loop ──────────────────────────────────────────────────

async function main() {
    console.log('============================================================');
    console.log('  Headline Scanner — Grok X/Twitter Monitor');
    console.log(`  Interval: ${SCAN_INTERVAL_MS / 1000}s`);
    console.log('============================================================');

    // Initial scan
    await scanHeadlines();

    // Loop
    setInterval(scanHeadlines, SCAN_INTERVAL_MS);
}

main().catch(err => {
    console.error('[HEADLINES] Fatal:', err);
    process.exit(1);
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/shared/headline-types.ts scripts/services/headline-scanner.ts
git commit -m "feat(headlines): add Grok X/Twitter headline scanner (5min loop)

Scans X for market-moving events every 5min via Grok API.
Impact scale -3 to +3. Categories: geopolitik, fed, crypto, hack, etc.
Writes to Redis headlines:latest (always) and headlines:active (|impact| >= 2).
30min TTL — headlines go stale fast."
```

---

## Task 2: Headline Boost in Auto-Trade — Step 3h

**Problem:** Auto-trade processes signals through multiple boost/penalty steps (Polymarket is Step 3e). Add Step 3h for headlines.

**Pattern:** Identical to Polymarket boost — read Redis key, adjust confidence based on sentiment.

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` (after Step 3e Polymarket, ~line 3880)

- [ ] **Step 1: Add headline boost after Polymarket boost**

Find the end of Step 3e (Polymarket adjustments). After the closing `} catch { /* Polymarket */}` block, add Step 3h:

```typescript
    // STEP 3f: Breaking news headline adjustments
    try {
      const headlineRaw = await redis.get('headlines:active');
      if (headlineRaw) {
        const headline = JSON.parse(headlineRaw);
        const scan = headline.scan;
        const ageMin = (Date.now() - headline.timestamp) / 60000;

        // Headlines decay — full boost in first 15min, half after 15min
        const freshness = ageMin <= 15 ? 1.0 : ageMin <= 30 ? 0.5 : 0.25;

        for (const p of parsed) {
          const baseAsset = p.signal.symbol.split('/')[0];
          const isAffected = scan.affectedAssets.includes(baseAsset)
              || scan.affectedAssets.includes('CRYPTO')
              || scan.affectedAssets.includes('STOCKS'); // cross-market

          if (!isAffected) continue;

          if (headline.direction === 'bullish' && scan.impact >= 2) {
            // Bullish headline — boost BUY signals
            const boost = (TOML?.headlines?.bullish_boost ?? 0.10) * freshness;
            p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
            p.signal.reason += ` | 📰 Headline bullish (${scan.impact}) +${(boost * 100).toFixed(0)}%: ${scan.summary.slice(0, 60)}`;
            console.log(`[HEADLINES] 📰 ${p.signal.symbol}: bullish boost +${(boost * 100).toFixed(0)}% (impact=${scan.impact}, age=${ageMin.toFixed(0)}min)`);
          } else if (headline.direction === 'bearish' && scan.impact <= -2) {
            // Bearish headline — penalize BUY signals (or boost if deep value dip)
            const patterns = p.signal.patterns || [];
            const isDeepValue = patterns.some((pt: string) => ['DEEP_VALUE_CRASH', 'DIP_BUY'].includes(pt));

            if (isDeepValue && scan.category !== 'hack') {
              // Deep value + bearish headlines (not hack) = contrarian opportunity
              const boost = (TOML?.headlines?.contrarian_dv_boost ?? 0.08) * freshness;
              p.signal.confidence = Math.min(0.95, p.signal.confidence + boost);
              p.signal.reason += ` | 📰 Headline bearish contrarian DV +${(boost * 100).toFixed(0)}%: ${scan.summary.slice(0, 60)}`;
              console.log(`[HEADLINES] 📰 ${p.signal.symbol}: contrarian DV boost +${(boost * 100).toFixed(0)}% (impact=${scan.impact})`);
            } else {
              // Normal bearish penalty
              const penalty = (TOML?.headlines?.bearish_penalty ?? 0.12) * freshness;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 📰 Headline bearish (${scan.impact}) -${(penalty * 100).toFixed(0)}%: ${scan.summary.slice(0, 60)}`;
              console.log(`[HEADLINES] 📰 ${p.signal.symbol}: bearish penalty -${(penalty * 100).toFixed(0)}% (impact=${scan.impact})`);
            }
          }
        }
      }
    } catch { /* Headlines data unavailable — skip */ }
```

**Key design decisions:**
- **Freshness decay**: Full boost first 15min, half 15-30min, quarter after 30min. Headlines go stale fast.
- **Contrarian DV**: Bearish headlines + deep value dip = buy opportunity (unless it's a hack).
- **No block**: Headlines never block trades (unlike X alerts for hacks). They only adjust confidence.
- **Config**: All boosts/penalties configurable via `cryonix.toml [headlines]`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): add headline boost/penalty (Step 3h)

Breaking news adjustments after Polymarket (Step 3e). Bullish headlines
boost +10%, bearish penalize -12%. Freshness decay: full first 15min,
half at 15-30min. Contrarian: bearish + deep value = opportunity.
Reads from Redis headlines:active (set by headline-scanner)."
```

---

## Task 3: Cross-Market Lag Trader — Stocks → Crypto Bridge

**Problem:** Trump tweets → S&P rallies → crypto follows 1-4 hours later. Aktienix sees the stock rally. Cryonix doesn't know about it.

**Files:**
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts` (publish stock performance to Redis from main loop)
- Modify: `apps/web/src/app/api/auto-trade/route.ts` (Step 3i: cross-market boost)

- [ ] **Step 1: Publish stock performance summary to Redis from Aktienix**

In `packages/agents/src/aktienix/aktienix-agent.ts`, find the main trading loop (`while (this.isTrading)` around line 280). At the end of each loop iteration, add a call to publish cross-market data. The agent has Redis access via `statePublisher`. Add this method to the `AktienixAgent` class:

```typescript
// Publish cross-market summary for Cryonix consumption
async function publishCrossMarketSignal(redis: Redis): Promise<void> {
    try {
        // Get Aktienix state from Redis
        const stateRaw = await redis.get('aktienix:state');
        if (!stateRaw) return;
        const state = JSON.parse(stateRaw);

        const portfolio = state.portfolio || {};
        const positions = state.positions || [];
        const dailyPnlPct = portfolio.equity > 0
            ? ((portfolio.daily_pnl || 0) / portfolio.equity) * 100
            : 0;

        // Calculate aggregate position performance
        const avgPnlPct = positions.length > 0
            ? positions.reduce((sum: number, p: any) => sum + (p.unrealized_pnl_pct || 0), 0) / positions.length
            : 0;

        const signal = {
            dailyPnlPct: Math.round(dailyPnlPct * 100) / 100,
            avgPositionPnlPct: Math.round(avgPnlPct * 100) / 100,
            openPositions: positions.length,
            direction: dailyPnlPct >= 1.5 ? 'strong_rally' as const
                     : dailyPnlPct >= 0.5 ? 'rally' as const
                     : dailyPnlPct <= -1.5 ? 'strong_selloff' as const
                     : dailyPnlPct <= -0.5 ? 'selloff' as const
                     : 'flat' as const,
            timestamp: Date.now(),
        };

        await redis.set('crossmarket:stocks', JSON.stringify(signal), 'EX', 14400); // 4h TTL
        if (signal.direction === 'strong_rally' || signal.direction === 'strong_selloff') {
            console.log(`[CROSS-MARKET] Published: ${signal.direction} (daily PnL: ${signal.dailyPnlPct}%)`);
        }
    } catch { /* non-critical */ }
}
```

Call `await this.publishCrossMarketSignal()` at the end of each iteration in the `while (this.isTrading)` loop in `start()`.

- [ ] **Step 2: Add cross-market boost in auto-trade (Step 3i)**

After the headline boost (Step 3h), add Step 3i:

```typescript
    // STEP 3g: Cross-market lag trader (stocks rally → crypto boost)
    try {
      const stocksRaw = await redis.get('crossmarket:stocks');
      if (stocksRaw) {
        const stocks = JSON.parse(stocksRaw);
        const ageHours = (Date.now() - stocks.timestamp) / 3600000;

        // Only effective in the 1-4h window after stock move
        if (ageHours >= 0.5 && ageHours <= 4) {
          for (const p of parsed) {
            if (stocks.direction === 'strong_rally') {
              // Stocks strong rally → boost crypto (BTC/ETH/SOL most correlated)
              const baseAsset = p.signal.symbol.split('/')[0];
              const correlatedAssets = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'];
              const isCorrelated = correlatedAssets.includes(baseAsset);

              if (isCorrelated) {
                const boost = TOML?.crossmarket?.rally_boost ?? 0.08;
                const lagBonus = ageHours >= 1 && ageHours <= 2 ? 1.0 : 0.6; // Peak lag window 1-2h
                const effectiveBoost = boost * lagBonus;
                p.signal.confidence = Math.min(0.95, p.signal.confidence + effectiveBoost);
                p.signal.reason += ` | 📈 Stocks ${stocks.direction} (${stocks.dailyPnlPct}%, ${ageHours.toFixed(1)}h ago) +${(effectiveBoost * 100).toFixed(0)}%`;
                console.log(`[CROSS-MARKET] 📈 ${p.signal.symbol}: stocks rally boost +${(effectiveBoost * 100).toFixed(0)}% (stocks: ${stocks.dailyPnlPct}%, lag: ${ageHours.toFixed(1)}h)`);
              }
            } else if (stocks.direction === 'strong_selloff') {
              // Stocks strong selloff → penalize crypto (risk-off)
              const penalty = TOML?.crossmarket?.selloff_penalty ?? 0.10;
              p.signal.confidence = Math.max(0, p.signal.confidence - penalty);
              p.signal.reason += ` | 📉 Stocks ${stocks.direction} (${stocks.dailyPnlPct}%) -${(penalty * 100).toFixed(0)}%`;
            }
          }
        }
      }
    } catch { /* Cross-market data unavailable — skip */ }
```

**Key design decisions:**
- **Lag window 0.5-4h**: Don't react instantly (stocks and crypto don't move simultaneously). Peak correlation at 1-2h lag.
- **Correlated assets only**: BTC, ETH, SOL, AVAX, LINK — most stock-correlated cryptos. Alts less affected.
- **Strong moves only**: Only trigger on ≥1.5% daily stock move (strong_rally/strong_selloff).
- **4h TTL**: Signal expires after 4h — if crypto hasn't followed by then, the correlation broke.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/aktienix/aktienix-agent.ts apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(crossmarket): stock rally → crypto boost within 1-4h lag window

Aktienix publishes stock performance to Redis crossmarket:stocks (4h TTL).
Auto-trade Step 3i reads it: strong stock rally → boost correlated crypto
(BTC/ETH/SOL/AVAX/LINK) by 8%. Peak lag window 1-2h gets full boost.
Strong selloff → 10% penalty on all crypto."
```

---

## Task 4: Configuration

**Files:**
- Modify: `cryonix.toml`

- [ ] **Step 1: Add headline and cross-market config sections**

Add to `cryonix.toml`:

```toml
# ── Headline Scanner ──────────────────────────────────────────
[headlines]
# Confidence boost for bullish breaking news (|impact| >= 2)
bullish_boost = 0.10

# Confidence penalty for bearish breaking news
bearish_penalty = 0.12

# Contrarian: bearish headline + deep value signal = opportunity
contrarian_dv_boost = 0.08

# Scanner interval in seconds (also set in headline-scanner.ts)
scan_interval_seconds = 300

# ── Cross-Market Lag Trader ───────────────────────────────────
[crossmarket]
# Boost when stocks have a strong rally (>= 1.5% daily)
rally_boost = 0.08

# Penalty when stocks have a strong selloff (<= -1.5% daily)
selloff_penalty = 0.10

# Assets most correlated with stock market
correlated_assets = ["BTC", "ETH", "SOL", "AVAX", "LINK"]

# Lag window in hours (only boost during this window)
lag_window_start_hours = 0.5
lag_window_end_hours = 4.0
```

- [ ] **Step 2: Commit**

```bash
git add cryonix.toml
git commit -m "feat(config): add [headlines] and [crossmarket] config sections

Headline boost: +10% bullish, -12% bearish, +8% contrarian DV.
Cross-market lag: +8% on stock rally, -10% on selloff.
Correlated assets: BTC/ETH/SOL/AVAX/LINK. Lag window: 0.5-4h."
```

---

## Task 5: Docker Service for Headline Scanner

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add headline-scanner service**

First create `Dockerfile.headlines` (follows the Dockerfile.polymarket pattern — lightweight node:20-alpine with tsx):

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install --no-save ioredis@5 openai@4 tsx@4 typescript@5
COPY scripts/services/headline-scanner.ts ./scripts/services/
COPY packages/agents/src/shared/headline-types.ts ./packages/agents/src/shared/
USER node
CMD ["npx", "tsx", "scripts/services/headline-scanner.ts"]
```

Then add to `docker-compose.prod.yml`:

```yaml
  headline-scanner:
    build:
      context: .
      dockerfile: Dockerfile.headlines
    container_name: cryonix-headline-scanner
    restart: unless-stopped
    environment:
      - KV_URL=redis://redis:6379
      - XAI_API_KEY=${XAI_API_KEY}
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - cryonix-net
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(infra): add headline-scanner Docker service

Grok X/Twitter scanner runs every 5min alongside other services.
Uses same image as web. Writes to Redis headlines:active."
```

---

## Execution Order

Tasks 1-4 are independent. Task 5 depends on Task 1 (needs the scanner script).

```
Phase A (parallel): Task 1 (scanner) + Task 2 (headline boost) + Task 3 (cross-market) + Task 4 (config)
Phase B (sequential): Task 5 (Docker service, after Task 1)
```

| Task | What | Effort |
|------|------|--------|
| 1 | Headline scanner (Grok 5min loop) | 5 min |
| 2 | Headline boost in auto-trade (Step 3h) | 5 min |
| 3 | Cross-market lag trader (Step 3i) | 10 min |
| 4 | Config sections | 3 min |
| 5 | Docker service | 5 min |
