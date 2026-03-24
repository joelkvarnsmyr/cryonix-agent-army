import type { CryptoMicroMarket, PolynixConfig } from './types';

interface GammaEvent {
    id: string;
    title: string;
    slug: string;
    closed: boolean;
    endDate?: string;
    volume24hr?: number;
    markets?: GammaMarketEntry[];
    tags?: Array<{ label: string }>;
}

interface GammaMarketEntry {
    id: string;
    conditionId: string;
    questionID: string;
    question: string;
    outcomes: string;           // JSON string: '["Yes", "No"]'
    outcomePrices: string;
    clobTokenIds: string;
    closed: boolean;
    active?: boolean;
    endDate?: string;
    volume24hr?: number;
    liquidity?: string;
    groupItemTitle?: string;
}

interface GammaMarketDirect {
    id: string;
    conditionId: string;
    questionID: string;
    question: string;
    outcomes: string;           // JSON string: '["Yes", "No"]'
    outcomePrices: string;      // JSON string: '["0.55", "0.45"]'
    clobTokenIds?: string;      // JSON string: '["token1", "token2"]'
    tokens?: Array<{ token_id: string; outcome: string }>;
    closed: boolean;
    active: boolean;
    endDate?: string;
    volume24hr: number;
    liquidity: string;
}

const CRYPTO_KEYWORDS = [
    'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
    'crypto', 'coinbase', 'binance', 'stablecoin', 'defi',
    'altcoin', 'blockchain',
];

const PRICE_PATTERN = /(?:above|below|over|under|reach|hit|exceed|drop below|fall below)\s*\$?([\d,]+(?:\.\d+)?)\s*(?:k|K)?/i;
const PRICE_K_PATTERN = /\$?([\d.]+)\s*[kK]/;

export class MarketScanner {
    private gammaUrl: string;

    constructor(config: PolynixConfig) {
        this.gammaUrl = config.broker.gamma_api_url;
    }

    /**
     * Scan for two types of markets:
     * 1. Crypto-related markets (for directional trading)
     * 2. All high-liquidity binary markets (for spread arbitrage)
     */
    async scan(config: PolynixConfig): Promise<{
        cryptoMarkets: CryptoMicroMarket[];
        arbMarkets: CryptoMicroMarket[];
    }> {
        const [cryptoMarkets, arbMarkets] = await Promise.all([
            this.scanCryptoMarkets(config),
            config.strategy.scan_all_for_arb
                ? this.scanAllMarketsForArb(config)
                : Promise.resolve([]),
        ]);

        return { cryptoMarkets, arbMarkets };
    }

    /**
     * Scan for crypto-related markets via the events endpoint.
     */
    private async scanCryptoMarkets(config: PolynixConfig): Promise<CryptoMicroMarket[]> {
        const events = await this.fetchEvents();
        return this.filterCryptoMarkets(events, config);
    }

    /**
     * Scan ALL high-liquidity binary markets for spread arbitrage.
     * Uses the /markets endpoint sorted by liquidity.
     */
    private async scanAllMarketsForArb(config: PolynixConfig): Promise<CryptoMicroMarket[]> {
        // Fetch from multiple sort orders to maximize arb discovery
        const limit = Math.floor(config.strategy.max_markets_per_scan / 2);
        const urls = [
            `${this.gammaUrl}/markets?closed=false&active=true&limit=${limit}&order=liquidity&ascending=false`,
            `${this.gammaUrl}/markets?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`,
        ];

        const allMarkets: GammaMarketDirect[] = [];
        const seenIds = new Set<string>();

        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(15_000),
                });
                if (!res.ok) continue;
                const data = await res.json() as GammaMarketDirect[];
                if (!Array.isArray(data)) continue;
                for (const m of data) {
                    if (!seenIds.has(m.conditionId)) {
                        seenIds.add(m.conditionId);
                        allMarkets.push(m);
                    }
                }
            } catch { continue; }
        }

        const markets = allMarkets;
        if (markets.length === 0) return [];

            const now = Date.now();
            const results: CryptoMicroMarket[] = [];

            for (const m of markets) {
                if (m.closed || !m.active) continue;

                // Must be binary (outcomes is a JSON string)
                let outcomes: string[];
                try {
                    outcomes = typeof m.outcomes === 'string'
                        ? JSON.parse(m.outcomes)
                        : m.outcomes;
                } catch { continue; }
                if (!outcomes || outcomes.length !== 2) continue;

                // Must have token IDs
                const tokenIds = this.extractTokenIds(m);
                if (!tokenIds) continue;

                // Must have minimum liquidity
                const liquidity = parseFloat(m.liquidity) || 0;
                if (liquidity < config.strategy.min_liquidity_usd) continue;

                // Check expiry
                if (!m.endDate) continue;
                const expiresAt = new Date(m.endDate).getTime();
                if (isNaN(expiresAt)) continue;
                const timeToExpiry = (expiresAt - now) / 1000;
                if (timeToExpiry < config.strategy.min_time_to_expiry_s) continue;
                if (timeToExpiry > config.strategy.max_time_to_expiry_s) continue;

                results.push({
                    conditionId: m.conditionId,
                    questionId: m.questionID ?? m.id,
                    title: m.question,
                    asset: this.extractAsset(m.question) ?? 'MACRO',
                    expiresAt,
                    timeToExpiry,
                    yesTokenId: tokenIds.yes,
                    noTokenId: tokenIds.no,
                    liquidity,
                    volume24hr: m.volume24hr || 0,
                    ...this.extractPriceTarget(m.question),
                });
            }

            return results;
        } catch {
            return [];
        }
    }

    private async fetchEvents(): Promise<GammaEvent[]> {
        // Fetch crypto-tagged events + general high-volume events
        const urls = [
            `${this.gammaUrl}/events?active=true&closed=false&limit=30&tag=crypto`,
            `${this.gammaUrl}/events?active=true&closed=false&limit=30&order=volume24hr&ascending=false`,
        ];

        const allEvents: GammaEvent[] = [];
        const seenIds = new Set<string>();

        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10_000),
                });
                if (!res.ok) continue;
                const data = await res.json();
                if (!Array.isArray(data)) continue;
                for (const event of data as GammaEvent[]) {
                    if (!seenIds.has(event.id)) {
                        seenIds.add(event.id);
                        allEvents.push(event);
                    }
                }
            } catch {
                continue;
            }
        }

        return allEvents;
    }

    private filterCryptoMarkets(events: GammaEvent[], config: PolynixConfig): CryptoMicroMarket[] {
        const now = Date.now();
        const results: CryptoMicroMarket[] = [];

        for (const event of events) {
            if (event.closed) continue;
            const markets = event.markets ?? [];

            for (const m of markets) {
                if (m.closed) continue;

                // Must be binary (outcomes is JSON string from API)
                let parsedOutcomes: string[];
                try {
                    parsedOutcomes = typeof m.outcomes === 'string'
                        ? JSON.parse(m.outcomes)
                        : m.outcomes;
                } catch { continue; }
                if (!parsedOutcomes || parsedOutcomes.length !== 2) continue;

                // Must have CLOB token IDs
                let tokenIds: { yes: string; no: string } | null = null;
                try {
                    const ids = JSON.parse(m.clobTokenIds);
                    if (Array.isArray(ids) && ids.length === 2) {
                        tokenIds = { yes: ids[0], no: ids[1] };
                    }
                } catch {
                    continue;
                }
                if (!tokenIds) continue;

                // Check expiry
                const endDate = m.endDate ?? event.endDate;
                if (!endDate) continue;
                const expiresAt = new Date(endDate).getTime();
                if (isNaN(expiresAt)) continue;
                const timeToExpiry = (expiresAt - now) / 1000;
                if (timeToExpiry < config.strategy.min_time_to_expiry_s) continue;
                if (timeToExpiry > config.strategy.max_time_to_expiry_s) continue;

                // Must be crypto-related (check event title, market question, tags)
                const searchText = [
                    m.question,
                    event.title,
                    event.slug,
                    ...(event.tags || []).map(t => t.label),
                ].join(' ').toLowerCase();

                const isCrypto = CRYPTO_KEYWORDS.some(kw => searchText.includes(kw));
                if (!isCrypto) continue;

                const asset = this.extractAsset(searchText.toUpperCase()) ?? 'CRYPTO';
                const liquidity = m.liquidity ? parseFloat(m.liquidity) : 0;

                results.push({
                    conditionId: m.conditionId,
                    questionId: m.questionID ?? m.id,
                    title: m.question ?? event.title,
                    asset,
                    expiresAt,
                    timeToExpiry,
                    yesTokenId: tokenIds.yes,
                    noTokenId: tokenIds.no,
                    liquidity,
                    volume24hr: m.volume24hr || 0,
                    ...this.extractPriceTarget(m.question ?? event.title),
                });
            }
        }

        // Sort by volume (most active first)
        results.sort((a, b) => b.volume24hr - a.volume24hr);
        return results;
    }

    /**
     * Extract a price target from market questions like:
     * "Will BTC be above $80,000 by June 2026?"
     * "Bitcoin to reach $100K?"
     */
    private extractPriceTarget(question: string): {
        priceTarget?: number;
        targetDirection?: 'above' | 'below';
    } {
        const q = question.toLowerCase();

        // Try the full pattern first
        let match = PRICE_PATTERN.exec(question);
        if (match) {
            let price = parseFloat(match[1].replace(/,/g, ''));
            // Check for K suffix
            if (/k$/i.test(match[0])) price *= 1000;
            const direction = /below|under|drop|fall/i.test(match[0]) ? 'below' : 'above';
            return { priceTarget: price, targetDirection: direction };
        }

        // Try $XXK pattern
        match = PRICE_K_PATTERN.exec(question);
        if (match) {
            const price = parseFloat(match[1]) * 1000;
            const direction = q.includes('below') || q.includes('under') || q.includes('drop') || q.includes('fall')
                ? 'below' : 'above';
            return { priceTarget: price, targetDirection: direction };
        }

        return {};
    }

    private extractAsset(text: string): string | null {
        const upper = text.toUpperCase();
        if (upper.includes('BITCOIN') || upper.includes('BTC')) return 'BTC';
        if (upper.includes('ETHEREUM') || upper.includes('ETH')) return 'ETH';
        if (upper.includes('SOLANA') || upper.includes('SOL')) return 'SOL';
        return null;
    }

    private extractTokenIds(market: GammaMarketDirect): { yes: string; no: string } | null {
        // Try tokens array first
        if (market.tokens && market.tokens.length === 2) {
            const yes = market.tokens.find(t => t.outcome === 'Yes');
            const no = market.tokens.find(t => t.outcome === 'No');
            if (yes && no) return { yes: yes.token_id, no: no.token_id };
            return { yes: market.tokens[0].token_id, no: market.tokens[1].token_id };
        }

        // Fall back to clobTokenIds
        if (market.clobTokenIds) {
            try {
                const ids = JSON.parse(market.clobTokenIds);
                if (Array.isArray(ids) && ids.length === 2) {
                    return { yes: ids[0], no: ids[1] };
                }
            } catch { /* ignore */ }
        }

        return null;
    }
}
