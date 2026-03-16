/**
 * External data sources for Copynix wallet discovery.
 *
 * Multi-source strategy:
 *   1. GeckoTerminal: trending Solana pools (free, no auth, replaces DexScreener)
 *   2. DexCheck: top trader leaderboards with wallet addresses + PnL (free tier 20k/mo)
 *   3. DexScreener: fallback trending tokens (free, no auth)
 */

export interface TrendingToken {
    mint: string;
    symbol: string;
    priceChangeH24: number;
    volumeH24: number;
    liquidityUsd: number;
    source: 'geckoterminal' | 'dexscreener';
}

export interface TopTrader {
    walletAddress: string;
    totalPnlUsd: number;
    winRate: number;
    tradeCount: number;
    source: 'dexcheck' | 'helius' | 'rpc';
}

// ─── GeckoTerminal (free, no auth) ──────────────────────────────────

/**
 * Fetch trending Solana pools from GeckoTerminal.
 * Returns token mints sorted by activity.
 */
export async function fetchTrendingGeckoTerminal(): Promise<TrendingToken[]> {
    try {
        const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1';
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
            console.warn(`[GeckoTerminal] HTTP ${res.status}`);
            return [];
        }

        const json = await res.json() as {
            data?: Array<{
                attributes: {
                    name: string;
                    base_token_price_usd: string;
                    price_change_percentage: { h24: string };
                    volume_usd: { h24: string };
                    reserve_in_usd: string;
                };
                relationships?: {
                    base_token?: { data?: { id: string } };
                };
            }>;
        };

        if (!json.data || !Array.isArray(json.data)) return [];

        const tokens: TrendingToken[] = [];
        const seenMints = new Set<string>();

        for (const pool of json.data) {
            const attrs = pool.attributes;
            // Extract mint from relationship ID (format: "solana_<mint>")
            const tokenId = pool.relationships?.base_token?.data?.id ?? '';
            const mint = tokenId.replace('solana_', '');
            if (!mint || mint.length < 20 || seenMints.has(mint)) continue;
            seenMints.add(mint);

            tokens.push({
                mint,
                symbol: attrs.name?.split(' / ')?.[0] ?? 'UNKNOWN',
                priceChangeH24: parseFloat(attrs.price_change_percentage?.h24 ?? '0'),
                volumeH24: parseFloat(attrs.volume_usd?.h24 ?? '0'),
                liquidityUsd: parseFloat(attrs.reserve_in_usd ?? '0'),
                source: 'geckoterminal',
            });
        }

        console.log(`[GeckoTerminal] ${tokens.length} trending Solana tokens`);
        return tokens;
    } catch (err) {
        console.warn(`[GeckoTerminal] Error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

// ─── DexCheck (free tier: 20k calls/mo) ─────────────────────────────

/**
 * Fetch top Solana traders from DexCheck leaderboards.
 * Returns wallet addresses with verified PnL and win rate.
 *
 * Requires DEXCHECK_API_KEY env var.
 */
export async function fetchTopTradersDexCheck(timeframe: '24h' | '7d' | '30d' = '7d'): Promise<TopTrader[]> {
    const apiKey = process.env.DEXCHECK_API_KEY;
    if (!apiKey) {
        console.log('[DexCheck] No DEXCHECK_API_KEY — skipping');
        return [];
    }

    try {
        // DexCheck top traders endpoint for Solana
        const url = `https://api.dexcheck.ai/v1/dex/top-traders?chain=solana&timeframe=${timeframe}&limit=50&sort=profit`;
        const res = await fetch(url, {
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            console.warn(`[DexCheck] HTTP ${res.status}: ${res.statusText}`);
            return [];
        }

        const json = await res.json() as {
            data?: Array<{
                wallet_address?: string;
                address?: string;
                total_profit?: number;
                profit?: number;
                pnl?: number;
                win_rate?: number;
                total_trades?: number;
                trade_count?: number;
            }>;
        };

        const traders = json.data ?? [];
        if (!Array.isArray(traders)) return [];

        const results: TopTrader[] = [];
        for (const t of traders) {
            const address = t.wallet_address ?? t.address;
            if (!address) continue;

            const pnl = t.total_profit ?? t.profit ?? t.pnl ?? 0;
            const winRate = t.win_rate ?? 0;
            const tradeCount = t.total_trades ?? t.trade_count ?? 0;

            // Only include profitable traders with meaningful activity
            if (pnl <= 0 || tradeCount < 5) continue;

            results.push({
                walletAddress: address,
                totalPnlUsd: pnl,
                winRate,
                tradeCount,
                source: 'dexcheck',
            });
        }

        console.log(`[DexCheck] ${results.length} profitable traders found (${timeframe})`);
        return results;
    } catch (err) {
        console.warn(`[DexCheck] Error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

// ─── Dune Analytics (free community tier) ───────────────────────────

/**
 * Fetch profitable Solana wallets from Dune Analytics public dashboards.
 *
 * Uses pre-built community queries for "Solana Alpha Wallets" and
 * "Profitable Memecoin Wallets". Free tier: 2,500 credits/mo.
 *
 * Requires DUNE_API_KEY env var.
 */
export async function fetchTopWalletsDune(): Promise<TopTrader[]> {
    const apiKey = process.env.DUNE_API_KEY;
    if (!apiKey) {
        console.log('[Dune] No DUNE_API_KEY — skipping');
        return [];
    }

    try {
        // Dune query 3476547 = "Solana Top Traders by PnL (30d)"
        // This is a popular community query. If it doesn't work, we fallback gracefully.
        const queryId = '3476547';
        const url = `https://api.dune.com/api/v1/query/${queryId}/results?limit=50`;
        const res = await fetch(url, {
            headers: {
                'X-Dune-API-Key': apiKey,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            console.warn(`[Dune] HTTP ${res.status}: ${res.statusText}`);
            return [];
        }

        const json = await res.json() as {
            result?: {
                rows?: Array<{
                    wallet?: string;
                    address?: string;
                    trader?: string;
                    pnl?: number;
                    total_pnl?: number;
                    profit?: number;
                    win_rate?: number;
                    trades?: number;
                    total_trades?: number;
                }>;
            };
        };

        const rows = json.result?.rows ?? [];
        if (!Array.isArray(rows) || rows.length === 0) {
            console.log('[Dune] No results from query');
            return [];
        }

        const results: TopTrader[] = [];
        for (const row of rows) {
            const address = row.wallet ?? row.address ?? row.trader;
            if (!address || address.length < 20) continue;

            const pnl = row.pnl ?? row.total_pnl ?? row.profit ?? 0;
            const winRate = row.win_rate ?? 0;
            const trades = row.trades ?? row.total_trades ?? 0;

            if (pnl < 5000 || trades < 10) continue; // Only quality wallets

            results.push({
                walletAddress: address,
                totalPnlUsd: pnl,
                winRate: winRate > 1 ? winRate : winRate * 100, // Handle 0-1 or 0-100 format
                tradeCount: trades,
                source: 'dexcheck', // Reuse type for simplicity
            });
        }

        console.log(`[Dune] ${results.length} profitable wallets from Dune query`);
        return results;
    } catch (err) {
        console.warn(`[Dune] Error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

// ─── DexScreener (fallback) ─────────────────────────────────────────

/**
 * Fetch trending Solana tokens from DexScreener.
 * Fallback if GeckoTerminal is unavailable.
 */
export async function fetchTrendingDexScreener(): Promise<TrendingToken[]> {
    try {
        const url = 'https://api.dexscreener.com/token-boosts/top/v1';
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];

        const data = await res.json() as Array<{
            tokenAddress: string;
            chainId: string;
            amount: number;
        }>;

        if (!Array.isArray(data)) return [];

        return data
            .filter(t => t.chainId === 'solana')
            .slice(0, 10)
            .map(t => ({
                mint: t.tokenAddress,
                symbol: 'UNKNOWN',
                priceChangeH24: 0,
                volumeH24: 0,
                liquidityUsd: 0,
                source: 'dexscreener' as const,
            }));
    } catch {
        return [];
    }
}
