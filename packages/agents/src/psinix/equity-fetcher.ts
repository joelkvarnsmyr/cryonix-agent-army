/**
 * EquityFetcher — Polls S&P 500, NASDAQ, DXY from Finnhub free API.
 * Writes to Redis for signal-collector consumption.
 *
 * Finnhub free: 60 calls/min. We make 3 calls every 5min = trivial.
 */

interface EquityQuote {
    symbol: string;
    price: number;
    change: number;
    changePct: number;
    prevClose: number;
    timestamp: number;
}

export class EquityFetcher {
    private redis: any;
    private finnhubKey: string | null;
    private interval: ReturnType<typeof setInterval> | null = null;
    private pollMs: number;

    private symbols = [
        { ticker: 'SPY', key: 'psinix:equity:spy', label: 'S&P 500' },
        { ticker: 'QQQ', key: 'psinix:equity:qqq', label: 'NASDAQ 100' },
        { ticker: 'UUP', key: 'psinix:equity:uup', label: 'DXY (USD bull)' },
    ];

    constructor(redis: any, finnhubKey?: string, pollMs: number = 300_000) {
        this.redis = redis;
        this.finnhubKey = finnhubKey || process.env.FINNHUB_API_KEY || null;
        this.pollMs = pollMs;
    }

    start(): void {
        if (!this.finnhubKey) {
            console.log('[equity] No FINNHUB_API_KEY — equity signals disabled');
            return;
        }
        this.fetchAll().catch(() => {});
        this.interval = setInterval(() => this.fetchAll().catch(() => {}), this.pollMs);
        console.log(`[equity] Polling SPY/QQQ/UUP every ${this.pollMs / 1000}s`);
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
    }

    private async fetchAll(): Promise<void> {
        for (const { ticker, key } of this.symbols) {
            try {
                const quote = await this.fetchQuote(ticker);
                if (!quote) continue;
                await this.redis.set(key, JSON.stringify(quote));
                await this.redis.expire(key, 600); // 10min TTL
            } catch {
                // Non-critical
            }
        }
    }

    private async fetchQuote(ticker: string): Promise<EquityQuote | null> {
        const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${this.finnhubKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;

        const data = (await res.json()) as Record<string, any>;
        if (!data.c || data.c === 0) return null;

        return {
            symbol: ticker,
            price: data.c,
            change: data.d ?? 0,
            changePct: data.dp ?? 0,
            prevClose: data.pc ?? data.c,
            timestamp: Date.now(),
        };
    }
}
