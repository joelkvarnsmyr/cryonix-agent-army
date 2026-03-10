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

    async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
        // TODO: activeMacroSignals will be used in Task 2 to add macro tickers
        const today = new Date().toISOString().slice(0, 10);
        this.lastRefreshDate = today;
        return this.fallbackSymbols;
    }
}
