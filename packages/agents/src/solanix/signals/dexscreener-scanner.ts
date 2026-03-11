import type { DexScreenerToken } from '../types';

// DexScreener API response shapes
interface DexScreenerPair {
    chainId: string;
    baseToken: { symbol: string; address: string };
    priceUsd: string;
    volume: { h24: number; h1: number };
    liquidity: { usd: number };
    pairCreatedAt: number;
}

interface DexScreenerResponse {
    pairs: DexScreenerPair[] | null;
}

interface DexScreenerScannerConfig {
    /** Minimum liquidity in USD to include a token */
    minLiquidityUsd: number;
    /** Minimum ratio of h1 volume vs average hourly h24 volume to qualify as a spike */
    volumeSpikeMultiplier: number;
    /** Time-to-live in ms for dynamically added tokens */
    dynamicTtlMs: number;
}

interface DynamicEntry {
    token: DexScreenerToken;
    addedAt: number;
}

// Query the Solana chain directly for trending pairs (broader discovery than a single mint)
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/search?q=solana';

// Skip wrapped SOL itself — we want the *counterpart* tokens
const SKIP_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

export class DexScreenerScanner {
    private readonly config: DexScreenerScannerConfig;
    private readonly dynamicMap: Map<string, DynamicEntry> = new Map();

    constructor(config: DexScreenerScannerConfig) {
        this.config = config;
    }

    /**
     * Fetch active Solana pairs from DexScreener, apply liquidity and
     * volume-spike filters, and return qualifying tokens.
     * Returns an empty array on any network or parse failure.
     */
    async scan(): Promise<DexScreenerToken[]> {
        try {
            const res = await fetch(DEXSCREENER_URL);
            if (!res.ok) return [];

            const data = (await res.json()) as DexScreenerResponse;
            const pairs = data.pairs ?? [];

            const { minLiquidityUsd, volumeSpikeMultiplier } = this.config;

            return pairs
                .filter((pair) => {
                    // Only Solana chain pairs
                    if (pair.chainId !== 'solana') return false;
                    // Skip stablecoins and SOL itself — we want altcoins
                    if (SKIP_SYMBOLS.has(pair.baseToken.symbol.toUpperCase())) return false;
                    // Liquidity gate
                    if (pair.liquidity.usd < minLiquidityUsd) return false;
                    // Volume-spike gate: h1 volume vs average hourly h24 volume
                    const avgHourlyVolume = pair.volume.h24 / 24;
                    if (avgHourlyVolume === 0) return false;
                    const spikeRatio = pair.volume.h1 / avgHourlyVolume;
                    return spikeRatio >= volumeSpikeMultiplier;
                })
                .map((pair): DexScreenerToken => ({
                    symbol: pair.baseToken.symbol,
                    mintAddress: pair.baseToken.address,
                    priceUsd: parseFloat(pair.priceUsd),
                    volume24h: pair.volume.h24,
                    volumeChange1h: pair.volume.h1,
                    liquidityUsd: pair.liquidity.usd,
                    pairCreatedAt: pair.pairCreatedAt,
                }));
        } catch {
            return [];
        }
    }

    /**
     * Add a token to the dynamic watchlist with the current timestamp.
     * Overwrites any existing entry for the same symbol.
     */
    addToken(symbol: string, mintAddress: string, priceUsd: number): void {
        const token: DexScreenerToken = {
            symbol,
            mintAddress,
            priceUsd,
            volume24h: 0,
            volumeChange1h: 0,
            liquidityUsd: 0,
            pairCreatedAt: Date.now(),
        };
        this.dynamicMap.set(symbol, { token, addedAt: Date.now() });
    }

    /**
     * Remove dynamic entries that have exceeded dynamicTtlMs.
     */
    evictExpired(): void {
        const now = Date.now();
        for (const [symbol, entry] of this.dynamicMap.entries()) {
            if (now - entry.addedAt >= this.config.dynamicTtlMs) {
                this.dynamicMap.delete(symbol);
            }
        }
    }

    /**
     * Return the symbols currently tracked in the dynamic map.
     */
    getDynamicSymbols(): string[] {
        return Array.from(this.dynamicMap.keys());
    }

    /**
     * Return the full dynamic token entries (including metadata).
     */
    getDynamicTokens(): DynamicEntry[] {
        return Array.from(this.dynamicMap.values());
    }
}
