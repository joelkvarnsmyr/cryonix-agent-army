import type { MacroSignal } from './intelligence/news-scanner';

export class WatchlistCurator {
    private lastRefreshDate: string | null = null;

    constructor(
        private readonly alpaca: any | null,
        private readonly xaiApiKey: string | null,
        private readonly fallbackSymbols: string[],
    ) {}

    needsRefresh(): boolean {
        const today = new Date().toISOString().slice(0, 10);
        return this.lastRefreshDate !== today;
    }

    async curate(activeMacroSignals: MacroSignal[]): Promise<string[]> {
        const today = new Date().toISOString().slice(0, 10);
        this.lastRefreshDate = today;
        return this.fallbackSymbols;
    }
}
