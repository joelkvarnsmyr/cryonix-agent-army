import type { TokenSafetyCheck, CopySignal } from './types';

/**
 * Risk Gate — validates tokens before allowing copy trades.
 * Anti-rug checks using DexScreener pair data.
 */
export class CopyRiskGate {
    private minTokenAgeHours: number;
    private minLiquidityUsd: number;
    private minHolders: number;
    private minLpBurntPct: number;
    private requireImmutableSupply: boolean;

    constructor(config: {
        min_token_age_hours: number;
        min_liquidity_usd: number;
        min_holders: number;
        min_lp_burnt_pct: number;
        require_immutable_supply: boolean;
    }) {
        this.minTokenAgeHours = config.min_token_age_hours;
        this.minLiquidityUsd = config.min_liquidity_usd;
        this.minHolders = config.min_holders;
        this.minLpBurntPct = config.min_lp_burnt_pct;
        this.requireImmutableSupply = config.require_immutable_supply;
    }

    /**
     * Run safety checks on a token before allowing a copy trade.
     * Returns a detailed safety report.
     */
    async checkToken(tokenMint: string): Promise<TokenSafetyCheck> {
        const reasons: string[] = [];
        let safe = true;

        try {
            const url = `https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                return { tokenMint, tokenSymbol: 'UNKNOWN', ageHours: 0, liquidityUsd: 0, holderCount: 0, lpBurntPct: 0, immutableSupply: false, safe: false, reasons: ['Failed to fetch token data'] };
            }

            const pairs = (await res.json()) as DexPairResponse[];
            if (!Array.isArray(pairs) || pairs.length === 0) {
                return { tokenMint, tokenSymbol: 'UNKNOWN', ageHours: 0, liquidityUsd: 0, holderCount: 0, lpBurntPct: 0, immutableSupply: false, safe: false, reasons: ['No pairs found on DexScreener'] };
            }

            // Pick highest-liquidity Solana pair
            const pair = pairs
                .filter(p => p.chainId === 'solana')
                .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

            if (!pair) {
                return { tokenMint, tokenSymbol: 'UNKNOWN', ageHours: 0, liquidityUsd: 0, holderCount: 0, lpBurntPct: 0, immutableSupply: false, safe: false, reasons: ['No Solana pairs found'] };
            }

            const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';
            const liquidityUsd = pair.liquidity?.usd ?? 0;
            const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;

            // Check token age
            if (ageHours < this.minTokenAgeHours) {
                safe = false;
                reasons.push(`Token too new: ${ageHours.toFixed(1)}h (min ${this.minTokenAgeHours}h)`);
            } else {
                reasons.push(`Age: ${ageHours.toFixed(0)}h OK`);
            }

            // Check liquidity
            if (liquidityUsd < this.minLiquidityUsd) {
                safe = false;
                reasons.push(`Low liquidity: $${liquidityUsd.toFixed(0)} (min $${this.minLiquidityUsd})`);
            } else {
                reasons.push(`Liquidity: $${liquidityUsd.toFixed(0)} OK`);
            }

            // Holder count (from DexScreener info if available, otherwise estimate from txns)
            const holderEstimate = this.estimateHolders(pair);
            if (holderEstimate < this.minHolders) {
                safe = false;
                reasons.push(`Low holders: ~${holderEstimate} (min ${this.minHolders})`);
            } else {
                reasons.push(`Holders: ~${holderEstimate} OK`);
            }

            // FDV/liquidity ratio — high ratio = potential rug
            const fdv = pair.fdv ?? 0;
            if (fdv > 0 && liquidityUsd > 0) {
                const ratio = fdv / liquidityUsd;
                if (ratio > 100) {
                    safe = false;
                    reasons.push(`FDV/Liq ratio suspicious: ${ratio.toFixed(0)}x`);
                }
            }

            return {
                tokenMint,
                tokenSymbol: symbol,
                ageHours,
                liquidityUsd,
                holderCount: holderEstimate,
                lpBurntPct: 0, // DexScreener doesn't expose this directly, Phase 2: use Solscan API
                immutableSupply: false, // Phase 2: check via Solana RPC
                safe,
                reasons,
            };
        } catch {
            return { tokenMint, tokenSymbol: 'UNKNOWN', ageHours: 0, liquidityUsd: 0, holderCount: 0, lpBurntPct: 0, immutableSupply: false, safe: false, reasons: ['Error during safety check'] };
        }
    }

    /**
     * Quick check: is this signal safe to copy?
     */
    async validateSignal(signal: CopySignal): Promise<{ allowed: boolean; reasons: string[] }> {
        const check = await this.checkToken(signal.tokenMint);
        return { allowed: check.safe, reasons: check.reasons };
    }

    /**
     * Estimate holder count from 24h transaction data.
     * Rough proxy: unique buy transactions in 24h ≈ active holders.
     */
    private estimateHolders(pair: DexPairResponse): number {
        const buys24h = pair.txns?.h24?.buys ?? 0;
        const sells24h = pair.txns?.h24?.sells ?? 0;
        // Rough estimate: unique buyers likely ~60-70% of total buy txns
        return Math.round((buys24h + sells24h) * 0.65);
    }
}

interface DexPairResponse {
    chainId: string;
    baseToken?: { symbol: string; address: string };
    liquidity?: { usd: number };
    fdv?: number;
    pairCreatedAt?: number;
    txns?: {
        h24?: { buys: number; sells: number };
    };
}
