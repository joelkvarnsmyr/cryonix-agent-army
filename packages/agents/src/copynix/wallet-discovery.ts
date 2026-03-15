import type { TrackedWallet } from './types';
import { WalletProfiler } from './wallet-profiler';

/**
 * WalletDiscovery — finds new profitable Solana wallets to copy.
 *
 * Pipeline:
 *   1. DexScreener trending tokens → find early buyers via Helius
 *   2. WalletProfiler: deep-verify candidate's ENTIRE swap history
 *      (win rate, PnL, trade frequency across ALL tokens — not just one)
 *   3. Only wallets with proven multi-token profitability are added
 */

interface CandidateWallet {
    address: string;
    trades: number;
    wins: number;
    totalPnlUsd: number;
    avgHoldMinutes: number;
    lastSeen: number;
}

export class WalletDiscovery {
    private heliusKey: string | null;
    private existing: Set<string>;
    private maxTracked: number;

    constructor(config: {
        helius_api_key: string | null;
        existing_wallets: string[];
        max_tracked: number;
    }) {
        this.heliusKey = config.helius_api_key;
        this.existing = new Set(config.existing_wallets);
        this.maxTracked = config.max_tracked;
    }

    /**
     * Discover new wallets by analyzing top traders on trending Solana tokens.
     * Returns wallets that pass the quality filter, sorted by estimated score.
     */
    async discover(): Promise<TrackedWallet[]> {
        if (!this.heliusKey) {
            console.log('[WalletDiscovery] No HELIUS_API_KEY — skipping discovery');
            return [];
        }

        const slotsAvailable = this.maxTracked - this.existing.size;
        if (slotsAvailable <= 0) {
            console.log('[WalletDiscovery] Max tracked wallets reached');
            return [];
        }

        // Step 1: Find trending tokens on DexScreener
        const trendingMints = await this.getTrendingMints();
        if (trendingMints.length === 0) {
            console.log('[WalletDiscovery] No trending Solana tokens found on DexScreener');
            return [];
        }

        console.log(`[WalletDiscovery] Found ${trendingMints.length} trending tokens`);

        // Step 2: For each trending token, find wallets that bought early + profited
        const candidates = new Map<string, CandidateWallet>();
        let tokensAnalyzed = 0;
        let totalCandidates = 0;

        for (const mint of trendingMints.slice(0, 5)) {
            try {
                const earlyBuyers = await this.findEarlyBuyers(mint);
                tokensAnalyzed++;
                totalCandidates += earlyBuyers.length;

                for (const buyer of earlyBuyers) {
                    if (this.existing.has(buyer.address)) continue;

                    const existing = candidates.get(buyer.address);
                    if (existing) {
                        existing.trades += buyer.trades;
                        existing.wins += buyer.wins;
                        existing.totalPnlUsd += buyer.totalPnlUsd;
                        existing.lastSeen = Math.max(existing.lastSeen, buyer.lastSeen);
                    } else {
                        candidates.set(buyer.address, { ...buyer });
                    }
                }

                // Rate limit between tokens (2s to stay under Helius 10 RPS)
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.warn(`[WalletDiscovery] Error analyzing mint ${mint.slice(0, 8)}:`, err);
            }
        }

        console.log(`[WalletDiscovery] Analyzed ${tokensAnalyzed} tokens → ${totalCandidates} raw candidates → ${candidates.size} unique wallets`);

        // Step 3: Pre-filter by basic metrics (min 2 trades on trending tokens)
        const preFiltered = Array.from(candidates.values())
            .filter(c => c.trades >= 2)
            .sort((a, b) => b.trades - a.trades)
            .slice(0, 10); // Top 10 candidates for deep profiling

        if (preFiltered.length === 0) {
            console.log(`[WalletDiscovery] No candidates with ≥2 trades on trending tokens`);
            return [];
        }

        console.log(`[WalletDiscovery] ${preFiltered.length} candidates for deep profiling...`);

        // Step 4: Deep profile each candidate's ENTIRE swap history
        const profiler = new WalletProfiler(this.heliusKey!);
        const qualified: Array<{ candidate: CandidateWallet; winRate: number; pnl: number; totalTrades: number; uniqueTokens: number }> = [];

        for (const candidate of preFiltered) {
            try {
                const profile = await profiler.profile(candidate.address);

                if (profile.isQualified) {
                    qualified.push({
                        candidate,
                        winRate: profile.winRate,
                        pnl: profile.estimatedPnlUsd,
                        totalTrades: profile.totalTrades,
                        uniqueTokens: profile.uniqueTokens,
                    });
                }

                // Rate limit between profiles (2s per Helius call)
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.warn(`[WalletDiscovery] Profile error ${candidate.address.slice(0, 8)}:`, err);
            }

            if (qualified.length >= slotsAvailable) break;
        }

        if (qualified.length === 0) {
            console.log(`[WalletDiscovery] No wallets passed deep profiling (need ≥3 trades, ≥50% WR, positive PnL)`);
            return [];
        }

        // Step 5: Sort by composite score and convert to TrackedWallet
        qualified.sort((a, b) => {
            const scoreA = (a.winRate / 100) * Math.sqrt(a.totalTrades) * Math.log10(Math.max(1, a.pnl));
            const scoreB = (b.winRate / 100) * Math.sqrt(b.totalTrades) * Math.log10(Math.max(1, b.pnl));
            return scoreB - scoreA;
        });

        console.log(`[WalletDiscovery] ${qualified.length} wallet(s) VERIFIED:`);
        for (const q of qualified) {
            console.log(`  ${q.candidate.address.slice(0, 8)}... WR=${q.winRate.toFixed(0)}% PnL=$${q.pnl.toFixed(0)} trades=${q.totalTrades} tokens=${q.uniqueTokens}`);
        }

        const now = Date.now();
        return qualified.slice(0, slotsAvailable).map(q => ({
            address: q.candidate.address,
            label: `discovered-${q.candidate.address.slice(0, 6)}`,
            score: Math.min(100, Math.round(q.winRate * 0.6 + Math.min(40, q.totalTrades * 2))),
            winRate: q.winRate,
            tradeCount30d: q.totalTrades,
            roi30d: 0,
            lastActive: q.candidate.lastSeen,
            addedAt: now,
            source: 'discovery' as const,
        }));
    }

    /**
     * Get trending Solana token mints from DexScreener.
     */
    private async getTrendingMints(): Promise<string[]> {
        try {
            // DexScreener token boosted endpoint — shows tokens with most engagement
            const url = 'https://api.dexscreener.com/token-boosts/top/v1';
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                console.warn(`[WalletDiscovery] DexScreener trending HTTP ${res.status}`);
                return [];
            }

            const data = await res.json() as Array<{
                tokenAddress: string;
                chainId: string;
                amount: number;
            }>;

            if (!Array.isArray(data)) return [];

            const mints = data
                .filter(t => t.chainId === 'solana')
                .slice(0, 10)
                .map(t => t.tokenAddress);

            return mints;
        } catch (err) {
            console.warn(`[WalletDiscovery] DexScreener error: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    /**
     * Find wallets that bought a token early using Helius enhanced transactions.
     * Looks for wallets that swapped into the token and estimates profit.
     *
     * NOTE: Fetches ALL transaction types (not just SWAP) to capture Jupiter
     * aggregator routes that Helius may classify differently.
     */
    private async findEarlyBuyers(tokenMint: string): Promise<CandidateWallet[]> {
        if (!this.heliusKey) return [];

        try {
            // Fetch all types — Jupiter V6 swaps may not be classified as SWAP
            const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${this.heliusKey}&limit=50`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                console.warn(`[WalletDiscovery] Helius early buyers HTTP ${res.status} for ${tokenMint.slice(0, 8)}`);
                return [];
            }

            const txns = await res.json() as Array<{
                signature: string;
                timestamp: number;
                type: string;
                feePayer: string;
                events?: {
                    swap?: {
                        tokenInputs?: Array<{ mint: string; tokenAmount?: number }>;
                        tokenOutputs?: Array<{ mint: string; tokenAmount?: number }>;
                    };
                };
                tokenTransfers?: Array<{
                    mint: string;
                    fromUserAccount?: string;
                    toUserAccount?: string;
                    tokenAmount?: number;
                }>;
            }>;

            if (!Array.isArray(txns)) return [];

            const stablecoins = new Set([
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'So11111111111111111111111111111111111111112',    // SOL
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            ]);

            const walletStats = new Map<string, { buys: number; sells: number; lastSeen: number }>();

            for (const tx of txns) {
                let isBuy = false;
                let isSell = false;
                let wallet = tx.feePayer;

                // Method 1: events.swap
                if (tx.events?.swap) {
                    const swap = tx.events.swap;
                    const tokenIn = swap.tokenInputs?.[0];
                    const tokenOut = swap.tokenOutputs?.[0];
                    if (tokenIn && tokenOut) {
                        isBuy = stablecoins.has(tokenIn.mint) && tokenOut.mint === tokenMint;
                        isSell = tokenIn.mint === tokenMint && stablecoins.has(tokenOut.mint);
                    }
                }

                // Method 2: tokenTransfers fallback (Jupiter V6, Raydium, etc.)
                if (!isBuy && !isSell && tx.tokenTransfers && tx.tokenTransfers.length >= 2) {
                    for (const t of tx.tokenTransfers) {
                        if (t.fromUserAccount === wallet && stablecoins.has(t.mint)) {
                            // Wallet sent stablecoins — potential buy
                        }
                        if (t.toUserAccount === wallet && t.mint === tokenMint) {
                            isBuy = true;
                        }
                        if (t.fromUserAccount === wallet && t.mint === tokenMint) {
                            isSell = true;
                        }
                    }
                    // If both buy and sell in same tx, skip (it's a swap route)
                    if (isBuy && isSell) { isBuy = false; isSell = false; }
                }

                if (!isBuy && !isSell) continue;

                const stats = walletStats.get(wallet) ?? { buys: 0, sells: 0, lastSeen: 0 };
                if (isBuy) stats.buys++;
                if (isSell) stats.sells++;
                stats.lastSeen = Math.max(stats.lastSeen, tx.timestamp * 1000);
                walletStats.set(wallet, stats);
            }

            // Convert to candidates — wallets with activity
            const candidates: CandidateWallet[] = [];
            for (const [address, stats] of walletStats) {
                if (stats.buys === 0) continue;

                candidates.push({
                    address,
                    trades: stats.buys + stats.sells,
                    // Completed round trips (buy+sell) indicate profitable behavior
                    wins: Math.min(stats.sells, stats.buys),
                    totalPnlUsd: 0, // Can't determine from this data alone
                    avgHoldMinutes: 0,
                    lastSeen: stats.lastSeen,
                });
            }

            return candidates;
        } catch (err) {
            console.warn(`[WalletDiscovery] Error for ${tokenMint.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
}
