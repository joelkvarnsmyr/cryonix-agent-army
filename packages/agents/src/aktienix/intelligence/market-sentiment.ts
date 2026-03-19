/**
 * MarketSentimentScanner — Alternative data overlays for Aktienix
 *
 * Three sources:
 *   1. CNN Fear & Greed Index (no auth, 30min poll)
 *   2. CBOE Put/Call Ratio    (no auth, daily poll)
 *   3. Finnhub Insider Trades (optional API key, 6h poll)
 *
 * All data cached in Redis. getConfidenceAdjustment() reads cache only.
 * Never blocks trading on failure — every fetch is wrapped in try/catch.
 */

import type { StatePublisher } from '../state-publisher';

export class MarketSentimentScanner {
    private publisher: StatePublisher;
    private finnhubKey: string | null;
    private lastFearGreedFetch = 0;
    private lastPutCallFetch = 0;
    private lastInsiderFetch = 0;

    constructor(publisher: StatePublisher, finnhubKey?: string) {
        this.publisher = publisher;
        this.finnhubKey = finnhubKey || null;
    }

    // ── CNN Fear & Greed Index ────────────────────────────────────────────────

    async fetchFearGreed(): Promise<void> {
        // Only fetch every 30min
        if (Date.now() - this.lastFearGreedFetch < 30 * 60 * 1000) return;
        try {
            const date = new Date().toISOString().split('T')[0];
            const res = await fetch(
                `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${date}`,
                {
                    signal: AbortSignal.timeout(5000),
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                },
            );
            if (!res.ok) return;
            const data = await res.json();
            const score = data?.fear_and_greed?.score ?? null;
            const rating = data?.fear_and_greed?.rating ?? null;
            // Extract sub-indicators (CNN includes Put/Call ratio!)
            const putCallScore = data?.put_call_options?.score ?? null;
            const putCallRatio = data?.put_call_options?.data?.[0]?.y ?? null;
            const vixScore = data?.market_volatility_vix?.score ?? null;
            const momentumScore = data?.market_momentum_sp500?.score ?? null;

            if (score != null) {
                await this.publisher.set(
                    'aktienix:feargreed',
                    JSON.stringify({
                        score, rating, putCallScore, putCallRatio,
                        vixScore, momentumScore, timestamp: Date.now(),
                    }),
                    3600,
                );
                console.log(`[SENTIMENT] Fear & Greed: ${score.toFixed(0)} (${rating}) | P/C: ${putCallRatio?.toFixed(2) ?? '?'} | VIX: ${vixScore?.toFixed(0) ?? '?'} | Momentum: ${momentumScore?.toFixed(0) ?? '?'}`);
            }
            this.lastFearGreedFetch = Date.now();
        } catch (err: any) {
            console.warn(`[SENTIMENT] Fear & Greed fetch failed: ${err.message}`);
        }
    }

    // ── Put/Call Ratio (extracted from CNN F&G data) ───────────────────────────
    // CBOE CSV archive stops at 2012 — not useful. CNN F&G includes live P/C ratio
    // as a sub-indicator, so we extract it during fetchFearGreed() and store separately.

    async fetchPutCallRatio(): Promise<void> {
        // P/C ratio is now extracted from CNN F&G data in fetchFearGreed()
        // This method reads it from the cached feargreed data and writes a dedicated key
        try {
            const raw = await this.publisher.get('aktienix:feargreed');
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.putCallRatio != null) {
                await this.publisher.set(
                    'aktienix:putcall',
                    JSON.stringify({ ratio: data.putCallRatio, score: data.putCallScore, timestamp: Date.now() }),
                    3600,
                );
            }
            this.lastPutCallFetch = Date.now();
        } catch (err: any) {
            console.warn(`[SENTIMENT] Put/Call extract failed: ${err.message}`);
        }
    }

    // ── Finnhub Insider Trading ───────────────────────────────────────────────

    async fetchInsiderActivity(symbols: string[]): Promise<void> {
        if (!this.finnhubKey) return;
        // Only fetch every 6h
        if (Date.now() - this.lastInsiderFetch < 6 * 60 * 60 * 1000) return;

        for (const symbol of symbols) {
            try {
                const res = await fetch(
                    `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${this.finnhubKey}`,
                    { signal: AbortSignal.timeout(5000) },
                );
                if (!res.ok) continue;
                const data = await res.json();
                const transactions = data?.data ?? [];

                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

                const recent = transactions.filter(
                    (t: any) => new Date(t.transactionDate) >= thirtyDaysAgo,
                );

                const buys = recent.filter(
                    (t: any) => t.transactionCode === 'P' || t.transactionCode === 'A',
                ).length;
                const sells = recent.filter(
                    (t: any) => t.transactionCode === 'S' || t.transactionCode === 'F',
                ).length;

                await this.publisher.set(
                    `aktienix:insider:${symbol}`,
                    JSON.stringify({
                        buys,
                        sells,
                        netBuys: buys - sells,
                        recentCount: recent.length,
                        timestamp: Date.now(),
                    }),
                    43200, // 12h TTL
                );

                // Rate limit: small delay between symbols
                await new Promise((r) => setTimeout(r, 200));
            } catch {
                /* skip single symbol failure */
            }
        }

        this.lastInsiderFetch = Date.now();
        console.log(`[SENTIMENT] Insider activity scanned for ${symbols.length} symbols`);
    }

    // ── Confidence Adjustment (read from cache) ──────────────────────────────

    async getConfidenceAdjustment(symbol: string): Promise<{
        adjustment: number;
        reasons: string[];
        fearGreed?: number;
        putCallRatio?: number;
        insiderNetBuys?: number;
    }> {
        let adjustment = 0;
        const reasons: string[] = [];
        let fearGreed: number | undefined;
        let putCallRatio: number | undefined;
        let insiderNetBuys: number | undefined;

        // 1. Fear & Greed
        try {
            const raw = await this.publisher.get('aktienix:feargreed');
            if (raw) {
                const data = JSON.parse(raw);
                fearGreed = data.score;
                if (data.score < 25) {
                    adjustment += 0.08;
                    reasons.push(`F&G extreme fear (${data.score.toFixed(0)}) → +8%`);
                } else if (data.score > 75) {
                    adjustment -= 0.08;
                    reasons.push(`F&G extreme greed (${data.score.toFixed(0)}) → -8%`);
                }
            }
        } catch {
            /* skip */
        }

        // 2. Put/Call Ratio
        try {
            const raw = await this.publisher.get('aktienix:putcall');
            if (raw) {
                const data = JSON.parse(raw);
                putCallRatio = data.ratio;
                if (data.ratio > 1.2) {
                    adjustment += 0.06;
                    reasons.push(`P/C high (${data.ratio.toFixed(2)}) → +6%`);
                } else if (data.ratio < 0.7) {
                    adjustment -= 0.06;
                    reasons.push(`P/C low (${data.ratio.toFixed(2)}) → -6%`);
                }
            }
        } catch {
            /* skip */
        }

        // 3. Insider Activity
        try {
            const raw = await this.publisher.get(`aktienix:insider:${symbol}`);
            if (raw) {
                const data = JSON.parse(raw);
                insiderNetBuys = data.netBuys;
                if (data.buys >= 2 && data.netBuys > 0) {
                    adjustment += 0.1;
                    reasons.push(`Insider cluster buy (${data.buys} buys in 30d) → +10%`);
                } else if (data.sells >= 3 && data.netBuys < 0) {
                    adjustment -= 0.05;
                    reasons.push(`Insider selling (${data.sells} sells in 30d) → -5%`);
                }
            }
        } catch {
            /* skip */
        }

        return { adjustment, reasons, fearGreed, putCallRatio, insiderNetBuys };
    }
}
