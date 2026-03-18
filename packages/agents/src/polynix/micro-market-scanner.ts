/**
 * MicroMarketScanner — discovers 5-minute crypto binary markets on Polymarket.
 *
 * Polymarket runs continuous 5-min "Up or Down" markets for BTC, ETH, SOL.
 * New markets are created every 5 minutes with slug pattern:
 *   {asset}-updown-5m-{unix_timestamp}
 *
 * Example: btc-updown-5m-1773839100 → "Bitcoin Up or Down - March 18, 9:05AM-9:10AM ET"
 *
 * The scanner generates upcoming slug timestamps, fetches events from Gamma API,
 * and returns tradeable markets expiring in the configured window.
 */

import type { CryptoMicroMarket } from './types';

const GAMMA_API = 'https://gamma-api.polymarket.com';

const MICRO_ASSETS = [
    { slug: 'btc', asset: 'BTC' },
    { slug: 'eth', asset: 'ETH' },
    { slug: 'sol', asset: 'SOL' },
];

interface MicroMarketConfig {
    enabled: boolean;
    min_time_to_expiry_s: number;
    max_time_to_expiry_s: number;
    max_bet_size_usd: number;
}

export class MicroMarketScanner {
    /**
     * Scan for active 5-minute crypto markets.
     * Generates slug timestamps for current + upcoming 5-min windows,
     * then fetches matching events from Gamma API.
     */
    async scan(config: MicroMarketConfig): Promise<CryptoMicroMarket[]> {
        if (!config.enabled) return [];

        const now = Date.now();
        const nowSec = Math.floor(now / 1000);

        // Generate timestamps for current + next 4 windows (20 min ahead)
        const currentWindow = Math.floor(nowSec / 300) * 300;
        const timestamps: number[] = [];
        for (let i = -1; i <= 4; i++) {
            timestamps.push(currentWindow + (i * 300));
        }

        const results: CryptoMicroMarket[] = [];

        // Fetch all asset + timestamp combinations in parallel (batched)
        const fetches: Promise<void>[] = [];

        for (const ts of timestamps) {
            for (const { slug, asset } of MICRO_ASSETS) {
                fetches.push(
                    this.fetchMicroMarket(slug, asset, ts, now, config)
                        .then(market => { if (market) results.push(market); })
                        .catch(() => { /* ignore individual failures */ })
                );
            }
        }

        // Execute in batches of 6 to respect rate limits
        const batchSize = 6;
        for (let i = 0; i < fetches.length; i += batchSize) {
            await Promise.allSettled(fetches.slice(i, i + batchSize));
            if (i + batchSize < fetches.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        return results.sort((a, b) => a.timeToExpiry - b.timeToExpiry);
    }

    private async fetchMicroMarket(
        slugPrefix: string,
        asset: string,
        timestamp: number,
        now: number,
        config: MicroMarketConfig,
    ): Promise<CryptoMicroMarket | null> {
        const slug = `${slugPrefix}-updown-5m-${timestamp}`;
        const url = `${GAMMA_API}/events?slug=${slug}&limit=1`;

        const res = await fetch(url, {
            signal: AbortSignal.timeout(5_000),
            headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) return null;

        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) return null;

        const event = events[0];
        const markets = event.markets ?? [];

        for (const m of markets) {
            if (m.closed) continue;

            // Parse outcomes
            let outcomes: string[];
            try {
                outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
            } catch { continue; }
            if (!outcomes || outcomes.length !== 2) continue;

            // Parse token IDs
            let tokenIds: string[];
            try {
                tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : [];
            } catch { continue; }
            if (tokenIds.length !== 2) continue;

            // Check expiry
            const endDate = m.endDate ?? event.endDate;
            if (!endDate) continue;
            const expiresAt = new Date(endDate).getTime();
            const timeToExpiry = (expiresAt - now) / 1000;

            if (timeToExpiry < config.min_time_to_expiry_s) continue;
            if (timeToExpiry > config.max_time_to_expiry_s) continue;

            return {
                conditionId: m.conditionId,
                questionId: m.questionID ?? m.id,
                title: m.question ?? event.title,
                asset,
                expiresAt,
                timeToExpiry,
                yesTokenId: tokenIds[0],
                noTokenId: tokenIds[1],
                liquidity: parseFloat(m.liquidity ?? '0'),
                volume24hr: m.volume24hr ?? 0,
            };
        }

        return null;
    }
}
