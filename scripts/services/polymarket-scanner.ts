// scripts/services/polymarket-scanner.ts
// PolymarketScanner — prediction market intelligence for Cryonix + Aktienix
// Polls Polymarket Gamma API, classifies events, computes sentiment scores,
// writes to Redis for consumption by auto-trade (crypto) and aktienix (stocks).

import Redis from 'ioredis';
import { PolymarketSpreadScanner } from '../../packages/agents/src/shared/polymarket-spread-scanner';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const REDIS_URL = process.env.KV_URL ?? 'redis://localhost:6379';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (was 15 — faster for geopolitical events)
const REDIS_TTL = 900; // 15 minutes (3x poll interval)
const DELTA_THRESHOLD = 15; // Score shift >= 15 = significant macro event (was 20)

// Telegram alert config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

// ── Category Classification ────────────────────────────────────────────────

type Category = 'crypto' | 'fed' | 'oil' | 'geopolitik';

interface CategoryRule {
    keywords: string[];
    // Does "Yes" on a matching market mean bullish or bearish for risk assets?
    // 'bullish_if_yes' = price target markets (BTC above $X → yes = bullish)
    // 'bearish_if_yes' = risk/conflict markets (Iran strikes → yes = bearish)
    // 'mixed' = needs per-market keyword analysis
    defaultSentiment: 'bullish_if_yes' | 'bearish_if_yes' | 'mixed';
}

const CATEGORY_RULES: Record<Category, CategoryRule> = {
    crypto: {
        keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'sol'],
        defaultSentiment: 'mixed', // "above $X" = bullish, "below $X" = bearish
    },
    fed: {
        keywords: ['fed ', 'fomc', 'interest rate', 'federal reserve', 'rate cut', 'rate hike', 'monetary policy'],
        defaultSentiment: 'mixed', // "decrease" = dovish/bullish, "increase" = hawkish/bearish
    },
    oil: {
        keywords: ['crude oil', 'oil price', 'brent', 'wti', 'opec', 'petroleum', 'oil (cl)'],
        defaultSentiment: 'bullish_if_yes', // higher oil = bullish for energy
    },
    geopolitik: {
        keywords: ['iran', 'hormuz', 'china', 'taiwan', 'russia', 'ukraine', 'war ',
                    'strike', 'ceasefire', 'sanction', 'tariff', 'trade war', 'invasion', 'nuclear'],
        defaultSentiment: 'bearish_if_yes', // escalation = bearish for risk
    },
};

// Keywords that flip sentiment direction within a market question
const BEARISH_QUESTION_KEYWORDS = ['below', 'crash', 'fall', 'decline', 'drop', 'recession', 'strike', 'close the strait', 'escalat'];
const BULLISH_QUESTION_KEYWORDS = ['above', 'reach', 'hit', 'rise', 'ceasefire', 'peace', 'deal', 'resolution', 'decrease rate', 'rate cut'];

// ── Types ──────────────────────────────────────────────────────────────────

interface GammaEvent {
    id: string;
    title: string;
    slug: string;
    volume24hr: number;
    markets: GammaMarket[];
    tags?: Array<{ label: string }>;
}

interface GammaMarket {
    question: string;
    outcomePrices: string; // JSON string: '["0.55", "0.45"]'
    volume24hr: number;
    active: boolean;
    closed: boolean;
}

interface CategoryScore {
    score: number;           // 0-100
    label: string;           // very_bearish | bearish | neutral | bullish | very_bullish
    marketCount: number;
    topEvents: Array<{
        title: string;
        question: string;
        probability: number;
        sentiment: 'bullish' | 'bearish';
        volume24hr: number;
    }>;
    timestamp: string;
}

interface PolymarketSummary {
    overallSentiment: number; // 0-100
    categories: Record<Category, { score: number; label: string }>;
    eventCount: number;
    timestamp: string;
}

// ── Classification & Scoring ───────────────────────────────────────────────

function classifyEvent(event: GammaEvent): Category | null {
    const text = `${event.title} ${event.slug} ${(event.tags || []).map(t => t.label).join(' ')}`.toLowerCase();
    for (const [cat, rule] of Object.entries(CATEGORY_RULES) as [Category, CategoryRule][]) {
        if (rule.keywords.some(kw => text.includes(kw))) return cat;
    }
    return null;
}

function getMarketSentiment(question: string, category: Category): 'bullish' | 'bearish' {
    const q = question.toLowerCase();
    const rule = CATEGORY_RULES[category];

    if (rule.defaultSentiment === 'bullish_if_yes') return 'bullish';
    if (rule.defaultSentiment === 'bearish_if_yes') return 'bearish';

    // Mixed — analyze the question text
    if (BEARISH_QUESTION_KEYWORDS.some(kw => q.includes(kw))) return 'bearish';
    if (BULLISH_QUESTION_KEYWORDS.some(kw => q.includes(kw))) return 'bullish';

    // For Fed: "decrease" in rates = dovish = bullish for risk assets
    if (category === 'fed') {
        if (q.includes('decrease') || q.includes('cut')) return 'bullish';
        if (q.includes('increase') || q.includes('hike')) return 'bearish';
    }

    return 'bullish'; // default
}

function parseYesProbability(outcomePrices: string): number {
    try {
        const prices = JSON.parse(outcomePrices);
        return parseFloat(prices[0]) || 0;
    } catch {
        return 0;
    }
}

function computeCategoryScore(
    events: GammaEvent[],
    category: Category
): CategoryScore {
    const scoredMarkets: Array<{
        eventTitle: string;
        question: string;
        yesProbability: number;
        sentiment: 'bullish' | 'bearish';
        volume: number;
        bullishScore: number; // 0-100 contribution
    }> = [];

    for (const event of events) {
        for (const market of event.markets) {
            if (!market.active || market.closed) continue;
            const prob = parseYesProbability(market.outcomePrices);
            if (prob === 0) continue;

            const sentiment = getMarketSentiment(market.question, category);
            // Convert to a 0-100 bullish score:
            // If bullish_if_yes: high probability = high score
            // If bearish_if_yes: high probability = low score (invert)
            const bullishScore = sentiment === 'bullish'
                ? prob * 100
                : (1 - prob) * 100;

            scoredMarkets.push({
                eventTitle: event.title,
                question: market.question,
                yesProbability: prob,
                sentiment,
                volume: market.volume24hr || 0,
                bullishScore,
            });
        }
    }

    if (scoredMarkets.length === 0) {
        return {
            score: 50, label: 'neutral', marketCount: 0,
            topEvents: [], timestamp: new Date().toISOString(),
        };
    }

    // Volume-weighted average score
    const totalVolume = scoredMarkets.reduce((sum, m) => sum + Math.max(m.volume, 1), 0);
    const weightedScore = scoredMarkets.reduce(
        (sum, m) => sum + m.bullishScore * (Math.max(m.volume, 1) / totalVolume), 0
    );
    const score = Math.round(Math.min(100, Math.max(0, weightedScore)));

    const label = score <= 20 ? 'very_bearish'
        : score <= 40 ? 'bearish'
        : score <= 60 ? 'neutral'
        : score <= 80 ? 'bullish'
        : 'very_bullish';

    // Top events by volume
    const topEvents = scoredMarkets
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 5)
        .map(m => ({
            title: m.eventTitle,
            question: m.question,
            probability: m.yesProbability,
            sentiment: m.sentiment,
            volume24hr: m.volume,
        }));

    return {
        score, label, marketCount: scoredMarkets.length,
        topEvents, timestamp: new Date().toISOString(),
    };
}

// ── Telegram Alert ────────────────────────────────────────────────────────

async function sendTelegramAlert(text: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
        });
    } catch (err: any) {
        console.warn('[polymarket] Telegram alert failed:', err.message);
    }
}

// ── Scanner ────────────────────────────────────────────────────────────────

async function fetchEvents(): Promise<GammaEvent[]> {
    // Fetch top 50 events by 24h volume
    const url = `${GAMMA_API}/events?limit=50&active=true&order=volume24hr&ascending=false`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText}`);
    return await res.json() as GammaEvent[];
}

async function scan(redis: Redis, spreadScanner: PolymarketSpreadScanner): Promise<void> {
    const events = await fetchEvents();
    console.log(`[polymarket] Fetched ${events.length} events from Gamma API`);

    // Classify events into categories
    const categorized: Record<Category, GammaEvent[]> = {
        crypto: [], fed: [], oil: [], geopolitik: [],
    };

    for (const event of events) {
        const cat = classifyEvent(event);
        if (cat) categorized[cat].push(event);
    }

    // Compute scores and write to Redis
    const categories: Record<string, { score: number; label: string }> = {};
    const pipeline = redis.pipeline();

    for (const [cat, catEvents] of Object.entries(categorized) as [Category, GammaEvent[]][]) {
        const score = computeCategoryScore(catEvents, cat);
        pipeline.set(`polymarket:${cat}`, JSON.stringify(score), 'EX', REDIS_TTL);
        categories[cat] = { score: score.score, label: score.label };

        const evtCount = catEvents.length;
        const mktCount = score.marketCount;
        console.log(`[polymarket]   ${cat}: score=${score.score} (${score.label}), ${evtCount} events, ${mktCount} markets`);

        // Delta detection: compare with previous score
        const prevRaw = await redis.get(`polymarket:${cat}:prev`);
        const prevScore = prevRaw ? JSON.parse(prevRaw).score : 50;
        const delta = score.score - prevScore;

        if (Math.abs(delta) >= DELTA_THRESHOLD) {
            const direction = delta > 0 ? 'BULLISH SHIFT' : 'BEARISH SHIFT';
            const topEvent = score.topEvents[0]?.title ?? 'N/A';
            console.log(`[polymarket] DELTA ALERT: ${cat} ${direction} (${prevScore}→${score.score}, Δ${delta > 0 ? '+' : ''}${delta})`);

            await sendTelegramAlert(
                `📊 POLYMARKET ${cat.toUpperCase()} ${direction}\n\n` +
                `Score: ${prevScore} → ${score.score} (Δ${delta > 0 ? '+' : ''}${delta})\n` +
                `Top event: ${topEvent}`
            );

            // Write delta key for Aktienix to consume (1h TTL)
            pipeline.set(`polymarket:${cat}:delta`, JSON.stringify({
                delta, from: prevScore, to: score.score,
                direction: delta > 0 ? 'bullish' : 'bearish',
                timestamp: new Date().toISOString(),
            }), 'EX', 3600);
        }

        // Save current as prev for next cycle (2h TTL, survives 1 missed scan)
        pipeline.set(`polymarket:${cat}:prev`, JSON.stringify({ score: score.score }), 'EX', 7200);
    }

    // Summary key
    const overallSentiment = Math.round(
        Object.values(categories).reduce((s, c) => s + c.score, 0) / Object.keys(categories).length
    );
    const summary: PolymarketSummary = {
        overallSentiment,
        categories: categories as Record<Category, { score: number; label: string }>,
        eventCount: events.length,
        timestamp: new Date().toISOString(),
    };
    pipeline.set('polymarket:summary', JSON.stringify(summary), 'EX', REDIS_TTL);

    await pipeline.exec();
    console.log(`[polymarket] Written to Redis (TTL ${REDIS_TTL}s). Overall sentiment: ${overallSentiment}/100`);

    // ── Spread Arbitrage Scan ──────────────────────────────────────────────
    try {
        const spreadResult = await spreadScanner.scan();
        const { opportunities, nearMisses, marketsScanned, scanDurationMs, avgCombinedCost, tightestCombinedCost } = spreadResult;

        console.log(`[spread-scanner] Scanned ${marketsScanned} markets in ${scanDurationMs}ms`);
        console.log(`[spread-scanner] Avg combined cost: ${avgCombinedCost.toFixed(4)}, tightest: ${tightestCombinedCost.toFixed(4)}`);

        if (opportunities.length > 0) {
            console.log(`[spread-scanner] Found ${opportunities.length} arbitrage opportunities:`);
            for (const opp of opportunities) {
                console.log(`[spread-scanner]   "${opp.question.slice(0, 60)}" YES=${opp.yesBuyPrice.toFixed(3)} + NO=${opp.noBuyPrice.toFixed(3)} = ${opp.combinedCost.toFixed(4)} (net profit: ${(opp.profitAfterFees * 100).toFixed(2)}%, liq: $${opp.liquidity.toFixed(0)})`);
            }
        } else {
            console.log(`[spread-scanner] No arb found (tightest: ${tightestCombinedCost.toFixed(4)}, gap: ${((1 - tightestCombinedCost) * 100).toFixed(2)}%)`);
        }

        if (nearMisses.length > 0) {
            console.log(`[spread-scanner] Near-misses (${nearMisses.length}):`);
            for (const nm of nearMisses.slice(0, 3)) {
                console.log(`[spread-scanner]   ${nm.combinedCost.toFixed(4)} (${nm.gapPct.toFixed(2)}%) "${nm.question.slice(0, 50)}"`);
            }
        }

        // Write spread scan results to Redis
        const spreadPipeline = redis.pipeline();
        spreadPipeline.set('polymarket:spreads', JSON.stringify(spreadResult), 'EX', REDIS_TTL);

        // If opportunities exist, write them separately for easy consumption
        if (opportunities.length > 0) {
            spreadPipeline.set('polymarket:spreads:opportunities', JSON.stringify(opportunities), 'EX', REDIS_TTL);
        } else {
            spreadPipeline.del('polymarket:spreads:opportunities');
        }

        await spreadPipeline.exec();
    } catch (err: any) {
        console.warn(`[spread-scanner] Scan failed: ${err.message}`);
    }
}

// ── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
    console.log('[polymarket] Starting PolymarketScanner + SpreadScanner...');
    console.log(`[polymarket] Poll interval: ${POLL_INTERVAL_MS / 1000}s, Redis TTL: ${REDIS_TTL}s`);

    const redis = new Redis(REDIS_URL);
    redis.on('error', err => console.error('[polymarket] Redis error:', err.message));

    const spreadScanner = new PolymarketSpreadScanner();

    // Run immediately on startup
    try {
        await scan(redis, spreadScanner);
    } catch (err: any) {
        console.error('[polymarket] Initial scan failed:', err.message);
    }

    // Then poll on interval
    setInterval(async () => {
        try {
            await scan(redis, spreadScanner);
        } catch (err: any) {
            console.error('[polymarket] Scan failed:', err.message);
        }
    }, POLL_INTERVAL_MS);
}

main().catch(err => {
    console.error('[polymarket] Fatal:', err.message);
    process.exit(1);
});
