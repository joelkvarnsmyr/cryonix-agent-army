/**
 * TradeAnalyst — AI post-trade analysis for every SELL trade.
 * Generates a structured verdict with market context from Redis,
 * stores it for dashboard consumption.
 */

import type { StatePublisher } from '../state-publisher';

export interface ExitTradeInput {
    symbol: string;
    side: 'SELL';
    qty: number;
    entryPrice: number;
    exitPrice: number;
    pnlPct: number;
    exitReason: string;
    holdingDays: number;
}

export class TradeAnalyst {
    private publisher: StatePublisher;

    constructor(publisher: StatePublisher) {
        this.publisher = publisher;
    }

    async analyzeExit(trade: ExitTradeInput): Promise<string> {
        // Gather context from Redis
        const [fgRaw, analystRaw, insiderRaw, earningsRaw] = await Promise.all([
            this.publisher.get('aktienix:feargreed').catch(() => null),
            this.publisher.get(`aktienix:analyst:${trade.symbol}`).catch(() => null),
            this.publisher.get(`aktienix:insider:${trade.symbol}`).catch(() => null),
            this.publisher.get(`aktienix:earnings:${trade.symbol}`).catch(() => null),
        ]);

        const fg = fgRaw ? JSON.parse(fgRaw) : null;
        const analyst = analystRaw ? JSON.parse(analystRaw) : null;
        const insider = insiderRaw ? JSON.parse(insiderRaw) : null;
        const earnings = earningsRaw ? JSON.parse(earningsRaw) : null;

        const analysis: string[] = [];
        analysis.push(`EXIT: ${trade.symbol} | ${trade.exitReason} | ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%`);
        analysis.push(`Entry: $${trade.entryPrice.toFixed(2)} → Exit: $${trade.exitPrice.toFixed(2)} | Held: ${trade.holdingDays}d`);

        // Verdict based on exit reason
        const reason = trade.exitReason.split(':')[0]; // strip detail suffix
        if (reason === 'stop_loss') {
            if (trade.pnlPct > -2) analysis.push('VERDICT: SL triggered early — consider if SL too tight');
            else analysis.push('VERDICT: SL worked as intended — loss contained');
        } else if (reason === 'take_profit') {
            analysis.push('VERDICT: TP hit — trade executed as planned');
        } else if (reason === 'trailing_stop') {
            analysis.push('VERDICT: Trailing locked in profits after run-up');
        } else if (reason === 'smart_rotation') {
            analysis.push('VERDICT: Rotated out for a higher-conviction signal');
        } else if (reason === 'macro_delta') {
            analysis.push('VERDICT: Macro sentiment shifted — protective exit');
        } else if (reason === 'eod_close') {
            analysis.push('VERDICT: End-of-day close — intraday position cleared');
        } else if (reason === 'untracked') {
            analysis.push('VERDICT: Untracked sell synced from Alpaca — review manually');
        } else {
            analysis.push(`VERDICT: Exit reason "${trade.exitReason}" — review manually`);
        }

        // Market context
        if (fg) analysis.push(`Market: F&G ${fg.score?.toFixed(0)} (${fg.rating})`);
        if (analyst) analysis.push(`Analysts: ${(analyst.bullishPct * 100).toFixed(0)}% bullish (n=${analyst.totalAnalysts})`);
        if (insider) analysis.push(`Insiders: ${insider.buys} buys, ${insider.sells} sells (30d)`);
        if (earnings) analysis.push(`Earnings: ${earnings.date} (${earnings.daysUntil}d away)`);

        const result = analysis.join('\n');

        // Store in Redis for dashboard (7 day TTL)
        try {
            await this.publisher.set(
                `aktienix:analysis:${trade.symbol}:${Date.now()}`,
                JSON.stringify({ analysis: result, trade, timestamp: Date.now() }),
                7 * 86400,
            );
        } catch { /* non-critical */ }

        console.log(`[TRADE ANALYSIS]\n${result}`);
        return result;
    }
}
