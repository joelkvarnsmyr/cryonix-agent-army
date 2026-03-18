/**
 * Post-Trade Analyzer (PTA) for Solanix
 *
 * Fetches live market data at exit time and produces a verdict:
 * was this a good exit, premature, late, or correct stop?
 *
 * Stored in solanix_trades.metadata JSONB for learning.
 */

export type PtaVerdict = 'good_exit' | 'premature_exit' | 'late_exit' | 'correct_stop' | 'rotation_out' | 'unknown';

export interface PostTradeAnalysis {
    // Market state at exit
    h1Change: number;
    h6Change: number;
    h24Change: number;
    volumeH1: number;
    volumeH24: number;
    volumeRatio: number;
    buyPressureH1: number;
    liquidityUsd: number;

    // Position context
    entryPrice: number;
    exitPrice: number;
    holdTimeMinutes: number;

    // Verdict
    exitReason: string;
    pnlPct: number;
    pnlDollar: number;
    verdict: PtaVerdict;
    lesson: string;
}

interface DexPairData {
    chainId: string;
    baseToken: { address: string };
    priceChange?: { h1?: number; h6?: number; h24?: number };
    volume?: { h1?: number; h24?: number };
    txns?: { h1?: { buys: number; sells: number } };
    liquidity?: { usd: number };
}

export class PostTradeAnalyzer {
    /**
     * Analyze a trade at exit time.
     * Fetches DexScreener data and computes a verdict.
     */
    async analyze(
        symbol: string,
        mintAddress: string,
        entryPrice: number,
        exitPrice: number,
        holdTimeMinutes: number,
        exitReason: string,
        pnlPct: number,
        pnlDollar: number,
    ): Promise<PostTradeAnalysis> {
        const market = await this.fetchMarketState(mintAddress);

        const verdict = this.computeVerdict(exitReason, pnlPct, market);
        const lesson = this.computeLesson(exitReason, pnlPct, market, verdict);

        return {
            h1Change: market.h1Change,
            h6Change: market.h6Change,
            h24Change: market.h24Change,
            volumeH1: market.volumeH1,
            volumeH24: market.volumeH24,
            volumeRatio: market.volumeRatio,
            buyPressureH1: market.buyPressureH1,
            liquidityUsd: market.liquidityUsd,
            entryPrice,
            exitPrice,
            holdTimeMinutes,
            exitReason,
            pnlPct,
            pnlDollar,
            verdict,
            lesson,
        };
    }

    private computeVerdict(
        exitReason: string,
        pnlPct: number,
        market: MarketState,
    ): PtaVerdict {
        const h1 = market.h1Change;
        const h6 = market.h6Change;

        switch (exitReason) {
            case 'stop_loss':
                // SL + market still dropping → correct decision
                return h1 <= -0.5 ? 'correct_stop' : 'late_exit';

            case 'trailing_stop':
                // Trailing + price rising → we cut a winner
                return h1 > 0.5 ? 'premature_exit' : 'good_exit';

            case 'take_profit':
                // TP + market still ripping → left money on table
                return h6 > 1.0 ? 'premature_exit' : 'good_exit';

            case 'stagnation':
                return 'good_exit'; // freeing capital from dead trade is always good

            case 'rotation':
                return 'rotation_out';

            default:
                return 'unknown';
        }
    }

    private computeLesson(
        exitReason: string,
        pnlPct: number,
        market: MarketState,
        verdict: PtaVerdict,
    ): string {
        const h1 = market.h1Change;
        const h6 = market.h6Change;
        const bp = market.buyPressureH1;
        const vol = market.volumeRatio;

        switch (verdict) {
            case 'correct_stop':
                return `SL saved us — h1 ${h1.toFixed(1)}% drop continues, ${(bp * 100).toFixed(0)}% buy pressure`;

            case 'late_exit':
                return `SL hit but h1 +${h1.toFixed(1)}% recovery — consider wider SL or re-entry logic`;

            case 'premature_exit':
                if (exitReason === 'trailing_stop') {
                    return `Trailing cut winner — h1 +${h1.toFixed(1)}% momentum continues, trailing too tight?`;
                }
                return `TP hit but h6 +${h6.toFixed(1)}% trend continues — TP too conservative?`;

            case 'good_exit':
                if (exitReason === 'trailing_stop') {
                    return `Trailing protected gains — h1 ${h1.toFixed(1)}% confirms pullback`;
                }
                if (exitReason === 'take_profit') {
                    return `TP captured the move — h6 ${h6.toFixed(1)}% trend fading`;
                }
                return `Exit freed dead capital (${pnlPct.toFixed(1)}% after stagnation)`;

            case 'rotation_out':
                return `Rotated out at ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% — ${vol.toFixed(1)}x vol, ${(bp * 100).toFixed(0)}% buy`;

            default:
                return `Exit at ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
        }
    }

    private async fetchMarketState(mintAddress: string): Promise<MarketState> {
        const defaults: MarketState = {
            h1Change: 0, h6Change: 0, h24Change: 0,
            volumeH1: 0, volumeH24: 0, volumeRatio: 0,
            buyPressureH1: 0.5, liquidityUsd: 0,
        };

        try {
            const res = await fetch(
                `https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`,
                { signal: AbortSignal.timeout(8_000) },
            );
            if (!res.ok) return defaults;

            const pairs = (await res.json()) as DexPairData[];
            if (!Array.isArray(pairs)) return defaults;

            // Pick highest-liquidity Solana pair
            const solanaPairs = pairs
                .filter(p => p.chainId === 'solana' && (p.liquidity?.usd ?? 0) > 1000)
                .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

            if (solanaPairs.length === 0) return defaults;
            const pair = solanaPairs[0];

            const volH1 = pair.volume?.h1 ?? 0;
            const volH24 = pair.volume?.h24 ?? 0;
            const buysH1 = pair.txns?.h1?.buys ?? 0;
            const sellsH1 = pair.txns?.h1?.sells ?? 0;
            const totalTxns = buysH1 + sellsH1;

            return {
                h1Change: pair.priceChange?.h1 ?? 0,
                h6Change: pair.priceChange?.h6 ?? 0,
                h24Change: pair.priceChange?.h24 ?? 0,
                volumeH1: volH1,
                volumeH24: volH24,
                volumeRatio: volH24 > 0 ? volH1 / (volH24 / 24) : 0,
                buyPressureH1: totalTxns > 0 ? buysH1 / totalTxns : 0.5,
                liquidityUsd: pair.liquidity?.usd ?? 0,
            };
        } catch {
            return defaults;
        }
    }
}

interface MarketState {
    h1Change: number;
    h6Change: number;
    h24Change: number;
    volumeH1: number;
    volumeH24: number;
    volumeRatio: number;
    buyPressureH1: number;
    liquidityUsd: number;
}
