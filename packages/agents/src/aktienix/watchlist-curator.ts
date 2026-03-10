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

        // Source 3: Macro signal tickers
        for (const t of this.getMacroTickers(activeMacroSignals)) {
            combined.add(t);
        }

        this.lastRefreshDate = today;
        return Array.from(combined);
    }
}
