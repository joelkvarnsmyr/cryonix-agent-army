#!/usr/bin/env npx tsx
/**
 * Polynix Backtester
 *
 * Fetches resolved crypto markets from Polymarket Gamma API and tests
 * what our directional engine would have predicted vs actual outcomes.
 *
 * Usage:
 *   npx tsx scripts/strategy-lab/polynix-backtest.ts [--days 30] [--min-volume 1000] [--verbose]
 *
 * What it does:
 *   1. Fetch resolved crypto-tagged markets from Gamma API
 *   2. For each market with a clear YES/NO resolution:
 *      - Extract the price target (e.g. "BTC above $80K")
 *      - Fetch historical BTC price at market creation time (Binance klines)
 *      - Run our directional model to predict outcome
 *      - Compare prediction vs actual resolution
 *   3. Report accuracy, edge distribution, P&L simulation
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const BINANCE_API = 'https://api.binance.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolvedMarket {
    id: string;
    conditionId: string;
    question: string;
    outcomes: string[];
    outcomePrices: string;  // Final resolution prices
    volume: number;
    liquidity: number;
    endDate: string;
    createdAt?: string;
    closed: boolean;
    resolution: 'YES' | 'NO' | null;
}

interface BacktestResult {
    market: string;
    asset: string;
    target: number | null;
    direction: 'above' | 'below' | null;
    priceAtEntry: number | null;
    resolution: 'YES' | 'NO';
    prediction: 'YES' | 'NO' | 'SKIP';
    impliedProb: number;
    marketProb: number;
    edge: number;
    correct: boolean;
    hypotheticalPnl: number;
    reason: string;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const days = parseInt(args.find(a => a.startsWith('--days'))?.split('=')[1] ?? args[args.indexOf('--days') + 1] ?? '30');
const minVolume = parseInt(args.find(a => a.startsWith('--min-volume'))?.split('=')[1] ?? args[args.indexOf('--min-volume') + 1] ?? '1000');
const verbose = args.includes('--verbose');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchResolvedCryptoMarkets(maxDaysAgo: number): Promise<ResolvedMarket[]> {
    const markets: ResolvedMarket[] = [];
    let offset = 0;
    const limit = 100;

    console.log(`Fetching resolved crypto markets (last ${maxDaysAgo} days, min volume $${minVolume})...\n`);

    // Gamma API 'tag=crypto' is unreliable — fetch all resolved markets and filter locally
    while (true) {
        const url = `${GAMMA_API}/markets?closed=true&limit=${limit}&offset=${offset}&order=volume&ascending=false`;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) break;
            const data = await res.json() as any[];
            if (!Array.isArray(data) || data.length === 0) break;

            for (const m of data) {
                if (!m.closed) continue;

                // Parse resolution
                let resolution: 'YES' | 'NO' | null = null;
                try {
                    const prices = typeof m.outcomePrices === 'string'
                        ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    if (prices[0] === '1' || parseFloat(prices[0]) > 0.99) resolution = 'YES';
                    else if (prices[1] === '1' || parseFloat(prices[1]) > 0.99) resolution = 'NO';
                } catch { continue; }
                if (!resolution) continue;

                // Check age
                const endDate = new Date(m.endDate);
                const daysAgo = (Date.now() - endDate.getTime()) / 86400000;
                if (daysAgo > maxDaysAgo || daysAgo < 0) continue;

                // Check volume
                const volume = parseFloat(m.volume) || 0;
                if (volume < minVolume) continue;

                // Filter: only crypto price markets (bitcoin, btc, eth, solana)
                const q = (m.question || '').toLowerCase();
                const isCrypto = /\b(bitcoin|btc|ethereum|eth|solana|sol)\b/.test(q) &&
                                 /\b(above|below|reach|hit|dip|price)\b/.test(q);
                if (!isCrypto) continue;

                // Parse outcomes
                let outcomes: string[];
                try {
                    outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
                } catch { continue; }
                if (!outcomes || outcomes.length !== 2) continue;

                markets.push({
                    id: m.id,
                    conditionId: m.conditionId,
                    question: m.question,
                    outcomes,
                    outcomePrices: m.outcomePrices,
                    volume,
                    liquidity: parseFloat(m.liquidity) || 0,
                    endDate: m.endDate,
                    createdAt: m.createdAt,
                    closed: true,
                    resolution,
                });
            }

            offset += limit;
            if (data.length < limit) break;
            if (offset >= 2000) { console.log('  (capped at 2000 markets)'); break; }
            // Rate limit + progress
            await new Promise(r => setTimeout(r, 300));
            if (offset % 500 === 0) console.log(`  ...scanned ${offset} markets, found ${markets.length} crypto so far`);
        } catch (err: any) {
            console.warn(`Fetch error at offset ${offset}: ${err.message}`);
            break;
        }
    }

    return markets;
}

function extractPriceTarget(question: string): { asset: string; target: number; direction: 'above' | 'below' } | null {
    const q = question.toLowerCase();

    // Match patterns like "Bitcoin above $80,000", "BTC reach $100K", "ETH below $2000"
    let asset = 'BTC';
    if (q.includes('bitcoin') || q.includes('btc')) asset = 'BTC';
    else if (q.includes('ethereum') || q.includes('eth')) asset = 'ETH';
    else if (q.includes('solana') || q.includes('sol')) asset = 'SOL';
    else return null;

    // Extract price
    const priceMatch = question.match(/\$?([\d,]+(?:\.\d+)?)\s*(?:k|K)?/);
    if (!priceMatch) return null;

    let price = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (/k$/i.test(priceMatch[0])) price *= 1000;
    if (price < 100 || price > 500000) return null;

    const direction = q.includes('below') || q.includes('under') || q.includes('drop') || q.includes('fall') || q.includes('dip')
        ? 'below' : 'above';

    return { asset, target: price, direction };
}

const ASSET_TO_BINANCE: Record<string, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

async function getHistoricalPrice(asset: string, timestamp: number): Promise<number | null> {
    const symbol = ASSET_TO_BINANCE[asset];
    if (!symbol) return null;

    try {
        // Get 1h kline at the timestamp
        const url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${timestamp}&limit=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        return parseFloat(data[0][4]); // Close price
    } catch {
        return null;
    }
}

/**
 * Simple directional model: same z-score approach as our live engine.
 */
function predictOutcome(
    currentPrice: number,
    target: number,
    direction: 'above' | 'below',
    daysToExpiry: number,
): { prediction: 'YES' | 'NO'; impliedProb: number } {
    const dailyVol = 0.02;
    const totalVol = dailyVol * Math.sqrt(Math.max(daysToExpiry, 0.1));
    const distancePct = (currentPrice - target) / target;

    let zScore: number;
    if (direction === 'above') {
        zScore = distancePct / totalVol;
    } else {
        zScore = -distancePct / totalVol;
    }

    const impliedProb = 1 / (1 + Math.exp(-1.7 * zScore));
    const prediction = impliedProb > 0.5 ? 'YES' : 'NO';

    return { prediction, impliedProb };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('=========================================');
    console.log('  Polynix Backtester');
    console.log('=========================================\n');

    const markets = await fetchResolvedCryptoMarkets(days);
    console.log(`Found ${markets.length} resolved crypto markets.\n`);

    if (markets.length === 0) {
        console.log('No markets found. Try --days 90 or --min-volume 100');
        return;
    }

    const results: BacktestResult[] = [];
    let processed = 0;

    for (const market of markets) {
        const parsed = extractPriceTarget(market.question);
        if (!parsed) {
            if (verbose) console.log(`  SKIP (no price target): ${market.question}`);
            continue;
        }

        // Get price at ~start of market (or 7 days before end if no creation date)
        const endTime = new Date(market.endDate).getTime();
        const entryTime = market.createdAt
            ? new Date(market.createdAt).getTime()
            : endTime - 7 * 86400000;

        const price = await getHistoricalPrice(parsed.asset, entryTime);
        if (!price) {
            if (verbose) console.log(`  SKIP (no price data): ${market.question}`);
            continue;
        }

        const daysToExpiry = (endTime - entryTime) / 86400000;
        const { prediction, impliedProb } = predictOutcome(price, parsed.target, parsed.direction, daysToExpiry);

        // Edge: how far off is our prediction from 50/50?
        const edge = Math.abs(impliedProb - 0.5);
        const minEdge = 0.02;

        const finalPrediction = edge >= minEdge ? prediction : 'SKIP';
        const correct = finalPrediction === market.resolution;

        // Hypothetical P&L (assume $10 bet at implied prob price)
        const betSize = 10;
        let hypotheticalPnl = 0;
        if (finalPrediction !== 'SKIP') {
            const entryPrice = finalPrediction === 'YES' ? impliedProb : (1 - impliedProb);
            if (correct) {
                hypotheticalPnl = betSize - (entryPrice * betSize); // payout $10 - cost
            } else {
                hypotheticalPnl = -(entryPrice * betSize); // lose cost basis
            }
            // Subtract fees
            hypotheticalPnl -= betSize * 0.0156;
        }

        const result: BacktestResult = {
            market: market.question,
            asset: parsed.asset,
            target: parsed.target,
            direction: parsed.direction,
            priceAtEntry: price,
            resolution: market.resolution!,
            prediction: finalPrediction,
            impliedProb,
            marketProb: 0.5, // We don't have historical market price
            edge,
            correct,
            hypotheticalPnl,
            reason: finalPrediction === 'SKIP' ? `edge ${(edge * 100).toFixed(1)}% < ${minEdge * 100}%` : '',
        };

        results.push(result);
        processed++;

        if (verbose) {
            const emoji = finalPrediction === 'SKIP' ? '⊘' : correct ? '✓' : '✗';
            console.log(`  ${emoji} ${parsed.asset} ${parsed.direction} $${parsed.target.toLocaleString()} | price=$${price.toFixed(0)} | model=${(impliedProb * 100).toFixed(0)}% ${prediction} | actual=${market.resolution} | pnl=$${hypotheticalPnl.toFixed(2)}`);
        }

        // Rate limit Binance
        if (processed % 5 === 0) await new Promise(r => setTimeout(r, 200));
    }

    // ---------------------------------------------------------------------------
    // Report
    // ---------------------------------------------------------------------------

    const traded = results.filter(r => r.prediction !== 'SKIP');
    const skipped = results.filter(r => r.prediction === 'SKIP');
    const wins = traded.filter(r => r.correct);
    const losses = traded.filter(r => !r.correct);
    const totalPnl = traded.reduce((s, r) => s + r.hypotheticalPnl, 0);

    console.log('\n=========================================');
    console.log('  BACKTEST RESULTS');
    console.log('=========================================\n');

    console.log(`Markets analyzed:    ${results.length}`);
    console.log(`Traded (edge > 2%): ${traded.length}`);
    console.log(`Skipped:            ${skipped.length}`);
    console.log(`Wins:               ${wins.length}`);
    console.log(`Losses:             ${losses.length}`);
    console.log(`Win rate:           ${traded.length > 0 ? ((wins.length / traded.length) * 100).toFixed(1) : 0}%`);
    console.log(`Total P&L:          $${totalPnl.toFixed(2)} (@ $10/bet)`);
    console.log(`Avg P&L per trade:  $${traded.length > 0 ? (totalPnl / traded.length).toFixed(2) : '0.00'}`);

    // Breakdown by asset
    console.log('\n--- By Asset ---');
    for (const asset of ['BTC', 'ETH', 'SOL']) {
        const assetTrades = traded.filter(r => r.asset === asset);
        if (assetTrades.length === 0) continue;
        const assetWins = assetTrades.filter(r => r.correct).length;
        const assetPnl = assetTrades.reduce((s, r) => s + r.hypotheticalPnl, 0);
        console.log(`  ${asset}: ${assetTrades.length} trades, WR ${((assetWins / assetTrades.length) * 100).toFixed(0)}%, P&L $${assetPnl.toFixed(2)}`);
    }

    // Breakdown by edge bucket
    console.log('\n--- By Edge Bucket ---');
    const buckets = [
        { label: 'Low (2-10%)', min: 0.02, max: 0.10 },
        { label: 'Medium (10-25%)', min: 0.10, max: 0.25 },
        { label: 'High (25%+)', min: 0.25, max: 1.0 },
    ];
    for (const bucket of buckets) {
        const bTrades = traded.filter(r => r.edge >= bucket.min && r.edge < bucket.max);
        if (bTrades.length === 0) continue;
        const bWins = bTrades.filter(r => r.correct).length;
        const bPnl = bTrades.reduce((s, r) => s + r.hypotheticalPnl, 0);
        console.log(`  ${bucket.label}: ${bTrades.length} trades, WR ${((bWins / bTrades.length) * 100).toFixed(0)}%, P&L $${bPnl.toFixed(2)}`);
    }

    // Breakdown by direction
    console.log('\n--- By Direction ---');
    for (const dir of ['above', 'below'] as const) {
        const dTrades = traded.filter(r => r.direction === dir);
        if (dTrades.length === 0) continue;
        const dWins = dTrades.filter(r => r.correct).length;
        const dPnl = dTrades.reduce((s, r) => s + r.hypotheticalPnl, 0);
        console.log(`  ${dir}: ${dTrades.length} trades, WR ${((dWins / dTrades.length) * 100).toFixed(0)}%, P&L $${dPnl.toFixed(2)}`);
    }

    // Top 5 best and worst trades
    if (traded.length > 0) {
        console.log('\n--- Top 5 Best Trades ---');
        const sorted = [...traded].sort((a, b) => b.hypotheticalPnl - a.hypotheticalPnl);
        for (const t of sorted.slice(0, 5)) {
            console.log(`  +$${t.hypotheticalPnl.toFixed(2)} | ${t.asset} ${t.direction} $${t.target?.toLocaleString()} | model=${(t.impliedProb * 100).toFixed(0)}% | actual=${t.resolution}`);
        }

        console.log('\n--- Top 5 Worst Trades ---');
        for (const t of sorted.slice(-5).reverse()) {
            console.log(`  $${t.hypotheticalPnl.toFixed(2)} | ${t.asset} ${t.direction} $${t.target?.toLocaleString()} | model=${(t.impliedProb * 100).toFixed(0)}% | actual=${t.resolution}`);
        }
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
