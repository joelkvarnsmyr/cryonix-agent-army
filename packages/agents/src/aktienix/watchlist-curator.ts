import { OpenAI } from 'openai';
import type { MacroSignal } from './intelligence/news-scanner';

export class WatchlistCurator {
    private lastRefreshDate: string | null = null;

    constructor(
        private readonly alpaca: any | null, // raw Alpaca SDK instance (same type as AktienixAgent.alpacaInstance)
        private readonly xaiApiKey: string | null,
        private readonly fallbackSymbols: string[],
    ) {}

    needsRefresh(): boolean {
        // TODO: UTC date — for NYSE accuracy this should use America/New_York timezone
        const today = new Date().toISOString().slice(0, 10);
        return this.lastRefreshDate !== today;
    }

    private async getAlpacaMovers(): Promise<string[]> {
        if (!this.alpaca) return [];
        try {
            const actives = await this.alpaca.data.getMostActiveStocks({ by: 'volume', top: 30 });
            return actives.map((s: { symbol: string }) => s.symbol);
        } catch {
            return [];
        }
    }

    private async getGrokPicks(): Promise<string[]> {
        if (!this.xaiApiKey) return [];
        try {
            const grok = new OpenAI({ apiKey: this.xaiApiKey, baseURL: 'https://api.x.ai/v1' });
            const date = new Date().toISOString().slice(0, 10);
            const response = await grok.chat.completions.create({
                model: 'grok-3-latest',
                messages: [
                    {
                        role: 'user',
                        content: `You are a US equity swing trading strategist. Today is ${date}.

Search X and financial news for the 20 most interesting US stocks to watch for swing trading TODAY. Focus on:
- High momentum AI/tech with strong recent moves or upcoming catalysts
- Biotech with FDA events, trial data, or earnings
- Stocks seeing unusual volume or short squeeze potential
- High-beta plays amplifying current market themes
- Turnaround stories in current news cycle

Return ONLY a JSON array, no other text:
[{"symbol": "TICKER", "reason": "...", "sector": "tech|health|finance|energy|consumer|other", "catalyst": "earnings|fda|momentum|squeeze|macro|other"}]

US stocks only. Max 20 entries.`,
                    },
                ],
                // @ts-expect-error xAI-specific search parameter
                search: { mode: 'on' },
            });

            const content = response.choices[0]?.message?.content ?? '';
            // Extract JSON array — handle markdown code blocks
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) return [];
            const picks = JSON.parse(jsonMatch[0]) as Array<{ symbol: string }>;
            return picks.map(p => p.symbol).filter(s => typeof s === 'string' && s.length > 0);
        } catch {
            return [];
        }
    }

    private getMacroTickers(signals: MacroSignal[]): string[] {
        const tickers = new Set<string>();
        for (const signal of signals) {
            for (const ticker of signal.tickers) {
                tickers.add(ticker);
            }
        }
        return Array.from(tickers);
    }

    async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
        const today = new Date().toISOString().slice(0, 10);
        const combined = new Set<string>(this.fallbackSymbols);

        // Source 1: Alpaca volume movers
        for (const t of await this.getAlpacaMovers()) combined.add(t);

        // Source 2: Grok thematic picks
        for (const t of await this.getGrokPicks()) combined.add(t);

        // Source 3: Macro signal tickers
        for (const t of this.getMacroTickers(activeMacroSignals)) combined.add(t);

        this.lastRefreshDate = today;
        return Array.from(combined).slice(0, 60);
    }
}
