/**
 * WalletProfiler — deep-verifies a candidate wallet's historical performance.
 *
 * Instead of just counting buy/sell on one token, this profiles the wallet's
 * ENTIRE recent swap history across all tokens to calculate:
 *   - Win rate (completed round-trip trades)
 *   - Estimated PnL (using DexScreener prices at time of analysis)
 *   - Trade frequency and recency
 *   - Average hold time
 *
 * Uses: Helius Enhanced API (wallet history) + DexScreener (price enrichment)
 */

export interface WalletProfile {
    address: string;
    totalTrades: number;       // completed round trips
    wins: number;              // trades with positive PnL
    losses: number;            // trades with negative PnL
    winRate: number;           // 0-100%
    estimatedPnlUsd: number;   // total estimated PnL across all tokens
    avgHoldMinutes: number;    // average time between buy and sell
    uniqueTokens: number;      // number of different tokens traded
    lastActiveTs: number;      // timestamp of most recent swap
    tradeFrequencyPerDay: number; // trades per day over analyzed period
    isQualified: boolean;      // meets minimum quality bar
    reasons: string[];         // why qualified or not
}

interface TokenRoundTrip {
    tokenMint: string;
    buyTimestamp: number;
    sellTimestamp: number;
    buyAmountUsd: number;
    sellAmountUsd: number;
    pnlUsd: number;
    holdMinutes: number;
}

const STABLECOINS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'So11111111111111111111111111111111111111112',      // SOL (wrapped)
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
]);

export class WalletProfiler {
    private heliusKey: string;

    constructor(heliusKey: string) {
        this.heliusKey = heliusKey;
    }

    /**
     * Profile a wallet by analyzing its recent swap history.
     * Returns a detailed performance profile.
     *
     * Cost: 1 Helius API call + 1 DexScreener batch call
     */
    async profile(walletAddress: string): Promise<WalletProfile> {
        const label = walletAddress.slice(0, 8);
        const reasons: string[] = [];

        try {
            // Step 1: Fetch wallet's recent transactions (all types)
            const txns = await this.fetchWalletHistory(walletAddress);
            if (txns.length === 0) {
                return this.emptyProfile(walletAddress, ['No transaction history found']);
            }

            // Step 2: Extract all swaps (buy and sell events per token)
            const swapsByToken = this.extractSwaps(walletAddress, txns);

            if (swapsByToken.size === 0) {
                return this.emptyProfile(walletAddress, ['No swap activity detected']);
            }

            // Step 3: Match buy/sell pairs into round trips
            const roundTrips = this.matchRoundTrips(swapsByToken);

            // Step 4: Enrich with current prices from DexScreener for open positions
            const tokenMints = Array.from(swapsByToken.keys());
            const prices = await this.fetchCurrentPrices(tokenMints);

            // Step 5: Calculate performance metrics
            let wins = 0;
            let losses = 0;
            let totalPnl = 0;
            let totalHoldMinutes = 0;

            for (const rt of roundTrips) {
                if (rt.pnlUsd > 0) wins++;
                else losses++;
                totalPnl += rt.pnlUsd;
                totalHoldMinutes += rt.holdMinutes;
            }

            // Count open positions (bought but not sold) as neutral
            let openPositionCount = 0;
            for (const [mint, events] of swapsByToken) {
                const buys = events.filter(e => e.action === 'BUY').length;
                const sells = events.filter(e => e.action === 'SELL').length;
                if (buys > sells) openPositionCount += (buys - sells);
            }

            const totalTrades = roundTrips.length;
            const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
            const avgHold = totalTrades > 0 ? totalHoldMinutes / totalTrades : 0;

            // Calculate trade frequency
            const timestamps = txns.map(t => t.timestamp * 1000);
            const spanMs = Math.max(1, timestamps[0] - timestamps[timestamps.length - 1]);
            const spanDays = Math.max(1, spanMs / 86_400_000);
            const tradeFreq = totalTrades / spanDays;

            const lastActiveTs = timestamps[0] ?? 0;

            // Qualification criteria
            if (totalTrades < 3) reasons.push(`Too few completed trades: ${totalTrades} (min 3)`);
            if (winRate < 50) reasons.push(`Low win rate: ${winRate.toFixed(0)}% (min 50%)`);
            if (totalPnl <= 0) reasons.push(`Negative PnL: $${totalPnl.toFixed(0)}`);
            if (Date.now() - lastActiveTs > 7 * 86_400_000) reasons.push('Inactive >7 days');

            const isQualified = totalTrades >= 3 && winRate >= 50 && totalPnl > 0 &&
                Date.now() - lastActiveTs <= 7 * 86_400_000;

            if (isQualified) {
                reasons.push(`${wins}W/${losses}L (${winRate.toFixed(0)}% WR), PnL ~$${totalPnl.toFixed(0)}, ${swapsByToken.size} tokens`);
            }

            console.log(`[WalletProfiler] ${label}... ${totalTrades} trades, ${winRate.toFixed(0)}% WR, ~$${totalPnl.toFixed(0)} PnL, ${swapsByToken.size} tokens${isQualified ? ' ✓' : ' ✗'}`);

            return {
                address: walletAddress,
                totalTrades,
                wins,
                losses,
                winRate,
                estimatedPnlUsd: totalPnl,
                avgHoldMinutes: avgHold,
                uniqueTokens: swapsByToken.size,
                lastActiveTs,
                tradeFrequencyPerDay: tradeFreq,
                isQualified,
                reasons,
            };
        } catch (err) {
            console.warn(`[WalletProfiler] ${label}... error: ${err instanceof Error ? err.message : String(err)}`);
            return this.emptyProfile(walletAddress, [`Profile error: ${err instanceof Error ? err.message : String(err)}`]);
        }
    }

    /**
     * Fetch wallet's recent transaction history from Helius.
     */
    private async fetchWalletHistory(walletAddress: string): Promise<HeliusTx[]> {
        const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${this.heliusKey}&limit=100`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

        if (!res.ok) {
            if (res.status === 429) throw new Error('Helius rate limited');
            throw new Error(`Helius HTTP ${res.status}`);
        }

        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    /**
     * Extract swap events grouped by token mint.
     */
    private extractSwaps(walletAddress: string, txns: HeliusTx[]): Map<string, SwapEvent[]> {
        const byToken = new Map<string, SwapEvent[]>();
        const walletLower = walletAddress.toLowerCase();

        for (const tx of txns) {
            let action: 'BUY' | 'SELL' | null = null;
            let tokenMint = '';
            let amountUsd = 0;

            // Method 1: events.swap
            if (tx.events?.swap) {
                const swap = tx.events.swap;
                const tokenIn = swap.tokenInputs?.[0];
                const tokenOut = swap.tokenOutputs?.[0];

                if (tokenIn && tokenOut) {
                    if (STABLECOINS.has(tokenIn.mint) && !STABLECOINS.has(tokenOut.mint)) {
                        action = 'BUY';
                        tokenMint = tokenOut.mint;
                        amountUsd = tokenIn.tokenAmount ?? 0;
                    } else if (!STABLECOINS.has(tokenIn.mint) && STABLECOINS.has(tokenOut.mint)) {
                        action = 'SELL';
                        tokenMint = tokenIn.mint;
                        amountUsd = tokenOut.tokenAmount ?? 0;
                    }
                }
            }

            // Method 2: tokenTransfers fallback
            if (!action && tx.tokenTransfers && tx.tokenTransfers.length >= 2) {
                let sentStable = false;
                let receivedToken = '';
                let sentToken = '';
                let receivedStable = false;
                let stableAmount = 0;

                for (const t of tx.tokenTransfers) {
                    const from = t.fromUserAccount?.toLowerCase() === walletLower;
                    const to = t.toUserAccount?.toLowerCase() === walletLower;

                    if (from && STABLECOINS.has(t.mint)) {
                        sentStable = true;
                        stableAmount = t.tokenAmount ?? 0;
                    }
                    if (to && !STABLECOINS.has(t.mint)) receivedToken = t.mint;
                    if (from && !STABLECOINS.has(t.mint)) sentToken = t.mint;
                    if (to && STABLECOINS.has(t.mint)) {
                        receivedStable = true;
                        stableAmount = t.tokenAmount ?? 0;
                    }
                }

                if (sentStable && receivedToken) {
                    action = 'BUY'; tokenMint = receivedToken; amountUsd = stableAmount;
                } else if (sentToken && receivedStable) {
                    action = 'SELL'; tokenMint = sentToken; amountUsd = stableAmount;
                }
            }

            if (!action || !tokenMint) continue;

            const events = byToken.get(tokenMint) ?? [];
            events.push({
                action,
                tokenMint,
                amountUsd,
                timestamp: tx.timestamp * 1000,
                signature: tx.signature,
            });
            byToken.set(tokenMint, events);
        }

        return byToken;
    }

    /**
     * Match buy/sell pairs into completed round trips.
     * Uses FIFO matching: earliest buy matched with earliest sell.
     */
    private matchRoundTrips(swapsByToken: Map<string, SwapEvent[]>): TokenRoundTrip[] {
        const roundTrips: TokenRoundTrip[] = [];

        for (const [mint, events] of swapsByToken) {
            // Sort chronologically (oldest first)
            const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
            const buys = sorted.filter(e => e.action === 'BUY');
            const sells = sorted.filter(e => e.action === 'SELL');

            // FIFO matching
            const matchCount = Math.min(buys.length, sells.length);
            for (let i = 0; i < matchCount; i++) {
                const buy = buys[i];
                const sell = sells[i];

                // Only match if sell is after buy
                if (sell.timestamp <= buy.timestamp) continue;

                const pnl = sell.amountUsd - buy.amountUsd;
                const holdMs = sell.timestamp - buy.timestamp;

                roundTrips.push({
                    tokenMint: mint,
                    buyTimestamp: buy.timestamp,
                    sellTimestamp: sell.timestamp,
                    buyAmountUsd: buy.amountUsd,
                    sellAmountUsd: sell.amountUsd,
                    pnlUsd: pnl,
                    holdMinutes: holdMs / 60_000,
                });
            }
        }

        return roundTrips;
    }

    /**
     * Fetch current prices for a batch of token mints from DexScreener.
     */
    private async fetchCurrentPrices(tokenMints: string[]): Promise<Map<string, number>> {
        const prices = new Map<string, number>();
        if (tokenMints.length === 0) return prices;

        try {
            // DexScreener batch: max 30 addresses
            const batch = tokenMints.slice(0, 30).join(',');
            const url = `https://api.dexscreener.com/tokens/v1/solana/${batch}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return prices;

            const pairs = await res.json() as Array<{
                baseToken: { address: string };
                priceUsd: string;
                chainId: string;
                liquidity?: { usd: number };
            }>;

            if (!Array.isArray(pairs)) return prices;

            for (const pair of pairs) {
                if (pair.chainId !== 'solana') continue;
                const addr = pair.baseToken.address;
                const price = parseFloat(pair.priceUsd);
                if (price > 0) {
                    // Keep highest-liquidity pair
                    if (!prices.has(addr)) prices.set(addr, price);
                }
            }
        } catch { /* non-critical */ }

        return prices;
    }

    private emptyProfile(address: string, reasons: string[]): WalletProfile {
        return {
            address,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            estimatedPnlUsd: 0,
            avgHoldMinutes: 0,
            uniqueTokens: 0,
            lastActiveTs: 0,
            tradeFrequencyPerDay: 0,
            isQualified: false,
            reasons,
        };
    }
}

// Types
interface HeliusTx {
    signature: string;
    timestamp: number;
    type: string;
    events?: {
        swap?: {
            tokenInputs?: Array<{ mint: string; tokenAmount?: number }>;
            tokenOutputs?: Array<{ mint: string; tokenAmount?: number }>;
        };
    };
    tokenTransfers?: Array<{
        mint: string;
        tokenAmount?: number;
        fromUserAccount?: string;
        toUserAccount?: string;
    }>;
}

interface SwapEvent {
    action: 'BUY' | 'SELL';
    tokenMint: string;
    amountUsd: number;
    timestamp: number;
    signature: string;
}
