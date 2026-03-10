import { OpenAI } from 'openai';
import type { MacroSignal } from './intelligence/news-scanner';

export class WatchlistCurator {
    private lastRefreshDate: string | null = null;

    constructor(
        private readonly alpaca: any | null, // raw Alpaca SDK instance (same type as AktienixAgent.alpacaInstance)
        private readonly xaiApiKey: string | null,
        private readonly fallbackSymbols: string[],
        private readonly logger?: { info: (msg: string) => void },
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
        // TODO: UTC date — for NYSE accuracy this should use America/New_York timezone
        const today = new Date().toISOString().slice(0, 10);
        const combined = new Set<string>(this.fallbackSymbols);

        // Source 1: Alpaca volume movers
        const alpacaMovers = await this.getAlpacaMovers();
        for (const t of alpacaMovers) combined.add(t);
        const alpacaCount = alpacaMovers.length;

        // Source 2: Grok thematic picks
        const grokPicks = await this.getGrokPicks();
        for (const t of grokPicks) combined.add(t);
        const grokCount = grokPicks.length;

        // Source 3: Macro signal tickers
        const macroTickers = this.getMacroTickers(activeMacroSignals);
        for (const t of macroTickers) combined.add(t);
        const macroCount = macroTickers.length;

        const result = Array.from(combined).slice(0, 60);
        this.logger?.info(
            `WatchlistCurator: ${combined.size} total symbols (fallback: ${this.fallbackSymbols.length}, movers: ${alpacaCount}, grok: ${grokCount}, macro: ${macroCount}) → capped at ${result.length}`
        );

        this.lastRefreshDate = today;
        return result;
    }
}
