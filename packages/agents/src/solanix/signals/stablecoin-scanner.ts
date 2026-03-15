/**
 * Stablecoin Depeg Scanner
 *
 * Uses Jupiter v6 quote API to check USDC/USDT price ratio.
 * A spread > 0.2% triggers a depeg warning, which is used as a
 * market-stress indicator to reduce signal confidence across the board.
 */

export interface StablecoinStatus {
    usdcToUsdt: number;
    usdtToUsdc: number;
    spread: number;
    depeg: boolean;
    direction: 'usdc_cheap' | 'usdt_cheap' | 'normal';
    timestamp: number;
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmKfrLDd1c2LLGesQZhgRRSsDP3HCY6T1';

/** $1000 notional — both USDC and USDT have 6 decimals (1000 * 10^6) */
const NOTIONAL_AMOUNT = 1_000_000_000;

const DEPEG_THRESHOLD = 0.002; // 0.2%
const CACHE_TTL_MS = 60_000; // 60s

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';

interface JupiterQuoteResponse {
    outAmount: string;
}

export class StablecoinScanner {
    private cached: StablecoinStatus | null = null;
    private cacheTs = 0;

    /**
     * Fetch a Jupiter quote for a single direction.
     * Returns the effective rate (output / input in human-readable units).
     */
    private async fetchRate(inputMint: string, outputMint: string): Promise<number> {
        const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${NOTIONAL_AMOUNT}&slippageBps=50`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
            throw new Error(`Jupiter quote failed: ${res.status}`);
        }
        const data = (await res.json()) as JupiterQuoteResponse;
        // Both tokens have 6 decimals, so outAmount / NOTIONAL_AMOUNT = rate
        return parseInt(data.outAmount, 10) / NOTIONAL_AMOUNT;
    }

    /**
     * Scan USDC/USDT parity via Jupiter quotes.
     * Results are cached for 60s to avoid hammering the API.
     */
    async scan(): Promise<StablecoinStatus> {
        const now = Date.now();
        if (this.cached && now - this.cacheTs < CACHE_TTL_MS) {
            return this.cached;
        }

        try {
            const [usdcToUsdt, usdtToUsdc] = await Promise.all([
                this.fetchRate(USDC_MINT, USDT_MINT),
                this.fetchRate(USDT_MINT, USDC_MINT),
            ]);

            const spreadUsdc = Math.abs(1.0 - usdcToUsdt);
            const spreadUsdt = Math.abs(1.0 - usdtToUsdc);
            const spread = Math.max(spreadUsdc, spreadUsdt);

            let direction: StablecoinStatus['direction'] = 'normal';
            if (spread > DEPEG_THRESHOLD) {
                // If USDC buys more USDT than 1:1, USDC is "expensive" → USDT is cheap
                direction = usdcToUsdt > 1.0 ? 'usdt_cheap' : 'usdc_cheap';
            }

            const status: StablecoinStatus = {
                usdcToUsdt,
                usdtToUsdc,
                spread,
                depeg: spread > DEPEG_THRESHOLD,
                direction,
                timestamp: now,
            };

            this.cached = status;
            this.cacheTs = now;
            return status;
        } catch (err: any) {
            // On failure, return last cached value or a safe default
            if (this.cached) return this.cached;
            return {
                usdcToUsdt: 1.0,
                usdtToUsdc: 1.0,
                spread: 0,
                depeg: false,
                direction: 'normal',
                timestamp: now,
            };
        }
    }
}
