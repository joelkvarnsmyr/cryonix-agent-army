import { OpenAI } from 'openai';

/** Minimum fields we need from a DexScreener pair. */
interface DexPair {
    chainId: string;
    baseToken: { symbol: string; address: string };
    volume: { h24: number };
    liquidity: { usd: number };
}

/** Token entry returned by the curator. */
export interface WatchlistToken {
    symbol: string;
    mintAddress: string;
    source: 'core' | 'dexscreener' | 'coingecko' | 'grok';
}

// Tokens to always exclude (wrapped SOL, stablecoins, spam)
const SKIP_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'USDD', 'DAI', 'BUSD']);

export class SolanaWatchlistCurator {
    private lastRefreshDate: string | null = null;

    constructor(
        private readonly xaiApiKey: string | null,
        private readonly coreSymbols: string[],
        private readonly coreMints: Record<string, string>,
        private readonly minLiquidityUsd: number = 50_000,
        private readonly logger?: { info: (msg: string) => void },
    ) {}

    needsRefresh(): boolean {
        const today = new Date().toISOString().slice(0, 10);
        return this.lastRefreshDate !== today;
    }

    markRefreshed(): void {
        this.lastRefreshDate = new Date().toISOString().slice(0, 10);
    }

    // -------------------------------------------------------------------------
    // Source 1: DexScreener trending Solana tokens (free, no key)
    // -------------------------------------------------------------------------

    private async getDexScreenerTrending(): Promise<WatchlistToken[]> {
        try {
            const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
            if (!res.ok) return [];
            const data = await res.json() as { pairs: DexPair[] | null };
            const pairs = data.pairs ?? [];

            const seen = new Set<string>();
            const tokens: WatchlistToken[] = [];

            for (const pair of pairs) {
                if (pair.chainId !== 'solana') continue;
                const sym = pair.baseToken.symbol.toUpperCase();
                if (SKIP_SYMBOLS.has(sym)) continue;
                if (seen.has(sym)) continue;
                if (pair.liquidity.usd < this.minLiquidityUsd) continue;

                seen.add(sym);
                tokens.push({
                    symbol: sym,
                    mintAddress: pair.baseToken.address,
                    source: 'dexscreener',
                });

                if (tokens.length >= 15) break;
            }

            return tokens;
        } catch {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Source 2: CoinGecko top Solana tokens by market cap (free, no key)
    // -------------------------------------------------------------------------

    private async getCoinGeckoTopSolana(): Promise<WatchlistToken[]> {
        try {
            const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-ecosystem&order=volume_desc&per_page=20&page=1';
            const res = await fetch(url);
            if (!res.ok) return [];
            const coins = await res.json() as Array<{ symbol: string; id: string }>;

            return coins
                .map(c => c.symbol.toUpperCase())
                .filter(s => !SKIP_SYMBOLS.has(s))
                .slice(0, 15)
                .map(symbol => ({
                    symbol,
                    mintAddress: this.coreMints[symbol] ?? '',
                    source: 'coingecko' as const,
                }));
        } catch {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Source 3: Grok thematic picks (optional, needs XAI_API_KEY)
    // -------------------------------------------------------------------------

    private async getGrokPicks(): Promise<WatchlistToken[]> {
        if (!this.xaiApiKey) return [];
        try {
            const grok = new OpenAI({ apiKey: this.xaiApiKey, baseURL: 'https://api.x.ai/v1' });
            const date = new Date().toISOString().slice(0, 10);
            const response = await grok.chat.completions.create({
                model: 'grok-3-mini',
                messages: [
                    {
                        role: 'user',
                        content: `You are a Solana DeFi trading analyst. Today is ${date}.

Search X and crypto news for the 10 most interesting Solana ecosystem tokens to watch TODAY. Focus on:
- Tokens with volume surges or trending on X
- DeFi protocols with TVL growth or new launches
- Memecoins gaining viral momentum on Solana
- Tokens with upcoming airdrops, migrations, or catalysts
- Tokens recovering from dips with bullish reversal signals

Return ONLY a JSON array, no other text:
[{"symbol": "TICKER", "mint": "solana_mint_address_if_known_or_empty", "reason": "..."}]

Solana SPL tokens only. Max 10 entries.`,
                    },
                ],
                temperature: 0.3,
                max_tokens: 600,
                // @ts-expect-error xAI-specific search parameter
                search: { mode: 'on' },
            });

            const content = response.choices[0]?.message?.content ?? '';
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) return [];
            const picks = JSON.parse(jsonMatch[0]) as Array<{ symbol: string; mint?: string }>;
            return picks
                .filter(p => typeof p.symbol === 'string' && p.symbol.length > 0)
                .map(p => ({
                    symbol: p.symbol.toUpperCase(),
                    mintAddress: p.mint || this.coreMints[p.symbol.toUpperCase()] || '',
                    source: 'grok' as const,
                }));
        } catch {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Main curate method
    // -------------------------------------------------------------------------

    async curate(): Promise<WatchlistToken[]> {
        const today = new Date().toISOString().slice(0, 10);
        const combined = new Map<string, WatchlistToken>();

        // Core symbols always included
        for (const sym of this.coreSymbols) {
            combined.set(sym, {
                symbol: sym,
                mintAddress: this.coreMints[sym] ?? '',
                source: 'core',
            });
        }

        // Source 1: DexScreener trending
        const dexTokens = await this.getDexScreenerTrending();
        for (const t of dexTokens) {
            if (!combined.has(t.symbol)) combined.set(t.symbol, t);
        }

        // Source 2: CoinGecko top Solana by volume
        const geckoTokens = await this.getCoinGeckoTopSolana();
        for (const t of geckoTokens) {
            if (!combined.has(t.symbol)) combined.set(t.symbol, t);
        }

        // Source 3: Grok thematic picks
        const grokTokens = await this.getGrokPicks();
        for (const t of grokTokens) {
            if (!combined.has(t.symbol)) combined.set(t.symbol, t);
        }

        // Cap at 25 tokens (CoinGecko rate limit friendly: 25 requests per 15min scan)
        const result = Array.from(combined.values()).slice(0, 25);

        this.logger?.info(
            `SolanaWatchlistCurator: ${combined.size} total (core: ${this.coreSymbols.length}, dex: ${dexTokens.length}, gecko: ${geckoTokens.length}, grok: ${grokTokens.length}) → capped at ${result.length}`
        );

        this.lastRefreshDate = today;
        return result;
    }
}
