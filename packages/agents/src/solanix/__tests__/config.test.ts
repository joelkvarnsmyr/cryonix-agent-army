import { describe, it, expect } from 'vitest';
import { loadSolanixConfig, SOLANIX_DEFAULTS } from '../config';

describe('loadSolanixConfig', () => {
    it('returns defaults when file is missing', () => {
        const config = loadSolanixConfig('/nonexistent/path.toml');
        expect(config.broker.paper_trading).toBe(true);
        expect(config.watchlist.symbols).toContain('SOL');
        expect(config.risk.max_daily_loss_pct).toBe(0.05);
    });

    it('SOLANIX_DEFAULTS has all required sections', () => {
        expect(SOLANIX_DEFAULTS.broker).toBeDefined();
        expect(SOLANIX_DEFAULTS.watchlist).toBeDefined();
        expect(SOLANIX_DEFAULTS.capital).toBeDefined();
        expect(SOLANIX_DEFAULTS.limits).toBeDefined();
        expect(SOLANIX_DEFAULTS.risk).toBeDefined();
        expect(SOLANIX_DEFAULTS.exits).toBeDefined();
        expect(SOLANIX_DEFAULTS.timing).toBeDefined();
        expect(SOLANIX_DEFAULTS.signals).toBeDefined();
    });
});
