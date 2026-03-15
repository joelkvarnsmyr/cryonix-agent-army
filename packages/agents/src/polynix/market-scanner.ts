import type { CryptoMicroMarket, PolynixConfig } from './types';

interface GammaEvent {
    id: string;
    title: string;
    slug: string;
    closed: boolean;
    endDate?: string;
    markets?: GammaMarketEntry[];
}

interface GammaMarketEntry {
    id: string;
    conditionId: string;
    questionID: string;
    question: string;
    outcomes: string[];       // e.g. ["Yes", "No"]
    outcomePrices: string;    // JSON: '["0.52","0.48"]'
    clobTokenIds: string;     // JSON: '["token1","token2"]'
    closed: boolean;
    endDate?: string;
    groupItemTitle?: string;
}

const CRYPTO_ASSETS = ['BTC', 'ETH', 'SOL', 'BITCOIN', 'ETHEREUM', 'SOLANA'];

export class MarketScanner {
    private gammaUrl: string;

    constructor(config: PolynixConfig) {
        this.gammaUrl = config.broker.gamma_api_url;
    }

    async scan(config: PolynixConfig): Promise<CryptoMicroMarket[]> {
        const events = await this.fetchCryptoEvents();
        return this.filterEligible(events, config);
    }

    private async fetchCryptoEvents(): Promise<GammaEvent[]> {
        const url = `${this.gammaUrl}/events?active=true&closed=false&limit=50&tag=crypto`;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data as GammaEvent[] : [];
        } catch {
            return [];
        }
    }

    private filterEligible(events: GammaEvent[], config: PolynixConfig): CryptoMicroMarket[] {
        const now = Date.now();
        const results: CryptoMicroMarket[] = [];

        for (const event of events) {
            if (event.closed) continue;
            const markets = event.markets ?? [];

            for (const m of markets) {
                if (m.closed) continue;

                // Must be binary (exactly 2 outcomes)
                if (!m.outcomes || m.outcomes.length !== 2) continue;

                // Must have CLOB token IDs
                let tokenIds: string[];
                try {
                    tokenIds = JSON.parse(m.clobTokenIds);
                } catch {
                    continue;
                }
                if (tokenIds.length !== 2) continue;

                // Check expiry
                const endDate = m.endDate ?? event.endDate;
                if (!endDate) continue;
                const expiresAt = new Date(endDate).getTime();
                if (isNaN(expiresAt)) continue;

                const timeToExpiry = (expiresAt - now) / 1000;

                // Must expire within window
                if (timeToExpiry < config.strategy.min_time_to_expiry_s) continue;
                if (timeToExpiry > config.strategy.max_time_to_expiry_s) continue;

                // Must be crypto-related
                const title = (m.question ?? event.title).toUpperCase();
                const asset = this.extractAsset(title);
                if (!asset) continue;

                results.push({
                    conditionId: m.conditionId,
                    questionId: m.questionID ?? m.id,
                    title: m.question ?? event.title,
                    asset,
                    expiresAt,
                    timeToExpiry,
                    yesTokenId: tokenIds[0],
                    noTokenId: tokenIds[1],
                });
            }
        }

        // Sort by soonest expiry first
        results.sort((a, b) => a.timeToExpiry - b.timeToExpiry);
        return results;
    }

    private extractAsset(title: string): string | null {
        for (const asset of CRYPTO_ASSETS) {
            if (title.includes(asset)) {
                // Normalize to ticker
                if (asset === 'BITCOIN') return 'BTC';
                if (asset === 'ETHEREUM') return 'ETH';
                if (asset === 'SOLANA') return 'SOL';
                return asset;
            }
        }
        return null;
    }
}
