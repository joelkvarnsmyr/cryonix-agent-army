import type { TokenSafetyCheck, CopySignal } from './types';

/**
 * Risk Gate — validates tokens before allowing copy trades.
 *
 * Phase 1: DexScreener pair data (age, liquidity, holders, FDV)
 * Phase 2: Solana RPC on-chain checks (mint authority, freeze authority)
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

    async checkToken(tokenMint: string): Promise<TokenSafetyCheck> {
        const reasons: string[] = [];
        let safe = true;

        try {
            // ── DexScreener data ──
            const url = `https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                return this.failResult(tokenMint, ['Failed to fetch token data']);
            }

            const pairs = (await res.json()) as DexPairResponse[];
            if (!Array.isArray(pairs) || pairs.length === 0) {
                return this.failResult(tokenMint, ['No pairs found on DexScreener']);
            }

            const pair = pairs
                .filter(p => p.chainId === 'solana')
                .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

            if (!pair) {
                return this.failResult(tokenMint, ['No Solana pairs found']);
            }

            const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';
            const liquidityUsd = pair.liquidity?.usd ?? 0;
            const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;

            // Check token age
            if (this.minTokenAgeHours > 0 && ageHours < this.minTokenAgeHours) {
                safe = false;
                reasons.push(`Token too new: ${ageHours.toFixed(1)}h (min ${this.minTokenAgeHours}h)`);
            }

            // Check liquidity
            if (this.minLiquidityUsd > 0 && liquidityUsd < this.minLiquidityUsd) {
                safe = false;
                reasons.push(`Low liquidity: $${liquidityUsd.toFixed(0)} (min $${this.minLiquidityUsd})`);
            }

            // Holder count estimate
            const holderEstimate = this.estimateHolders(pair);
            if (this.minHolders > 0 && holderEstimate < this.minHolders) {
                safe = false;
                reasons.push(`Low holders: ~${holderEstimate} (min ${this.minHolders})`);
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

            // ── Phase 2: On-chain mint/freeze authority check ──
            const onChain = await this.checkMintAuthority(tokenMint);
            if (onChain.mintAuthorityActive) {
                reasons.push('WARN: Mint authority active (dev can inflate supply)');
                // Don't block — just warn. Many legit tokens have active mint.
            }
            if (onChain.freezeAuthorityActive) {
                safe = false;
                reasons.push('BLOCKED: Freeze authority active (dev can freeze your tokens)');
            }

            return {
                tokenMint,
                tokenSymbol: symbol,
                ageHours,
                liquidityUsd,
                holderCount: holderEstimate,
                lpBurntPct: 0,
                immutableSupply: !onChain.mintAuthorityActive,
                safe,
                reasons,
            };
        } catch {
            return this.failResult(tokenMint, ['Error during safety check']);
        }
    }

    async validateSignal(signal: CopySignal): Promise<{ allowed: boolean; reasons: string[] }> {
        const check = await this.checkToken(signal.tokenMint);
        return { allowed: check.safe, reasons: check.reasons };
    }

    // ── Phase 2: Solana RPC on-chain checks ──────────────────────────

    /**
     * Check if a token's mint or freeze authority is still active.
     * Uses Solana public RPC (free, no API key needed).
     *
     * If mint authority is active → dev can create infinite tokens (rug risk).
     * If freeze authority is active → dev can freeze your tokens (instant rug).
     */
    private async checkMintAuthority(tokenMint: string): Promise<{
        mintAuthorityActive: boolean;
        freezeAuthorityActive: boolean;
    }> {
        try {
            const rpcUrl = 'https://api.mainnet-beta.solana.com';
            const res = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getAccountInfo',
                    params: [
                        tokenMint,
                        { encoding: 'jsonParsed' },
                    ],
                }),
                signal: AbortSignal.timeout(5_000),
            });

            if (!res.ok) return { mintAuthorityActive: false, freezeAuthorityActive: false };

            const data = await res.json() as {
                result?: {
                    value?: {
                        data?: {
                            parsed?: {
                                info?: {
                                    mintAuthority?: string | null;
                                    freezeAuthority?: string | null;
                                };
                            };
                        };
                    };
                };
            };

            const info = data.result?.value?.data?.parsed?.info;
            if (!info) return { mintAuthorityActive: false, freezeAuthorityActive: false };

            return {
                mintAuthorityActive: !!info.mintAuthority && info.mintAuthority !== null,
                freezeAuthorityActive: !!info.freezeAuthority && info.freezeAuthority !== null,
            };
        } catch {
            // Non-critical — if RPC fails, don't block
            return { mintAuthorityActive: false, freezeAuthorityActive: false };
        }
    }

    private estimateHolders(pair: DexPairResponse): number {
        const buys24h = pair.txns?.h24?.buys ?? 0;
        const sells24h = pair.txns?.h24?.sells ?? 0;
        return Math.round((buys24h + sells24h) * 0.65);
    }

    private failResult(tokenMint: string, reasons: string[]): TokenSafetyCheck {
        return { tokenMint, tokenSymbol: 'UNKNOWN', ageHours: 0, liquidityUsd: 0, holderCount: 0, lpBurntPct: 0, immutableSupply: false, safe: false, reasons };
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
