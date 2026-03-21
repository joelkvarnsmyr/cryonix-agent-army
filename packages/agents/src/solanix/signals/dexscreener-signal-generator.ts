import type { SolanaSignal } from '../types';
import { MINT_ADDRESS_MAP } from './solana-signal-generator';

/**
 * DexScreener-based signal generator for Solanix.
 *
 * Replaces CoinGecko OHLC (7-day, 4h granularity) with DexScreener pair data
 * that includes real-time price changes (1h/6h/24h), volume, and transaction
 * counts. Much more responsive to intraday moves.
 *
 * Scoring model (v2 — h1-dominant, anti-FOMO):
 *   - Short-term momentum (h1 price change)      weight 0.40
 *   - Medium-term context (h6 price change)       weight 0.15
 *   - Volume surge (h1 vs avg hourly)             weight 0.20
 *   - Buy pressure (buy txns vs sell txns in h1)  weight 0.15
 *   - Trend alignment (h1 and h6 same direction)  weight 0.10
 */

interface DexPairData {
    chainId: string;
    baseToken: { symbol: string; address: string };
    priceUsd: string;
    priceChange?: { h1?: number; h6?: number; h24?: number };
    volume?: { h1?: number; h6?: number; h24?: number };
    txns?: {
        h1?: { buys: number; sells: number };
        h6?: { buys: number; sells: number };
    };
    liquidity?: { usd: number };
    fdv?: number;
}

interface DexTokensResponse {
    pairs?: DexPairData[] | null;
}

interface DexSignalConfig {
    symbols: string[];
    /** Minimum liquidity to consider a pair valid (default $25k) */
    min_liquidity_usd?: number;
    /** Minimum absolute score to emit a signal (default 0.15) */
    min_signal_score?: number;
}

export class DexScreenerSignalGenerator {
    private watchlist: Map<string, string>; // symbol -> mintAddress
    private minLiquidity: number;
    private minSignalScore: number;

    constructor(config: DexSignalConfig) {
        this.minLiquidity = config.min_liquidity_usd ?? 25_000;
        this.minSignalScore = config.min_signal_score ?? 0.15;
        this.watchlist = new Map();
        for (const sym of config.symbols) {
            const mint = MINT_ADDRESS_MAP[sym] ?? '';
            if (mint) this.watchlist.set(sym, mint);
        }
    }

    get watchlistSize(): number { return this.watchlist.size; }

    addSymbol(symbol: string, mintAddress: string): void {
        this.watchlist.set(symbol, mintAddress);
    }

    removeSymbol(symbol: string): void {
        this.watchlist.delete(symbol);
    }

    /**
     * Scan all watched symbols via DexScreener batch endpoint.
     * Returns non-WAIT signals sorted by confidence (highest first).
     */
    async scan(): Promise<SolanaSignal[]> {
        const results: SolanaSignal[] = [];
        const entries = Array.from(this.watchlist.entries());

        // Batch tokens (DexScreener allows up to 30 addresses per request)
        const batchSize = 30;
        for (let i = 0; i < entries.length; i += batchSize) {
            const batch = entries.slice(i, i + batchSize);
            const addresses = batch.map(([, mint]) => mint).join(',');

            try {
                const url = `https://api.dexscreener.com/tokens/v1/solana/${addresses}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
                if (!res.ok) continue;

                const pairs = (await res.json()) as DexPairData[];
                if (!Array.isArray(pairs)) continue;

                // Group pairs by base token address, pick highest-liquidity pair per token
                const bestPairs = this.pickBestPairs(pairs);

                for (const [symbol] of batch) {
                    const mint = this.watchlist.get(symbol);
                    if (!mint) continue;
                    const pair = bestPairs.get(mint.toLowerCase());
                    if (!pair) continue;

                    const signal = this.scorePair(symbol, mint, pair);
                    if (signal && signal.action !== 'WAIT') {
                        results.push(signal);
                    }
                }
            } catch {
                // Skip batch on network error
            }

            // Rate limit between batches
            if (i + batchSize < entries.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Sort by confidence descending
        results.sort((a, b) => b.confidence - a.confidence);
        return results;
    }

    // -------------------------------------------------------------------------

    private pickBestPairs(pairs: DexPairData[]): Map<string, DexPairData> {
        const best = new Map<string, DexPairData>();
        for (const pair of pairs) {
            if (pair.chainId !== 'solana') continue;
            const liq = pair.liquidity?.usd ?? 0;
            if (liq < this.minLiquidity) continue;

            const addr = pair.baseToken.address.toLowerCase();
            const existing = best.get(addr);
            if (!existing || (existing.liquidity?.usd ?? 0) < liq) {
                best.set(addr, pair);
            }
        }
        return best;
    }

    private scorePair(symbol: string, mintAddress: string, pair: DexPairData): SolanaSignal | null {
        const priceUsd = parseFloat(pair.priceUsd);
        if (!priceUsd || priceUsd <= 0) return null;

        const h1Change = pair.priceChange?.h1 ?? 0;
        const h6Change = pair.priceChange?.h6 ?? 0;
        const h24Change = pair.priceChange?.h24 ?? 0;
        const volH1 = pair.volume?.h1 ?? 0;
        const volH24 = pair.volume?.h24 ?? 0;
        const buysH1 = pair.txns?.h1?.buys ?? 0;
        const sellsH1 = pair.txns?.h1?.sells ?? 0;

        let score = 0;
        const reasoning: string[] = [];

        // -- Anti-FOMO filter: reject tokens already pumped too much --
        if (h1Change >= 10) {
            reasoning.push(`FOMO rejected: h1 +${h1Change.toFixed(1)}% (pump tail)`);
            return { symbol, mintAddress, action: 'WAIT', confidence: 0, reasoning, currentPrice: priceUsd, source: 'dexscreener', timestamp: Date.now() };
        }
        if (h6Change >= 15) {
            reasoning.push(`FOMO rejected: h6 +${h6Change.toFixed(1)}% (extended run)`);
            return { symbol, mintAddress, action: 'WAIT', confidence: 0, reasoning, currentPrice: priceUsd, source: 'dexscreener', timestamp: Date.now() };
        }

        // 1. Short-term momentum (weight 0.40 — primary entry signal)
        if (h1Change >= 3) {
            score += 0.40;
            reasoning.push(`h1 +${h1Change.toFixed(1)}% strong momentum`);
        } else if (h1Change >= 1.5) {
            score += 0.30;
            reasoning.push(`h1 +${h1Change.toFixed(1)}% momentum`);
        } else if (h1Change >= 0.5) {
            score += 0.15;
            reasoning.push(`h1 +${h1Change.toFixed(1)}% mild up`);
        } else if (h1Change <= -3) {
            score -= 0.30;
            reasoning.push(`h1 ${h1Change.toFixed(1)}% strong sell-off`);
        } else if (h1Change <= -1) {
            score -= 0.15;
            reasoning.push(`h1 ${h1Change.toFixed(1)}% declining`);
        }

        // 2. Medium-term context (weight 0.15 — confirmation, not driver)
        if (h6Change >= 3) {
            score += 0.15;
            reasoning.push(`h6 +${h6Change.toFixed(1)}% confirms uptrend`);
        } else if (h6Change >= 1) {
            score += 0.08;
            reasoning.push(`h6 +${h6Change.toFixed(1)}% rising`);
        } else if (h6Change <= -8 && h1Change > 2) {
            // Deep dip with strong 1h reversal — best dip-buy signal
            score += 0.35;
            reasoning.push(`DEEP DIP REVERSAL: h6 ${h6Change.toFixed(1)}% + h1 +${h1Change.toFixed(1)}% bounce`);
        } else if (h6Change <= -5 && h1Change > 1) {
            // Moderate dip with reversal confirmation
            score += 0.25;
            reasoning.push(`dip reversal: h6 ${h6Change.toFixed(1)}% + h1 +${h1Change.toFixed(1)}% bounce`);
        } else if (h6Change <= -5) {
            // Dip but no reversal — freefall, avoid
            score -= 0.15;
            reasoning.push(`h6 ${h6Change.toFixed(1)}% freefall (no h1 reversal)`);
        } else if (h6Change <= -2) {
            score -= 0.10;
            reasoning.push(`h6 ${h6Change.toFixed(1)}% declining`);
        }

        // 3. Volume surge (weight 0.20)
        const avgHourlyVol = volH24 / 24;
        if (avgHourlyVol > 0) {
            const volRatio = volH1 / avgHourlyVol;
            if (volRatio >= 3) {
                score += 0.20;
                reasoning.push(`volume surge ${volRatio.toFixed(1)}x avg`);
            } else if (volRatio >= 1.5) {
                score += 0.10;
                reasoning.push(`volume above avg (${volRatio.toFixed(1)}x)`);
            } else if (volRatio < 0.3) {
                score -= 0.05;
                reasoning.push('low volume');
            }
        }

        // 4. Buy pressure (weight 0.15)
        const totalTxns = buysH1 + sellsH1;
        const buyRatio = totalTxns > 0 ? buysH1 / totalTxns : 0.5;
        if (totalTxns >= 10) {
            if (buyRatio >= 0.65) {
                score += 0.15;
                reasoning.push(`strong buy pressure ${(buyRatio * 100).toFixed(0)}%`);
            } else if (buyRatio >= 0.55) {
                score += 0.08;
                reasoning.push(`buy bias ${(buyRatio * 100).toFixed(0)}%`);
            } else if (buyRatio <= 0.35) {
                score -= 0.10;
                reasoning.push(`sell pressure ${((1 - buyRatio) * 100).toFixed(0)}%`);
            } else if (buyRatio <= 0.45) {
                score -= 0.05;
                reasoning.push(`slight sell bias ${((1 - buyRatio) * 100).toFixed(0)}%`);
            }
        }

        // 5. Trend alignment (weight 0.10)
        if (h1Change > 1.0 && h6Change > 1.0) {
            score += 0.10;
            reasoning.push('trend alignment (h1+h6 bullish)');
        } else if (h1Change > 0.5 && h6Change < -2) {
            score += 0.08;
            reasoning.push('dip reversal alignment');
        } else if (h1Change < -0.5 && h6Change < -1) {
            score -= 0.10;
            reasoning.push('trend alignment (h1+h6 bearish)');
        }

        // Buy pressure gate — reject BUY when sellers dominate
        // Lowered threshold: 10 txns (was 20), 50% buy ratio (was 45%)
        if (totalTxns >= 10 && buyRatio < 0.50 && score > 0) {
            score = 0;
            reasoning.push(`buy pressure gate: ${(buyRatio * 100).toFixed(0)}% buy at ${totalTxns} txns — rejected`);
        }

        // Determine action
        let action: SolanaSignal['action'];
        if (score > this.minSignalScore) {
            action = 'BUY';
        } else if (score < -this.minSignalScore) {
            action = 'SELL';
        } else {
            action = 'WAIT';
        }

        const confidence = Math.min(100, Math.round(Math.abs(score) * 100));

        return {
            symbol,
            mintAddress,
            action,
            confidence,
            reasoning,
            currentPrice: priceUsd,
            source: 'dexscreener',
            timestamp: Date.now(),
        };
    }
}
