/**
 * Polymarket Intelligence — shared macro/sentiment module.
 *
 * Reads prediction market data from Polymarket's public APIs (no auth needed)
 * and distills it into actionable signals for all trading agents:
 *   - Cryonix: crypto sentiment → confidence adjustment
 *   - Solanix: macro risk → position sizing
 *   - Aktienix: geopolitics → risk-off signal
 *   - Copynix: top trader bets → consensus signal
 *
 * APIs used:
 *   - Gamma API: events, markets (https://gamma-api.polymarket.com)
 *   - Data API: leaderboard, prices (https://data-api.polymarket.com)
 *   - Polymarket.com: leaderboard page scraping fallback
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolymarketSentiment {
    /** Overall crypto sentiment: -1 (extreme fear) to +1 (extreme greed) */
    cryptoSentiment: number;
    /** BTC implied range — crowd-sourced price boundaries */
    btcImpliedFloor: number | null;
    btcImpliedCeiling: number | null;
    /** Macro risk level: 0 (calm) to 1 (extreme risk) */
    macroRisk: number;
    /** Key market signals driving the scores */
    signals: PolySignal[];
    /** Timestamp of this reading */
    timestamp: number;
    /** Cache TTL remaining (ms) */
    cacheAge: number;
}

export interface PolySignal {
    market: string;
    probability: number;
    direction: 'bullish' | 'bearish' | 'neutral';
    weight: number;
    detail: string;
}

interface GammaEvent {
    id: string;
    title: string;
    slug: string;
    volume: string;
    liquidity: string;
    closed: boolean;
    markets: GammaMarket[];
    tags?: { slug: string; label: string }[];
}

interface GammaMarket {
    id: string;
    question: string;
    outcomePrices: string; // JSON string: "[\"0.95\",\"0.05\"]"
    volume: string;
    liquidity: string;
    closed: boolean;
    groupItemTitle?: string;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class PolymarketIntelligence {
    private cache: PolymarketSentiment | null = null;
    private cacheTtlMs: number;
    private lastFetch = 0;

    constructor(cacheTtlMs = 300_000) { // 5 min default cache
        this.cacheTtlMs = cacheTtlMs;
    }

    /**
     * Get current sentiment analysis. Returns cached result if fresh.
     */
    async getSentiment(): Promise<PolymarketSentiment> {
        const now = Date.now();
        if (this.cache && now - this.lastFetch < this.cacheTtlMs) {
            return { ...this.cache, cacheAge: now - this.lastFetch };
        }

        const sentiment = await this.buildSentiment();
        this.cache = sentiment;
        this.lastFetch = now;
        return sentiment;
    }

    /**
     * Get a simple confidence adjustment for a trading agent.
     * Returns a delta to apply to signal confidence (-15 to +10).
     */
    async getConfidenceDelta(agent: 'cryonix' | 'solanix' | 'aktienix' | 'copynix'): Promise<{ delta: number; reason: string }> {
        const s = await this.getSentiment();

        switch (agent) {
            case 'cryonix':
            case 'solanix':
            case 'copynix': {
                // Crypto agents: boost on bullish sentiment, penalize on bearish
                if (s.cryptoSentiment >= 0.5) return { delta: 8, reason: `Polymarket bullish (${(s.cryptoSentiment * 100).toFixed(0)}%)` };
                if (s.cryptoSentiment >= 0.2) return { delta: 4, reason: `Polymarket mildly bullish` };
                if (s.cryptoSentiment <= -0.5) return { delta: -12, reason: `Polymarket bearish (${(s.cryptoSentiment * 100).toFixed(0)}%)` };
                if (s.cryptoSentiment <= -0.2) return { delta: -6, reason: `Polymarket mildly bearish` };
                return { delta: 0, reason: 'Polymarket neutral' };
            }
            case 'aktienix': {
                // Stock agent: penalize on high macro risk
                if (s.macroRisk >= 0.7) return { delta: -15, reason: `Polymarket high macro risk (${(s.macroRisk * 100).toFixed(0)}%)` };
                if (s.macroRisk >= 0.4) return { delta: -8, reason: `Polymarket elevated macro risk` };
                if (s.macroRisk <= 0.15) return { delta: 5, reason: `Polymarket low macro risk` };
                return { delta: 0, reason: 'Polymarket macro neutral' };
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    private async buildSentiment(): Promise<PolymarketSentiment> {
        const signals: PolySignal[] = [];
        let cryptoScore = 0;
        let macroRisk = 0;
        let btcFloor: number | null = null;
        let btcCeiling: number | null = null;

        // 1. Fetch BTC price level markets (slug-based, most reliable)
        try {
            const btcEvent = await this.fetchBtcPriceEvent();
            if (btcEvent) {
                const { f, c, s } = this.parseBtcPriceLevels(btcEvent.markets ?? []);
                btcFloor = f;
                btcCeiling = c;
                signals.push(...s);
                if (f && c) {
                    const rangeWidth = c - f;
                    if (rangeWidth > 0) {
                        const confidence = Math.min(1, 10_000 / rangeWidth);
                        cryptoScore += confidence * 0.1;
                    }
                }
            }
        } catch {
            // Continue
        }

        // 2. Fetch crypto-tagged events (hack, liquidation, regulation, etc.)
        try {
            const cryptoEvents = await this.fetchEvents('crypto', 30);
            const { score, sigs } = this.analyzeCryptoEvents(cryptoEvents);
            cryptoScore += score;
            signals.push(...sigs);
        } catch {
            // Continue
        }

        // 3. Fetch crypto markets via /markets endpoint (broader coverage)
        try {
            const cryptoMarkets = await this.fetchMarkets('crypto', 20);
            const { score, sigs } = this.analyzeCryptoMarkets(cryptoMarkets);
            cryptoScore += score;
            signals.push(...sigs);
        } catch {
            // Continue
        }

        // 4. Fetch geopolitical events for macro risk
        try {
            const geoEvents = await this.fetchEvents('geopolitics', 20);
            const { risk, sigs } = this.analyzeGeoEvents(geoEvents);
            macroRisk = risk;
            signals.push(...sigs);
        } catch {
            // Continue
        }

        // 5. Fetch economy events
        try {
            const econEvents = await this.fetchEvents('economy', 10);
            const { adjustment, sigs } = this.analyzeEconEvents(econEvents);
            cryptoScore += adjustment;
            signals.push(...sigs);
        } catch {
            // Continue
        }

        // Clamp crypto sentiment to [-1, 1]
        cryptoScore = Math.max(-1, Math.min(1, cryptoScore));

        return {
            cryptoSentiment: cryptoScore,
            btcImpliedFloor: btcFloor,
            btcImpliedCeiling: btcCeiling,
            macroRisk: Math.max(0, Math.min(1, macroRisk)),
            signals,
            timestamp: Date.now(),
            cacheAge: 0,
        };
    }

    private analyzeCryptoEvents(events: GammaEvent[]): { score: number; sigs: PolySignal[]; floor: number | null; ceiling: number | null } {
        let score = 0;
        const sigs: PolySignal[] = [];
        let floor: number | null = null;
        let ceiling: number | null = null;

        for (const event of events) {
            const title = event.title.toLowerCase();
            const markets = event.markets ?? [];

            // BTC price level markets ("Bitcoin above $X on date?")
            if (title.includes('bitcoin above') || title.includes('btc above')) {
                const { f, c, s } = this.parseBtcPriceLevels(markets);
                if (f) floor = f;
                if (c) ceiling = c;
                if (s.length > 0) sigs.push(...s);

                // Derive sentiment from implied range position
                if (floor && ceiling) {
                    const rangeWidth = ceiling - floor;
                    if (rangeWidth > 0) {
                        // Narrow range = market confident = slightly bullish
                        const confidence = Math.min(1, 10_000 / rangeWidth);
                        score += confidence * 0.1;
                    }
                }
                continue;
            }

            // ETH price markets
            if (title.includes('ethereum above') || title.includes('eth above')) {
                // Similar logic could be applied for ETH
                continue;
            }

            // Hack/exploit markets ("Another crypto hack over $100m")
            if (title.includes('hack') || title.includes('exploit')) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null) {
                    if (prob > 0.6) {
                        score -= 0.15;
                        sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.15, detail: `${(prob * 100).toFixed(0)}% chance of major hack — bearish` });
                    } else if (prob < 0.3) {
                        score += 0.05;
                        sigs.push({ market: event.title, probability: prob, direction: 'bullish', weight: 0.05, detail: `Low hack risk (${(prob * 100).toFixed(0)}%)` });
                    }
                }
                continue;
            }

            // Liquidation events
            if (title.includes('liquidation')) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null && prob > 0.5) {
                    score -= 0.1;
                    sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.1, detail: `${(prob * 100).toFixed(0)}% liquidation risk` });
                }
                continue;
            }

            // Capital gains tax elimination (bullish for crypto)
            if (title.includes('capital gains') && title.includes('crypto')) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null && prob > 0.3) {
                    score += 0.15 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bullish', weight: 0.15, detail: `${(prob * 100).toFixed(0)}% chance of crypto tax cut` });
                }
                continue;
            }

            // Binance listings (bullish for specific tokens)
            if (title.includes('listed on binance') || title.includes('binance listing')) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null && prob > 0.5) {
                    score += 0.05;
                    sigs.push({ market: event.title, probability: prob, direction: 'bullish', weight: 0.05, detail: `Binance listing likely (${(prob * 100).toFixed(0)}%)` });
                }
                continue;
            }

            // Stablecoin markets
            if (title.includes('stablecoin')) {
                continue; // Neutral signal
            }

            // Generic crypto bullish/bearish keyword matching
            if (this.isBullishCryptoEvent(title)) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null) {
                    score += 0.05 * prob;
                }
            } else if (this.isBearishCryptoEvent(title)) {
                const prob = this.getFirstMarketProb(markets);
                if (prob !== null) {
                    score -= 0.05 * prob;
                }
            }
        }

        return { score, sigs, floor, ceiling };
    }

    private parseBtcPriceLevels(markets: GammaMarket[]): { f: number | null; c: number | null; s: PolySignal[] } {
        const sigs: PolySignal[] = [];
        let floor: number | null = null;
        let ceiling: number | null = null;

        // Parse each sub-market like "$72,000" with probability
        const levels: { price: number; prob: number }[] = [];

        for (const m of markets) {
            if (m.closed) continue;
            const priceMatch = m.question?.match(/\$?([\d,]+)/);
            if (!priceMatch) continue;
            const price = parseInt(priceMatch[1].replace(/,/g, ''));
            if (!price || price < 10_000 || price > 500_000) continue;

            const prob = this.parseOutcomePrice(m.outcomePrices);
            if (prob === null) continue;

            levels.push({ price, prob });
        }

        if (levels.length === 0) return { f: null, c: null, s: [] };

        // Sort by price ascending
        levels.sort((a, b) => a.price - b.price);

        // Floor = highest price with >90% probability
        // Ceiling = lowest price with <10% probability
        for (const l of levels) {
            if (l.prob >= 0.90) floor = l.price;
        }
        for (let i = levels.length - 1; i >= 0; i--) {
            if (levels[i].prob <= 0.10) ceiling = levels[i].price;
        }

        if (floor && ceiling) {
            sigs.push({
                market: `BTC implied range`,
                probability: 0.8,
                direction: 'neutral',
                weight: 0.2,
                detail: `BTC floor $${floor.toLocaleString()}, ceiling $${ceiling.toLocaleString()}`,
            });
        }

        return { f: floor, c: ceiling, s: sigs };
    }

    private analyzeGeoEvents(events: GammaEvent[]): { risk: number; sigs: PolySignal[] } {
        let risk = 0.2; // Baseline
        const sigs: PolySignal[] = [];

        for (const event of events) {
            const title = event.title.toLowerCase();
            const prob = this.getFirstMarketProb(event.markets ?? []);
            if (prob === null) continue;

            // Military conflict markets
            if (title.includes('military') || title.includes('war') || title.includes('troops') || title.includes('clash') || title.includes('invasion')) {
                if (prob > 0.4) {
                    risk += 0.15 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.15, detail: `Conflict risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Nuclear/escalation
            if (title.includes('nuclear') || title.includes('escalat')) {
                if (prob > 0.2) {
                    risk += 0.25 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.25, detail: `Escalation risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Sanctions
            if (title.includes('sanction')) {
                if (prob > 0.5) {
                    risk += 0.05;
                }
                continue;
            }
        }

        return { risk: Math.min(1, risk), sigs };
    }

    private analyzeEconEvents(events: GammaEvent[]): { adjustment: number; sigs: PolySignal[] } {
        let adjustment = 0;
        const sigs: PolySignal[] = [];

        for (const event of events) {
            const title = event.title.toLowerCase();
            const prob = this.getFirstMarketProb(event.markets ?? []);
            if (prob === null) continue;

            // Recession markets
            if (title.includes('recession')) {
                if (prob > 0.5) {
                    adjustment -= 0.15 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.15, detail: `Recession risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Rate cut (bullish for risk assets)
            if (title.includes('rate cut') || title.includes('fed cut')) {
                if (prob > 0.5) {
                    adjustment += 0.1 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bullish', weight: 0.1, detail: `Rate cut likely (${(prob * 100).toFixed(0)}%)` });
                }
                continue;
            }

            // Tariff (bearish for markets)
            if (title.includes('tariff')) {
                if (prob > 0.5) {
                    adjustment -= 0.08 * prob;
                    sigs.push({ market: event.title, probability: prob, direction: 'bearish', weight: 0.08, detail: `Tariff risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }
        }

        return { adjustment, sigs };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Fetch today's BTC price level event via slug pattern.
     * Slug format: "bitcoin-above-on-march-13" (date changes daily).
     */
    private async fetchBtcPriceEvent(): Promise<GammaEvent | null> {
        const now = new Date();
        const months = ['january', 'february', 'march', 'april', 'may', 'june',
            'july', 'august', 'september', 'october', 'november', 'december'];
        const month = months[now.getUTCMonth()];
        const day = now.getUTCDate();

        // Try today and tomorrow (markets may be for next day)
        const slugs = [
            `bitcoin-above-on-${month}-${day}`,
            `bitcoin-above-on-${month}-${day + 1}`,
        ];

        for (const slug of slugs) {
            try {
                const url = `${GAMMA_API}/events?slug=${slug}&closed=false`;
                const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
                if (!res.ok) continue;
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) return data[0] as GammaEvent;
            } catch {
                continue;
            }
        }

        // Fallback: try monthly market
        try {
            const url = `${GAMMA_API}/events?slug=what-price-will-bitcoin-hit-in-${month}&closed=false`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) return data[0] as GammaEvent;
            }
        } catch {
            // Continue
        }

        return null;
    }

    private async fetchMarkets(tag: string, limit: number): Promise<GammaMarket[]> {
        const url = `${GAMMA_API}/markets?closed=false&limit=${limit}&tag=${encodeURIComponent(tag)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data as GammaMarket[] : [];
    }

    private analyzeCryptoMarkets(markets: GammaMarket[]): { score: number; sigs: PolySignal[] } {
        let score = 0;
        const sigs: PolySignal[] = [];

        for (const m of markets) {
            if (m.closed) continue;
            const q = (m.question ?? '').toLowerCase();
            const prob = this.parseOutcomePrice(m.outcomePrices);
            if (prob === null) continue;

            // Hack/exploit
            if (q.includes('hack') || q.includes('exploit')) {
                if (prob > 0.5) {
                    score -= 0.1 * prob;
                    sigs.push({ market: m.question, probability: prob, direction: 'bearish', weight: 0.1, detail: `Hack risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Liquidation
            if (q.includes('liquidation')) {
                if (prob > 0.5) {
                    score -= 0.08 * prob;
                    sigs.push({ market: m.question, probability: prob, direction: 'bearish', weight: 0.08, detail: `Liquidation risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Tax/regulation bullish
            if (q.includes('capital gains') || q.includes('tax') && q.includes('crypto')) {
                if (prob > 0.3) {
                    score += 0.1 * prob;
                    sigs.push({ market: m.question, probability: prob, direction: 'bullish', weight: 0.1, detail: `Crypto-friendly policy ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }

            // Hedge fund blow up
            if (q.includes('hedge fund') && (q.includes('blow') || q.includes('collapse'))) {
                if (prob > 0.3) {
                    score -= 0.12 * prob;
                    sigs.push({ market: m.question, probability: prob, direction: 'bearish', weight: 0.12, detail: `Hedge fund risk ${(prob * 100).toFixed(0)}%` });
                }
                continue;
            }
        }

        return { score, sigs };
    }

    private async fetchEvents(tag: string, limit: number): Promise<GammaEvent[]> {
        const url = `${GAMMA_API}/events?closed=false&limit=${limit}&tag=${encodeURIComponent(tag)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data as GammaEvent[] : [];
    }

    private getFirstMarketProb(markets: GammaMarket[]): number | null {
        for (const m of markets) {
            if (m.closed) continue;
            const prob = this.parseOutcomePrice(m.outcomePrices);
            if (prob !== null) return prob;
        }
        return null;
    }

    private parseOutcomePrice(outcomePrices: string | undefined): number | null {
        if (!outcomePrices) return null;
        try {
            const prices = JSON.parse(outcomePrices) as string[];
            if (prices.length >= 1) return parseFloat(prices[0]);
        } catch {
            // Try direct parse
            const num = parseFloat(outcomePrices);
            if (!isNaN(num)) return num;
        }
        return null;
    }

    private isBullishCryptoEvent(title: string): boolean {
        return /\b(etf|adoption|approval|bullish|ath|all.time.high|institutional|inflow)\b/.test(title);
    }

    private isBearishCryptoEvent(title: string): boolean {
        return /\b(ban|crash|collapse|bearish|regulation|sec.sue|fraud|ponzi)\b/.test(title);
    }
}
