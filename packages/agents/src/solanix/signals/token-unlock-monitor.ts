/**
 * Token Unlock Monitor
 *
 * Tracks upcoming token unlocks for Solanix watchlist tokens.
 * Uses a static schedule of known major unlocks (updated periodically)
 * with a DeFiLlama API fallback for dynamic discovery.
 *
 * Large unlocks (high % of circulating supply) within a few days
 * represent significant sell pressure and reduce signal confidence.
 */

export interface TokenUnlockEvent {
    symbol: string;
    unlockDate: Date;
    amountUsd: number;
    percentOfCirculating: number;
    daysUntil: number;
    severity: 'low' | 'medium' | 'high';
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const DEFILLAMA_UNLOCKS_URL = 'https://api.llama.fi/emissions/breakdown';

/**
 * Known upcoming token unlocks for Solana ecosystem tokens.
 * Maintained manually — update when new schedules are announced.
 * Dates are in UTC. percentOfCirculating is an estimate.
 */
const STATIC_UNLOCKS: Array<Omit<TokenUnlockEvent, 'daysUntil' | 'severity'>> = [
    { symbol: 'JUP', unlockDate: new Date('2026-04-30T12:00:00Z'), amountUsd: 150_000_000, percentOfCirculating: 8.5 },
    { symbol: 'PYTH', unlockDate: new Date('2026-05-20T00:00:00Z'), amountUsd: 200_000_000, percentOfCirculating: 12.0 },
    { symbol: 'WIF', unlockDate: new Date('2026-06-15T00:00:00Z'), amountUsd: 30_000_000, percentOfCirculating: 3.0 },
    { symbol: 'RNDR', unlockDate: new Date('2026-04-15T00:00:00Z'), amountUsd: 80_000_000, percentOfCirculating: 5.0 },
    { symbol: 'BONK', unlockDate: new Date('2026-07-01T00:00:00Z'), amountUsd: 20_000_000, percentOfCirculating: 1.5 },
];

function classifySeverity(percentOfCirculating: number): 'low' | 'medium' | 'high' {
    if (percentOfCirculating >= 5.0) return 'high';
    if (percentOfCirculating >= 2.0) return 'medium';
    return 'low';
}

interface DefiLlamaEmission {
    name: string;
    events?: Array<{
        timestamp: number;
        noOfTokens?: number[];
        price?: number;
    }>;
}

/** Solana watchlist symbols to match against DeFiLlama data */
const WATCHLIST_ALIASES: Record<string, string[]> = {
    SOL: ['solana'],
    JUP: ['jupiter'],
    BONK: ['bonk'],
    WIF: ['dogwifhat'],
    PYTH: ['pyth-network', 'pyth'],
    RNDR: ['render', 'render-token'],
};

export class TokenUnlockMonitor {
    private cached: TokenUnlockEvent[] | null = null;
    private cacheTs = 0;

    /**
     * Try to fetch unlock data from DeFiLlama emissions API.
     * Returns events matching watchlist tokens, or empty array on failure.
     */
    private async fetchFromDefiLlama(days: number): Promise<TokenUnlockEvent[]> {
        try {
            const res = await fetch(DEFILLAMA_UNLOCKS_URL, {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return [];

            const data = (await res.json()) as DefiLlamaEmission[];
            if (!Array.isArray(data)) return [];

            const now = Date.now();
            const cutoff = now + days * 24 * 60 * 60 * 1000;
            const events: TokenUnlockEvent[] = [];

            for (const protocol of data) {
                // Match protocol name to our watchlist
                const nameLC = protocol.name.toLowerCase();
                let matchedSymbol: string | null = null;

                for (const [symbol, aliases] of Object.entries(WATCHLIST_ALIASES)) {
                    if (aliases.some(a => nameLC.includes(a)) || nameLC === symbol.toLowerCase()) {
                        matchedSymbol = symbol;
                        break;
                    }
                }

                if (!matchedSymbol || !protocol.events) continue;

                for (const evt of protocol.events) {
                    const unlockTs = evt.timestamp * 1000;
                    if (unlockTs < now || unlockTs > cutoff) continue;

                    const tokens = evt.noOfTokens?.[0] ?? 0;
                    const price = evt.price ?? 0;
                    const amountUsd = tokens * price;
                    // Rough estimate — DeFiLlama doesn't always provide circ supply
                    const percentOfCirculating = amountUsd > 100_000_000 ? 5.0 : amountUsd > 10_000_000 ? 2.0 : 0.5;

                    const daysUntil = Math.ceil((unlockTs - now) / (24 * 60 * 60 * 1000));

                    events.push({
                        symbol: matchedSymbol,
                        unlockDate: new Date(unlockTs),
                        amountUsd,
                        percentOfCirculating,
                        daysUntil,
                        severity: classifySeverity(percentOfCirculating),
                    });
                }
            }

            return events;
        } catch {
            return [];
        }
    }

    /**
     * Build events from the static unlock schedule.
     */
    private getStaticUnlocks(days: number): TokenUnlockEvent[] {
        const now = Date.now();
        const cutoff = now + days * 24 * 60 * 60 * 1000;

        return STATIC_UNLOCKS
            .filter(u => u.unlockDate.getTime() > now && u.unlockDate.getTime() <= cutoff)
            .map(u => ({
                ...u,
                daysUntil: Math.ceil((u.unlockDate.getTime() - now) / (24 * 60 * 60 * 1000)),
                severity: classifySeverity(u.percentOfCirculating),
            }));
    }

    /**
     * Get upcoming token unlock events within the specified number of days.
     * Merges static schedule with DeFiLlama data. Cached for 6 hours.
     */
    async getUpcoming(days: number): Promise<TokenUnlockEvent[]> {
        const now = Date.now();
        if (this.cached && now - this.cacheTs < CACHE_TTL_MS) {
            // Re-filter cached results for the requested window
            return this.cached.filter(e => e.daysUntil <= days && e.daysUntil > 0);
        }

        // Fetch with a wide window (90 days) and cache; filter on read
        const maxDays = 90;
        const staticEvents = this.getStaticUnlocks(maxDays);
        const dynamicEvents = await this.fetchFromDefiLlama(maxDays);

        // Merge: dynamic events take precedence (more up-to-date)
        const byKey = new Map<string, TokenUnlockEvent>();
        for (const e of staticEvents) {
            byKey.set(`${e.symbol}:${e.unlockDate.toISOString().slice(0, 10)}`, e);
        }
        for (const e of dynamicEvents) {
            byKey.set(`${e.symbol}:${e.unlockDate.toISOString().slice(0, 10)}`, e);
        }

        this.cached = Array.from(byKey.values()).sort((a, b) => a.daysUntil - b.daysUntil);
        this.cacheTs = now;

        return this.cached.filter(e => e.daysUntil <= days && e.daysUntil > 0);
    }
}
