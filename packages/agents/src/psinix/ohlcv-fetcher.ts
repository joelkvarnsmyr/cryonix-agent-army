/**
 * OHLCV Fetcher — Real Binance market data via ccxt (public API, no auth)
 *
 * Replaces synthetic random walk entropy and CoinGecko price fetching
 * with real OHLCV candle data from Binance.
 */

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export class OHLCVFetcher {
    private exchange: any = null;
    private cache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
    private cacheTtlMs: number;

    constructor(cacheTtlMs: number = 60_000) {
        this.cacheTtlMs = cacheTtlMs;
    }

    async initialize(): Promise<void> {
        const ccxt = await import('ccxt');
        const Binance = (ccxt as any).binance ?? (ccxt as any).default?.binance;
        if (!Binance) throw new Error('ccxt binance class not found');
        this.exchange = new Binance({ enableRateLimit: true });
    }

    /**
     * Get close prices for a symbol (for entropy calculation + price cache).
     */
    async getClosePrices(symbol: string, timeframe = '15m', limit = 50): Promise<number[]> {
        const candles = await this.getCandles(symbol, timeframe, limit);
        return candles.map(c => c.close);
    }

    /**
     * Fetch OHLCV candles with caching.
     */
    async getCandles(symbol: string, timeframe = '15m', limit = 50): Promise<Candle[]> {
        const cacheKey = `${symbol}:${timeframe}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
            return cached.candles;
        }

        if (!this.exchange) {
            throw new Error('OHLCVFetcher not initialized — call initialize() first');
        }

        const raw = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

        const candles: Candle[] = raw.map((c: any[]) => ({
            timestamp: c[0],
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5],
        }));

        this.cache.set(cacheKey, { candles, fetchedAt: Date.now() });
        return candles;
    }

    /**
     * Compute Average True Range from candles.
     */
    async getATR(symbol: string, period = 14): Promise<number> {
        const candles = await this.getCandles(symbol, '15m', period + 1);
        if (candles.length < 2) return 0;

        const trueRanges: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose),
            );
            trueRanges.push(tr);
        }

        if (trueRanges.length === 0) return 0;
        return trueRanges.reduce((sum, v) => sum + v, 0) / trueRanges.length;
    }

    /**
     * Get the latest close price for a symbol.
     */
    async getLastPrice(symbol: string): Promise<number | null> {
        try {
            const candles = await this.getCandles(symbol, '15m', 1);
            return candles.length > 0 ? candles[candles.length - 1].close : null;
        } catch {
            return null;
        }
    }
}
