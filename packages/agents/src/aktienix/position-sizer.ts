import type { AktienixTomlConfig } from './config';

type CapitalConfig = AktienixTomlConfig['capital'];

export class PositionSizer {
    /**
     * Calculate fractional share quantity for a market order.
     *
     * @param price         Current price of the asset
     * @param settledCash   Available settled cash in the account
     * @param config        Capital config section from aktienix.toml
     * @returns             Fractional share quantity, 0 if below min_order_value
     */
    static calc(price: number, settledCash: number, config: CapitalConfig): number {
        if (price <= 0) return 0;
        if (!isFinite(settledCash) || settledCash < 0) return 0;

        const maxDollar = Math.min(
            config.max_position_size_usd,
            settledCash * config.max_capital_per_trade_pct,
        );

        if (maxDollar < config.min_order_value) return 0;

        // Round to 6 decimal places (Alpaca supports fractional shares)
        return Math.round((maxDollar / price) * 1_000_000) / 1_000_000;
    }
}
