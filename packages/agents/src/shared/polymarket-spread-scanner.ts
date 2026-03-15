/**
 * Polymarket Spread Scanner — detects YES+NO arbitrage opportunities.
 *
 * Scans binary markets on Polymarket for pricing inefficiencies where
 * the combined cost of YES + NO tokens is less than $1.00.
 *
 * APIs:
 *   - Gamma API: market discovery + token IDs (no auth)
 *   - CLOB API /price: AMM buy price including liquidity (no auth)
 *   - CLOB API /book: limit orderbook for depth estimation (no auth)
 *
 * When YES_buy_price + NO_buy_price < $1.00, buying both guarantees
 * profit at resolution. After Polymarket's ~2% fee, we need >2.5% spread.
 *
 * Key insight: /book shows thin limit orders (often 0.01/0.99).
 * /price shows the real AMM-inclusive price you'd actually pay.
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

// Minimum spread width to consider as opportunity (before fees)
const MIN_SPREAD_RAW = 0.025;     // 2.5%
// Polymarket fee rate
const FEE_RATE = 0.02;            // 2%
// Minimum spread after fees
const MIN_PROFIT_AFTER_FEES = 0.005; // 0.5% net profit minimum
// Minimum liquidity to consider actionable (filters out thin markets)
const MIN_LIQUIDITY_USD = 500;
// Maximum markets to scan per cycle
const MAX_MARKETS_PER_SCAN = 80;

// ── Types ──────────────────────────────────────────────────────────────────

interface GammaMarketWithTokens {
    id: string;
    question: string;
    outcomePrices: string;
    volume: string;
    volume24hr: number;
    liquidity: string;
    active: boolean;
    closed: boolean;
    clobTokenIds?: string;
    tokens?: Array<{ token_id: string; outcome: string }>;
    endDate?: string;
}

export interface SpreadOpportunity {
    marketId: string;
    question: string;
    yesTokenId: string;
    noTokenId: string;
    yesBuyPrice: number;     // AMM price to buy YES
    noBuyPrice: number;      // AMM price to buy NO
    yesMidpoint: number;     // Midpoint price
    noMidpoint: number;
    combinedCost: number;    // yesBuyPrice + noBuyPrice
    spreadWidth: number;     // 1.0 - combinedCost
    profitAfterFees: number; // spreadWidth - FEE_RATE
    liquidity: number;       // Market liquidity from Gamma
    volume24hr: number;
    detectedAt: number;
    expiresAt?: string;
}

export interface SpreadScanResult {
    opportunities: SpreadOpportunity[];
    nearMisses: Array<{      // Markets close to arb (combined < 1.02)
        question: string;
        combinedCost: number;
        gapPct: number;
    }>;
    marketsScanned: number;
    scanDurationMs: number;
    timestamp: string;
    avgCombinedCost: number;
    tightestCombinedCost: number;
}

// ── Core Scanner ───────────────────────────────────────────────────────────

export class PolymarketSpreadScanner {
    private lastScan: SpreadScanResult | null = null;

    /**
     * Scan Polymarket for spread arbitrage opportunities.
     */
    async scan(): Promise<SpreadScanResult> {
        const start = Date.now();

        const markets = await this.fetchBinaryMarkets();
        console.log(`[spread-scanner] Fetched ${markets.length} binary markets with token IDs`);

        const opportunities: SpreadOpportunity[] = [];
        const nearMisses: SpreadScanResult['nearMisses'] = [];
        const allCosts: number[] = [];

        // Process in batches (4 requests per market: 2x /price + 2x /midpoint)
        const batchSize = 15;
        for (let i = 0; i < markets.length; i += batchSize) {
            const batch = markets.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(m => this.checkMarketSpread(m))
            );

            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value) continue;
                const { combinedCost, opportunity, question } = result.value;

                allCosts.push(combinedCost);

                if (opportunity) {
                    opportunities.push(opportunity);
                } else if (combinedCost < 1.02 && combinedCost >= 0.50) {
                    // Near-miss: within 2% of arb (and not illiquid garbage)
                    nearMisses.push({
                        question,
                        combinedCost,
                        gapPct: (1 - combinedCost) * 100,
                    });
                }
            }

            // Rate limit between batches
            if (i + batchSize < markets.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        opportunities.sort((a, b) => b.profitAfterFees - a.profitAfterFees);
        nearMisses.sort((a, b) => a.combinedCost - b.combinedCost);

        const scanResult: SpreadScanResult = {
            opportunities,
            nearMisses: nearMisses.slice(0, 10),
            marketsScanned: markets.length,
            scanDurationMs: Date.now() - start,
            timestamp: new Date().toISOString(),
            avgCombinedCost: allCosts.length > 0
                ? allCosts.reduce((s, v) => s + v, 0) / allCosts.length
                : 1.0,
            tightestCombinedCost: allCosts.length > 0
                ? Math.min(...allCosts)
                : 1.0,
        };

        this.lastScan = scanResult;
        return scanResult;
    }

    getLastScan(): SpreadScanResult | null {
        return this.lastScan;
    }

    // ── Internal ───────────────────────────────────────────────────────────

    private async fetchBinaryMarkets(): Promise<GammaMarketWithTokens[]> {
        // Fetch by liquidity (most tradeable markets first)
        const url = `${GAMMA_API}/markets?closed=false&active=true&limit=${MAX_MARKETS_PER_SCAN}&order=liquidity&ascending=false`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Gamma API ${res.status}`);

        const markets = await res.json() as GammaMarketWithTokens[];

        return markets.filter(m => {
            if (m.closed || !m.active) return false;
            // Must have exactly 2 token IDs (binary market)
            const ids = this.getTokenIds(m);
            return ids !== null;
        });
    }

    /**
     * Check a single market's spread using CLOB /price endpoint.
     * /price returns the actual price you'd pay to buy including AMM liquidity.
     */
    private async checkMarketSpread(market: GammaMarketWithTokens): Promise<{
        combinedCost: number;
        question: string;
        opportunity: SpreadOpportunity | null;
    } | null> {
        const tokenIds = this.getTokenIds(market);
        if (!tokenIds) return null;

        const { yesTokenId, noTokenId } = tokenIds;

        try {
            // Fetch buy prices and midpoints in parallel
            const [yesPriceRes, noPriceRes, yesMidRes, noMidRes] = await Promise.all([
                this.fetchPrice(yesTokenId, 'buy'),
                this.fetchPrice(noTokenId, 'buy'),
                this.fetchMidpoint(yesTokenId),
                this.fetchMidpoint(noTokenId),
            ]);

            if (yesPriceRes === null || noPriceRes === null) return null;

            const combinedCost = yesPriceRes + noPriceRes;
            const spreadWidth = 1.0 - combinedCost;

            const result: {
                combinedCost: number;
                question: string;
                opportunity: SpreadOpportunity | null;
            } = {
                combinedCost,
                question: market.question,
                opportunity: null,
            };

            // Check if there's an arb opportunity
            // Sanity: combined cost < 0.50 usually means illiquid market with bad price data
            if (spreadWidth >= MIN_SPREAD_RAW && combinedCost >= 0.50) {
                const profitAfterFees = spreadWidth - FEE_RATE;
                const liquidity = parseFloat(market.liquidity) || 0;

                if (profitAfterFees >= MIN_PROFIT_AFTER_FEES && liquidity >= MIN_LIQUIDITY_USD) {
                    result.opportunity = {
                        marketId: market.id,
                        question: market.question,
                        yesTokenId,
                        noTokenId,
                        yesBuyPrice: yesPriceRes,
                        noBuyPrice: noPriceRes,
                        yesMidpoint: yesMidRes ?? yesPriceRes,
                        noMidpoint: noMidRes ?? noPriceRes,
                        combinedCost,
                        spreadWidth,
                        profitAfterFees,
                        liquidity,
                        volume24hr: market.volume24hr || 0,
                        detectedAt: Date.now(),
                        expiresAt: market.endDate,
                    };
                }
            }

            return result;
        } catch {
            return null;
        }
    }

    /**
     * Fetch the actual price to buy/sell a token via CLOB /price endpoint.
     * This includes AMM pricing, not just limit orders.
     */
    private async fetchPrice(tokenId: string, side: 'buy' | 'sell'): Promise<number | null> {
        try {
            const url = `${CLOB_API}/price?token_id=${tokenId}&side=${side}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { price: string };
            const price = parseFloat(data.price);
            return isNaN(price) || price <= 0 ? null : price;
        } catch {
            return null;
        }
    }

    /**
     * Fetch midpoint price for a token.
     */
    private async fetchMidpoint(tokenId: string): Promise<number | null> {
        try {
            const url = `${CLOB_API}/midpoint?token_id=${tokenId}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { mid: string };
            const mid = parseFloat(data.mid);
            return isNaN(mid) ? null : mid;
        } catch {
            return null;
        }
    }

    /**
     * Extract YES and NO token IDs from a Gamma market object.
     */
    private getTokenIds(market: GammaMarketWithTokens): { yesTokenId: string; noTokenId: string } | null {
        // Try tokens array first
        if (market.tokens && market.tokens.length === 2) {
            const yes = market.tokens.find(t => t.outcome === 'Yes');
            const no = market.tokens.find(t => t.outcome === 'No');
            if (yes && no) return { yesTokenId: yes.token_id, noTokenId: no.token_id };
            return { yesTokenId: market.tokens[0].token_id, noTokenId: market.tokens[1].token_id };
        }

        // Fall back to clobTokenIds string
        if (market.clobTokenIds) {
            try {
                const ids = JSON.parse(market.clobTokenIds);
                if (Array.isArray(ids) && ids.length === 2) {
                    return { yesTokenId: ids[0], noTokenId: ids[1] };
                }
            } catch { /* ignore */ }
        }

        return null;
    }
}
