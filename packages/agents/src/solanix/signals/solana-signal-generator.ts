import type { SolanaSignal } from '../types';

// CoinGecko OHLC row: [timestamp, open, high, low, close]
type OhlcRow = [number, number, number, number, number];

// Maps ticker symbol -> CoinGecko coin ID
const GECKO_ID_MAP: Record<string, string> = {
    SOL: 'solana',
    JUP: 'jupiter-exchange-solana',
    BONK: 'bonk',
    WIF: 'dogwifcoin',
    PYTH: 'pyth-network',
    RNDR: 'render-token',
    RAY: 'raydium',
    ORCA: 'orca',
    JTO: 'jito-governance-token',
    W: 'wormhole',
    TENSOR: 'tensor',
    HNT: 'helium',
    MOBILE: 'helium-mobile',
    JITO: 'jito-governance-token',
    DRIFT: 'drift-protocol',
    POPCAT: 'popcat',
    MEW: 'cat-in-a-dogs-world',
    // Tokens discovered by watchlist curator
    LINK: 'chainlink',
    PENGU: 'pudgy-penguins',
    TRUMP: 'official-trump',
    VIRTUAL: 'virtual-protocol',
    RENDER: 'render-token',
    MSOL: 'msol',
    MNGO: 'mango-markets',
    GMT: 'stepn',
    PUMP: 'pump-fun',
};

// Maps ticker symbol -> Solana mint address
export const MINT_ADDRESS_MAP: Record<string, string> = {
    SOL: 'So11111111111111111111111111111111111111112',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    RNDR: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    W: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
    HNT: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
    DRIFT: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7',
    POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    MEW: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
};

interface SignalGeneratorConfig {
    /** Ticker symbols to watch (must have a GECKO_ID_MAP entry) */
    symbols: string[];
    /** Number of OHLC bars to fetch (informational; CoinGecko decides granularity) */
    bars_count?: number;
    /** Minimum absolute score to emit a signal (default 0.1) */
    min_signal_score?: number;
}

// ============================================================================
// Lightweight TA helpers (work on any candle count >= 14)
// ============================================================================

function calcRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
    const recent = changes.slice(-period);
    const gains = recent.filter((c) => c > 0);
    const losses = recent.filter((c) => c < 0).map(Math.abs);
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] ?? 0;
    const mult = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) ema = (data[i] - ema) * mult + ema;
    return ema;
}

function calcMACD(closes: number[]): { macd: number; signal: number } {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdVal = ema12 - ema26;

    // Build MACD history for signal line (9-period EMA of MACD)
    const macdHistory: number[] = [];
    const start = Math.max(26, closes.length - 40); // cap history for performance
    for (let i = start; i <= closes.length; i++) {
        const slice = closes.slice(0, i);
        if (slice.length < 26) continue;
        macdHistory.push(calcEMA(slice, 12) - calcEMA(slice, 26));
    }

    const signal = macdHistory.length >= 9 ? calcEMA(macdHistory, 9) : macdVal;
    return { macd: macdVal, signal };
}

function calcSMA(data: number[], period: number): number {
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcBollinger(
    closes: number[],
    period = 20,
    mult = 2,
): { upper: number; middle: number; lower: number } {
    const middle = calcSMA(closes, period);
    const slice = closes.slice(-period);
    const variance = slice.map((c) => Math.pow(c - middle, 2)).reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(variance);
    return { upper: middle + stdDev * mult, middle, lower: middle - stdDev * mult };
}

function detectTrend(closes: number[]): 'uptrend' | 'downtrend' | 'sideways' {
    if (closes.length < 20) return 'sideways';
    const sma20 = calcSMA(closes, 20);
    const sma10 = calcSMA(closes, Math.min(10, closes.length));
    const current = closes[closes.length - 1];
    let bull = 0;
    let bear = 0;
    if (current > sma20) bull++; else bear++;
    if (sma10 > sma20) bull++; else bear++;
    if (bull >= 2) return 'uptrend';
    if (bear >= 2) return 'downtrend';
    return 'sideways';
}

// ============================================================================
// SolanaSignalGenerator
// ============================================================================

export class SolanaSignalGenerator {
    private watchlist: Map<string, string>; // symbol -> mintAddress
    private minSignalScore: number;

    constructor(config: SignalGeneratorConfig) {
        this.minSignalScore = config.min_signal_score ?? 0.1;
        this.watchlist = new Map();
        for (const sym of config.symbols) {
            const mint = MINT_ADDRESS_MAP[sym] ?? '';
            this.watchlist.set(sym, mint);
        }
    }

    get watchlistSize(): number { return this.watchlist.size; }

    /** Add a symbol to the watchlist at runtime. */
    addSymbol(symbol: string, mintAddress: string): void {
        this.watchlist.set(symbol, mintAddress);
    }

    /** Remove a symbol from the watchlist. */
    removeSymbol(symbol: string): void {
        this.watchlist.delete(symbol);
    }

    /** Scan all watched symbols and return non-WAIT signals. */
    async scan(): Promise<SolanaSignal[]> {
        const results: SolanaSignal[] = [];

        for (const [symbol, mintAddress] of this.watchlist.entries()) {
            try {
                const signal = await this.analyzeSymbol(symbol, mintAddress);
                if (signal && signal.action !== 'WAIT') {
                    results.push(signal);
                }
                // Respect CoinGecko free-tier rate limit (30 req/min)
                await new Promise((r) => setTimeout(r, 2500));
            } catch {
                // Skip symbol on any error (network, parse, etc.)
            }
        }

        return results;
    }

    // --------------------------------------------------------------------------

    private async analyzeSymbol(symbol: string, mintAddress: string): Promise<SolanaSignal | null> {
        const geckoId = GECKO_ID_MAP[symbol];
        if (!geckoId) return null;

        const ohlc = await this.fetchOhlc(geckoId);
        if (!ohlc || ohlc.length < 14) return null;

        const closes = ohlc.map((row) => row[4]);
        const currentPrice = closes[closes.length - 1];

        // Compute indicators
        const rsi = calcRSI(closes);
        const { macd, signal: macdSignal } = calcMACD(closes);
        const bb = calcBollinger(closes);
        const trend = detectTrend(closes);

        // Score computation
        let score = 0;
        const reasoning: string[] = [];

        // RSI component (weight 0.35)
        if (rsi < 35) {
            score += 0.35;
            reasoning.push(`RSI oversold (${rsi.toFixed(1)})`);
        } else if (rsi < 45) {
            score += 0.15;
            reasoning.push(`RSI below neutral (${rsi.toFixed(1)})`);
        } else if (rsi > 65) {
            score -= 0.35;
            reasoning.push(`RSI overbought (${rsi.toFixed(1)})`);
        } else if (rsi > 55) {
            score -= 0.15;
            reasoning.push(`RSI above neutral (${rsi.toFixed(1)})`);
        }

        // MACD component (weight 0.30) — gradient based on histogram strength
        const histogram = macd - macdSignal;
        const normalizedMacd = Math.tanh((histogram / currentPrice) * 1000);
        const macdScore = 0.30 * normalizedMacd;
        score += macdScore;
        if (normalizedMacd > 0.1) {
            reasoning.push(`MACD bullish (strength ${(normalizedMacd * 100).toFixed(0)}%)`);
        } else if (normalizedMacd < -0.1) {
            reasoning.push(`MACD bearish (strength ${(Math.abs(normalizedMacd) * 100).toFixed(0)}%)`);
        }

        // Bollinger Bands component (weight 0.20)
        if (currentPrice <= bb.lower) {
            score += 0.20;
            reasoning.push('Price below Bollinger lower band');
        } else if (currentPrice <= bb.lower * 1.02) {
            score += 0.10;
            reasoning.push('Price near Bollinger lower band');
        } else if (currentPrice >= bb.upper) {
            score -= 0.20;
            reasoning.push('Price above Bollinger upper band');
        } else if (currentPrice >= bb.upper * 0.98) {
            score -= 0.10;
            reasoning.push('Price near Bollinger upper band');
        }

        // Trend component (weight 0.15)
        if (trend === 'uptrend') {
            score += 0.15;
            reasoning.push('Uptrend detected');
        } else if (trend === 'downtrend') {
            score -= 0.15;
            reasoning.push('Downtrend detected');
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

        // Confidence: map absolute score (0..1) to percentage (0..100)
        const confidence = Math.min(100, Math.round(Math.abs(score) * 100));

        return {
            symbol,
            mintAddress,
            action,
            confidence,
            reasoning,
            currentPrice,
            source: 'ta',
            timestamp: Date.now(),
        };
    }

    /** Fetch OHLC data from CoinGecko free API (no key required). */
    private async fetchOhlc(geckoId: string): Promise<OhlcRow[] | null> {
        const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/ohlc?vs_currency=usd&days=7`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as OhlcRow[];
        return data;
    }
}
